/**
 * dsh-push — the git command runner.
 *
 * WHY THIS IS A STANDALONE MODULE: every function here imports nothing from
 * DSH. The plugin's Host half uses it, and a throwaway script can import it
 * directly against a temporary repository — which is exactly how this file is
 * verified. No cordis, no services, no plugin context.
 *
 * THE THREE NON-OBVIOUS CHOICES IN THIS FILE:
 *
 *  1. `LC_ALL=C` + `GIT_OPTIONAL_LOCKS=0` on EVERY child. The first keeps
 *     stdout AND stderr in a stable, parseable language (the repository's own
 *     safety refusals are matched as text); the second stops a read-only
 *     status poll from taking write locks in a repository another process is
 *     using.
 *
 *  2. Credentials are injected per invocation via
 *     `http.extraheader=Authorization: Basic <token>` in the child ENVIRONMENT plus
 *     `-c credential.helper=` — never written to `.git/config`, never put in a
 *     shell, and never persisted anywhere. The extraheader works for
 *     github.com over https; the emptied helper list means git can NEVER fall
 *     back to an interactive prompt (which would hang a background server).
 *
 *  3. `GIT_TERMINAL_PROMPT=0` and a hard timeout on every spawn. A network
 *     operation on a broken egress must fail in seconds with git's own stderr,
 *     not wedge the plugin until the browser gives up.
 *
 * @module src/host/git.js
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, statSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Cap on a write command's merged stdout+stderr (CONTRACT §3). */
export const MAX_OUTPUT_CHARS = 20_000;
/** Cap on a diff / patch body (CONTRACT §3 `/local/diff`). */
export const MAX_PATCH_CHARS = 200_000;
/** Cap on the file list returned by /local/status (CONTRACT §3). */
export const MAX_STATUS_FILES = 2000;

/** Default per-command ceiling for local (non-network) git commands. */
const LOCAL_TIMEOUT_MS = 30_000;
/** Ceiling for commands that talk to a remote. Long, but finite. */
const NETWORK_TIMEOUT_MS = 180_000;

/**
 * A full or abbreviated commit object name.
 *
 * Used to tell "this push source is a commit" (which needs a destination
 * refspec) apart from "this push source is a branch or tag" (which git can
 * push on its own). An abbreviated sha is 4-40 hex characters; a branch or tag
 * that happens to be all hex and at least 4 characters long is ambiguous, but
 * git resolves that same ambiguity the same way, and the destination-branch
 * requirement only ever adds clarity there.
 */
const SHA_RE = /^[0-9a-f]{4,40}$/i;

/**
 * The plugin's own error type.
 *
 * `code` uses the CONTRACT §0 vocabulary so the route layer can forward it
 * unchanged; `output` carries git's raw stderr for GIT_FAILED, which is what
 * makes a TLS/proxy/credential failure diagnosable instead of a generic
 * "command failed".
 */
export class GitError extends Error {
  /**
   * @param {string} code one of GIT_MISSING, GIT_FAILED, NOT_A_REPO,
   *   BAD_REQUEST, CONFLICT.
   * @param {string} message human-readable Chinese message.
   * @param {{output?: string, args?: string[], cause?: unknown}} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GitError';
    this.code = code;
    /** git's raw stdout/stderr, when the failure came from git itself. */
    this.output = details.output ?? '';
    /** The argv that failed (never contains a token — see #redact). */
    this.args = details.args ?? [];
  }
}

/**
 * Redact an Authorization header value out of any text we may return.
 *
 * git can echo a failed request's headers in some transport errors, so the
 * runner scrubs its own output before a caller ever sees it. Callers pass the
 * account tokens they know about as `secrets` for exact removal.
 *
 * @param {string} text
 * @param {Iterable<string>} [secrets]
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('***');
  }
  return out
    // Mask any auth scheme: Bearer was the old (wrong) one, Basic is current,
    // and a future scheme must not silently escape redaction either.
    .replace(/(Authorization:\s*\S+\s+)\S+/gi, '$1***')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    // A PEM block is a credential. Keep the BEGIN/END markers (useful for
    // diagnosis) and mask everything between them.
    .replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g, '$1\n***\n$2');
}

/** Truncate to `max` characters; the caller decides whether to flag it. */
function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Resolve the git executable to spawn.
 *
 * A `gitPath` setting may name a full executable or the directory holding one
 * (`C:\Program Files\Git\bin`), because a user who needs a different git
 * normally has the binary in mind, not its exact filename. An empty setting
 * means "whatever PATH resolves".
 *
 * @param {string} [gitPath]
 * @returns {string} the command to spawn.
 */
export function resolveGitBinary(gitPath = '') {
  const configured = typeof gitPath === 'string' ? gitPath.trim() : '';
  if (configured === '') return 'git';
  let isDirectory = /[\\/]$/.test(configured);
  if (!isDirectory) {
    try {
      isDirectory = statSync(configured).isDirectory();
    } catch {
      // A path that does not exist yet is still spawned verbatim: git (or the
      // OS) produces the more useful ENOENT message for a typo.
      isDirectory = false;
    }
  }
  if (!isDirectory) return configured;
  return join(configured, process.platform === 'win32' ? 'git.exe' : 'git');
}

/**
 * Child environment for every git call.
 * @returns {NodeJS.ProcessEnv}
 */
function baseEnv() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    // A background server must never block on a credential prompt.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // A GUI askpass helper is the other way `git push` can try to ASK for a
    // credential — and in a headless host it either hangs or pops a window
    // nobody asked for. Blanking them makes the refusal immediate and lets the
    // error surface as a readable GIT_FAILED instead of a stuck request.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}

/**
 * The username git should use when it has to talk to github.com over https.
 *
 * WHY A CONSTANT AND NOT THE ACCOUNT LOGIN: `http.extraheader` supplies the
 * Authorization header, but git's transport ALSO runs its credential flow
 * before/around that header, and with no terminal (this plugin always runs
 * `GIT_TERMINAL_PROMPT=0`) that flow can only fail with
 * `fatal: could not read Username for 'https://github.com': terminal prompts
 * disabled`. Supplying a username removes that failure mode without putting
 * anything secret on the command line — GitHub ignores the https username when
 * an Authorization header is present, and `x-access-token` is the value GitHub
 * documents for exactly this shape.
 */
export const GITHUB_HTTPS_USERNAME = 'x-access-token';

/** Certificate failures, quoted from git's own transport messages. */
const TLS_FAILURE = /server certificate verification failed|SSL certificate problem|self[- ]signed certificate|certificate has expired|certificate verify failed/i;

/**
 * The per-invocation `-c` overrides that select a credential for a network
 * command, WITHOUT writing anything to disk.
 *
 * `credential.helper=` clears every configured helper for THIS command only,
 * so git cannot quietly use (or write) a stored credential; the extraheader is
 * then the only credential in play.
 *
 * `credential.username` is the second half of the fix described on
 * {@link GITHUB_HTTPS_USERNAME}: it answers the username half of the credential
 * flow from the command line (a public, non-secret literal) so git never has
 * to prompt. The PASSWORD half is deliberately NOT configured — the token
 * stays inside the Authorization header, never in argv and never in the
 * credential stack.
 *
 * The header uses HTTP BASIC, not Bearer: the git smart-HTTP endpoint rejects
 * Bearer with a 401 while the REST API accepts it. Getting this wrong made
 * every push fail with "could not read Password".
 *
 * @param {string|undefined} token the active account's token.
 * @param {{username?: string}} [options]
 * @returns {string[]} flattened `-c key=value` pairs.
 */
export function authEnv(token, options = {}) {
  const base = { GIT_TERMINAL_PROMPT: '0' };
  if (typeof token !== 'string' || token === '') return base;
  const username = typeof options.username === 'string' && options.username !== ''
    ? options.username
    : GITHUB_HTTPS_USERNAME;
  // HTTP Basic for the git transport: github.com rejects Bearer here even
  // though its REST API accepts it.
  const basic = Buffer.from(`${username}:${token}`, 'utf8').toString('base64');
  const pairs = [
    ['credential.helper', ''],
    ['credential.username', username],
    ['http.extraheader', `Authorization: Basic ${basic}`],
  ];
  // git >= 2.31 reads config from the environment. Passing it this way keeps
  // the credential OUT of argv: another local account can read a process
  // command line, but not its environment, and argv is what ends up in crash
  // dumps and audit logs.
  const env = { ...base };
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Whether a remote URL points at github.com.
 * @param {string} url
 * @returns {boolean}
 */
export function isGithubUrl(url) {
  return /^(?:https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(String(url ?? ''));
}

/**
 * Extract `{owner, repo}` from a GitHub https/ssh remote URL.
 *
 * Only used for display and for "open this repo's page" links; an unparseable
 * URL simply yields `null` rather than failing the whole status response.
 *
 * @param {string} url
 * @returns {{owner: string, repo: string}|null}
 */
export function parseGithubRemote(url) {
  const value = String(url ?? '').trim();
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Build the HTTPS push URL for a GitHub repository the clone has no remote for
 * (CONTRACT §3b `target`).
 *
 * The URL carries NO credential: the token travels only as the per-invocation
 * `http.extraheader` (see {@link authEnv}), so it can never be read back
 * from `.git/config`, from argv, or from git's own error output. The literal
 * `x-access-token` is a public, documented placeholder.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {string} `https://github.com/<owner>/<repo>.git`
 */
export function githubPushUrl(owner, repo) {
  const cleanOwner = String(owner ?? '').trim();
  const cleanRepo = String(repo ?? '').trim().replace(/\.git$/i, '');
  // The route layer already rejects empty values, but this function is exported
  // and `https://github.com//.git` is a URL nobody should ever be handed.
  if (cleanOwner === '' || cleanRepo === '') {
    throw new GitError('BAD_REQUEST', '推送目标必须是 owner/repo 两段，缺少 owner 或仓库名');
  }
  const safeOwner = encodeURIComponent(cleanOwner);
  const safeRepo = encodeURIComponent(cleanRepo);
  return `https://github.com/${safeOwner}/${safeRepo}.git`;
}

/**
 * Parse git's `## ...` branch header from `status --porcelain=v1 -z --branch`.
 *
 * Real shapes this must survive (all observed from git 2.54 on Windows):
 *   `## main...origin/main [ahead 2, behind 1]`
 *   `## main...origin/main [gone]`
 *   `## main`
 *   `## HEAD (no branch)`            → detached
 *   `## No commits yet on main`      → unborn branch
 *
 * @param {string} header the first NUL-delimited token, header included.
 * @returns {{branch: string|null, upstream: string|null, ahead: number,
 *   behind: number, detachedHead: boolean}}
 */
export function parseBranchHeader(header) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, detachedHead: false };
  const text = String(header ?? '').replace(/^##\s*/, '').trim();
  if (text === '') return result;
  if (/^HEAD\s*\(no branch\)$/i.test(text)) {
    result.detachedHead = true;
    return result;
  }
  const unborn = /^(?:No commits yet|Initial commit) on (.+)$/i.exec(text);
  if (unborn) {
    result.branch = unborn[1].trim();
    return result;
  }
  const [left, right] = text.split('...');
  result.branch = (left ?? '').trim() || null;
  if (right !== undefined) {
    const flags = /\[([^\]]*)\]\s*$/.exec(right);
    result.upstream = right.replace(/\s*\[[^\]]*\]\s*$/, '').trim() || null;
    if (flags) {
      const ahead = /ahead (\d+)/.exec(flags[1]);
      const behind = /behind (\d+)/.exec(flags[1]);
      result.ahead = ahead ? Number(ahead[1]) : 0;
      result.behind = behind ? Number(behind[1]) : 0;
    }
  }
  return result;
}

/** Two-letter porcelain codes that mean "this path has a merge conflict". */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all --branch`.
 *
 * -z framing is why renames work at all: a rename emits `R  <new>\0<old>\0`,
 * i.e. the ORIGINAL path is a bare extra token with no `XY` prefix, so the
 * parser consumes it explicitly instead of mistaking it for the next entry.
 *
 * @param {string} raw git's stdout (contains NUL bytes).
 * @returns {{header: object, files: object[], dirty: object}}
 */
export function parseStatusPorcelainZ(raw) {
  const tokens = String(raw ?? '').split('\0');
  let header = { branch: null, upstream: null, ahead: 0, behind: 0, detachedHead: false };
  const files = [];
  const dirty = { changed: 0, staged: 0, untracked: 0, conflicted: 0 };
  let index = 0;
  // The branch header is always the first record when --branch is passed.
  if (tokens.length > 0 && tokens[0].startsWith('##')) {
    header = parseBranchHeader(tokens[0]);
    index = 1;
  }
  for (; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry === '') continue;
    if (entry.startsWith('##')) {
      header = parseBranchHeader(entry);
      continue;
    }
    if (entry.length < 3) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    let path = entry.slice(3);
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    // Rename/copy: the source path is the NEXT NUL token (already unquoted
    // because -z disables core.quotePath escaping).
    if (indexStatus === 'R' || indexStatus === 'C') {
      const source = tokens[index + 1];
      if (source !== undefined && source !== '') index += 1;
    }
    const conflicted = CONFLICT_CODES.has(`${indexStatus}${worktreeStatus}`);
    const staged = !untracked && indexStatus !== ' ' && indexStatus !== '?';
    // Each path is counted EXACTLY ONCE, in the same bucket the UI groups it
    // into (conflict → untracked → staged → unstaged). Counting a fully staged
    // file in `changed` too made the panel report "未暂存 1" for a tree whose
    // unstaged group was empty, and the two numbers stopped adding up to the
    // row count. Per-file detail (the `files` entries below) still carries both
    // index and worktree codes, so "staged and edited again" stays visible.
    if (untracked) dirty.untracked += 1;
    else if (conflicted) dirty.conflicted += 1;
    else if (staged) dirty.staged += 1;
    else dirty.changed += 1;
    if (files.length < MAX_STATUS_FILES) {
      files.push({ path, index: indexStatus, worktree: worktreeStatus, staged, untracked, conflicted });
    }
  }
  return { header, files, dirty };
}

/**
 * Parse `git log --pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D`
 * rows. `\x1f` (unit separator) is used because a subject may contain any
 * printable character, including tabs and pipes.
 *
 * @param {string} raw
 * @returns {object[]} commits WITHOUT lanes.
 */
export function parseLogRows(raw) {
  const commits = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (line === '') continue;
    const fields = line.split('\x1f');
    if (fields.length < 8) continue;
    const [sha, shortSha, parents, author, authorEmail, date, subject, refs] = fields;
    commits.push({
      sha,
      shortSha,
      parents: parents.split(' ').filter(Boolean),
      author,
      authorEmail,
      date,
      subject,
      refs: refs.split(',').map((r) => r.trim()).filter(Boolean),
    });
  }
  return commits;
}

/**
 * Assign a graph lane to every commit in a `git log --topo-order` window.
 *
 * THE ALGORITHM (deterministic and stateless — same input, same lanes):
 * `lanes[i]` holds the commit sha lane `i` is currently waiting for. Walking
 * the topological (newest-first) order, each commit claims the lane already
 * waiting for it, or the first free lane. Its first parent inherits that lane;
 * each extra parent (a merge) claims another lane. Lanes that were waiting for
 * the same sha are closed when the commit arrives, and trailing free lanes are
 * trimmed so indices stay dense.
 *
 * WHY THE HOST DOES THIS: a client that computed lanes would have to re-derive
 * the same walk in a second place, and the sidebar draws a fixed 60-commit
 * window — the lanes are only stable relative to that window, which only the
 * Host knows.
 *
 * @param {object[]} commits topologically ordered, newest first.
 * @returns {object[]} the same commits with a numeric `lane`.
 */
export function assignLanes(commits) {
  /** @type {Array<string|null>} */
  const lanes = [];
  const out = [];
  const freeLane = () => {
    const free = lanes.indexOf(null);
    return free === -1 ? lanes.length : free;
  };
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) lane = freeLane();
    // This commit fulfils every lane that was waiting for it (a merge base can
    // be awaited by two lanes); only the owning lane continues from here.
    for (let at = 0; at < lanes.length; at += 1) {
      if (at !== lane && lanes[at] === commit.sha) lanes[at] = null;
    }
    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent ?? null;
    for (const parent of otherParents) {
      if (parent === undefined) continue;
      if (lanes.includes(parent)) continue;
      lanes[freeLane()] = parent;
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    out.push({ ...commit, lane });
  }
  return out;
}

/**
 * Parse `git remote -v` into one row per remote name.
 *
 * The real line shape is `origin\thttps://github.com/o/r.git (fetch)` — the
 * `(fetch)`/`(push)` marker is appended to the URL after a SPACE, not as a
 * third tab-separated column, so it must be stripped from the URL rather than
 * read as a separate field. Only the fetch row is kept (they are identical for
 * the remote's identity), matching the contract's one-row-per-remote shape.
 *
 * @param {string} stdout
 * @returns {{name: string, url: string}[]}
 */
export function parseRemotes(stdout) {
  const remotes = [];
  const seen = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const match = /^(\S+)\t(.+?)(?:\s+\((fetch|push)\))?\s*$/.exec(line);
    if (!match) continue;
    const name = match[1];
    const url = match[2].trim();
    if (name === '' || url === '' || seen.has(name)) continue;
    seen.add(name);
    remotes.push({ name, url });
  }
  return remotes;
}

/**
 * Parse `git show --numstat --format= -z` output.
 *
 * -z framing nests the rename pair: `0\t0\t\0<old>\0<new>\0`. A record whose
 * path column is empty therefore consumes the following two tokens.
 *
 * @param {string} raw
 * @returns {{path: string, additions: number, deletions: number}[]}
 */
export function parseNumstatZ(raw) {
  const tokens = String(raw ?? '').split('\0');
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record === '') continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) continue;
    let path = match[3];
    if (path === '') {
      const from = tokens[index + 1] ?? '';
      const to = tokens[index + 2] ?? '';
      index += 2;
      path = to !== '' ? to : from;
    }
    if (path === '') continue;
    files.push({
      path,
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

/**
 * A thin, reusable git runner bound to one `gitPath` setting.
 *
 * Instances are cheap and stateless; the plugin creates one per request-ish
 * (it reads the live settings) so a `gitPath` change takes effect without a
 * restart.
 */
export class GitRunner {
  /** @type {string} the binary this runner spawns. */
  #binary;
  /** @type {number} default local timeout. */
  #timeoutMs;

  /**
   * @param {{gitPath?: string, timeoutMs?: number}} [options]
   */
  constructor(options = {}) {
    this.#binary = resolveGitBinary(options.gitPath ?? '');
    this.#timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : LOCAL_TIMEOUT_MS;
  }

  /** The resolved git command (diagnostics only). */
  get binary() {
    return this.#binary;
  }

  /**
   * Spawn one git command.
   *
   * @param {string[]} args arguments AFTER the global options.
   * @param {object} [options]
   * @param {string} [options.cwd] working directory (must exist).
   * @param {number} [options.timeoutMs]
   * @param {string[]} [options.config] flattened `-c key=value` pairs.
   * @param {Record<string,string>} [options.env] extra environment entries.
   * @param {boolean} [options.allowFailure] resolve instead of throwing on a
   *   non-zero exit (the caller inspects `code`).
   * @param {Iterable<string>} [options.secrets] tokens to redact from output.
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async run(args, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const first = await this.#spawn(args, { ...options, cwd, timeoutMs });
    if (first.code === 0 || options.allowFailure) return first;
    // CVE-2022-24765: git refuses a repository owned by another user. The
    // refusal names the directory, so trusting exactly that directory for THIS
    // invocation (never `*`, never a config file) is the narrow answer.
    if (!/dubious ownership/i.test(first.stderr)) return first;
    const refused = /detected dubious ownership in repository at '([^']*)'/.exec(first.stderr)?.[1];
    const trusted = refused && refused !== '' ? [refused, cwd] : [cwd];
    const safeConfig = [...(options.config ?? [])];
    for (const dir of trusted) safeConfig.push('-c', `safe.directory=${dir}`);
    return await this.#spawn(args, { ...options, cwd, timeoutMs, config: safeConfig });
  }

  /**
   * Spawn-once primitive. Split from {@link run} so the safe.directory retry
   * re-spawns with the SAME framing and only an extra `-c`.
   *
   * TWO CAPTURE STRATEGIES. The normal one pipes stdout/stderr into listeners.
   * A sandboxed/restricted child-process environment can refuse to create those
   * pipes (`spawn EPERM`, which is what DSH's own Windows sandbox does to any
   * piped stdio); there the command is re-run with its streams redirected to
   * temp FILES and the files are read afterwards. That fallback is not just
   * test scaffolding: it is the difference between "this panel cannot show git
   * state at all" and "this panel works" on such a host. Output limits are
   * enforced by STATING the spool files, so the fallback cannot buffer more
   * than the pipe path would.
   * @private
   */
  #spawn(args, options) {
    return this.#spawnPiped(args, options).catch(async (error) => {
      if (error?.cause?.code !== 'EPERM' && error?.code !== 'EPERM') throw error;
      return await this.#spawnToFiles(args, options);
    });
  }

  /**
   * Assemble the argv: every global option that must precede the subcommand.
   * @private
   */
  #argv(args, options) {
    const cwd = options.cwd ?? process.cwd();
    return [
      '-C', cwd,
      '--no-pager',
      '-c', 'color.ui=false',
      // Chinese (and any non-ASCII) paths must come back as UTF-8, not as
      // `\u4e2d` escape sequences.
      '-c', 'core.quotePath=false',
      ...(process.platform === 'win32' ? ['--no-optional-locks'] : []),
      ...(options.config ?? []),
      ...args,
    ];
  }

  /**
   * The normal capture path: piped stdout/stderr.
   * @private
   */
  #spawnPiped(args, options) {
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const secrets = options.secrets ?? [];
    const argv = this.#argv(args, options);
    return new Promise((resolvePromise, reject) => {
      let child;
      try {
        child = spawn(this.#binary, argv, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...baseEnv(), ...(options.env ?? {}) },
        });
      } catch (error) {
        reject(new GitError('GIT_MISSING', `无法启动 git（${this.#binary}）：${error.message}`, { args: argv, cause: error }));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        finish(reject, new GitError(
          'GIT_FAILED',
          `git ${args[0] ?? ''} 超时（${timeoutMs}ms）已终止`,
          { output: redact(`${stdout}${stderr}`, secrets), args: argv },
        ));
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        const missing = error?.code === 'ENOENT';
        finish(reject, new GitError(
          missing ? 'GIT_MISSING' : 'GIT_FAILED',
          missing
            ? `找不到 git 可执行文件（${this.#binary}）。请安装 Git，或在插件设置里填写正确的「git 路径」。`
            : `无法运行 git（${this.#binary}）：${error.message}`,
          { args: argv, cause: error },
        ));
      });
      child.on('close', (code) => {
        finish(resolvePromise, {
          stdout: redact(stdout, secrets),
          stderr: redact(stderr, secrets),
          code: typeof code === 'number' ? code : 1,
        });
      });
    });
  }

  /**
   * The restricted-host capture path: redirect both streams to spool files.
   *
   * Spool files are opened with `0o600` and removed in a `finally`, so no git
   * output (which can name private repository paths) is left behind.
   * @private
   */
  async #spawnToFiles(args, options) {
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const secrets = options.secrets ?? [];
    const argv = this.#argv(args, options);
    const token = randomBytes(8).toString('hex');
    const outPath = join(tmpdir(), `dsh-push-${token}.out`);
    const errPath = join(tmpdir(), `dsh-push-${token}.err`);
    let outFd;
    let errFd;
    try {
      outFd = openSync(outPath, 'w', 0o600);
      errFd = openSync(errPath, 'w', 0o600);
    } catch (error) {
      if (outFd !== undefined) closeSync(outFd);
      throw new GitError('GIT_FAILED', `无法创建 git 输出临时文件：${error.message}`, { args: argv, cause: error });
    }
    try {
      const code = await new Promise((resolvePromise, reject) => {
        let child;
        try {
          child = spawn(this.#binary, argv, {
            cwd,
            windowsHide: true,
            stdio: ['ignore', outFd, errFd],
            env: { ...baseEnv(), ...(options.env ?? {}) },
          });
        } catch (error) {
          reject(new GitError('GIT_MISSING', `无法启动 git（${this.#binary}）：${error.message}`, { args: argv, cause: error }));
          return;
        }
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
          finish(reject, new GitError(
            'GIT_FAILED',
            `git ${args[0] ?? ''} 超时（${timeoutMs}ms）已终止`,
            { args: argv },
          ));
        }, timeoutMs);
        child.on('error', (error) => {
          const missing = error?.code === 'ENOENT';
          finish(reject, new GitError(
            missing ? 'GIT_MISSING' : 'GIT_FAILED',
            missing
              ? `找不到 git 可执行文件（${this.#binary}）。请安装 Git，或在插件设置里填写正确的「git 路径」。`
              : `无法运行 git（${this.#binary}）：${error.message}`,
            { args: argv, cause: error },
          ));
        });
        child.on('close', (exitCode) => {
          finish(resolvePromise, typeof exitCode === 'number' ? exitCode : 1);
        });
      });
      const stdout = await readFile(outPath, 'utf8').catch(() => '');
      const stderr = await readFile(errPath, 'utf8').catch(() => '');
      return { stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), code };
    } finally {
      try {
        closeSync(outFd);
      } catch {
        // already closed
      }
      try {
        closeSync(errFd);
      } catch {
        // already closed
      }
      await unlink(outPath).catch(() => {});
      await unlink(errPath).catch(() => {});
    }
  }

  /**
   * Run a command and reject with GIT_FAILED (carrying git's raw stderr) when
   * it exits non-zero.
   *
   * @param {string[]} args
   * @param {object} [options] see {@link run}; `label` names the operation in
   *   the Chinese error message.
   * @returns {Promise<string>} stdout.
   */
  async must(args, options = {}) {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      const output = `${result.stdout}${result.stderr}`.trim();
      throw new GitError(
        'GIT_FAILED',
        `git ${options.label ?? args[0] ?? ''} 失败：${output !== '' ? output : `退出码 ${result.code}`}`,
        { output, args },
      );
    }
    return result.stdout;
  }

  /**
   * `git --version`, or `null` when git cannot run at all.
   * @returns {Promise<string|null>} e.g. `2.54.0.windows.1`.
   */
  async version() {
    try {
      const out = await this.run(['--version'], { timeoutMs: 10_000, allowFailure: true });
      if (out.code !== 0) return null;
      return /git version (\S+)/.exec(out.stdout.trim())?.[1] ?? out.stdout.trim() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Whether this machine has a runnable git.
   * @returns {Promise<{available: boolean, version: string|null}>}
   */
  async probe() {
    const version = await this.version();
    return { available: version !== null, version };
  }

  /**
   * Resolve a directory's repository root, or `null` when it is not inside a
   * git work tree.
   *
   * @param {string} path absolute (or resolvable) directory.
   * @param {{timeoutMs?: number, secrets?: Iterable<string>}} [options]
   * @returns {Promise<{root: string, gitDir: string}|null>}
   */
  async resolveRoot(path, options = {}) {
    const cwd = resolve(String(path ?? ''));
    // A missing working directory makes Node report `spawn ENOENT`, which is
    // indistinguishable from a missing git binary. Checking the directory first
    // keeps the two failures apart: a bad path is NOT_A_REPO, a bad gitPath is
    // GIT_MISSING, and the user is told to fix the right one.
    if (!isDirectory(cwd)) return null;
    const top = await this.run(['rev-parse', '--show-toplevel'], {
      cwd,
      timeoutMs: options.timeoutMs ?? 10_000,
      allowFailure: true,
      secrets: options.secrets,
    });
    if (top.code !== 0) return null;
    const root = top.stdout.trim();
    if (root === '') return null;
    const dir = await this.run(['rev-parse', '--absolute-git-dir'], {
      cwd,
      timeoutMs: options.timeoutMs ?? 10_000,
      allowFailure: true,
      secrets: options.secrets,
    });
    const gitDir = dir.code === 0 ? dir.stdout.trim() : '';
    return {
      // git prints forward slashes even on Windows; `resolve` restores the
      // platform's own separators so the value matches the cwd the client
      // already holds.
      root: resolve(root),
      gitDir: gitDir !== '' ? resolve(gitDir) : '',
    };
  }

  /**
   * Assert `path` is a directory inside a git work tree.
   *
   * EVERY mutating command goes through this: the contract requires an
   * absolute path whose toplevel has been verified before git is allowed to
   * change anything.
   *
   * @param {string} path
   * @param {object} [options]
   * @returns {Promise<{root: string, gitDir: string}>}
   * @throws {GitError} BAD_REQUEST for a relative/empty path, NOT_A_REPO when
   *   the directory is not a repository.
   */
  async assertRepo(path, options = {}) {
    const raw = typeof path === 'string' ? path.trim() : '';
    if (raw === '') throw new GitError('BAD_REQUEST', '缺少仓库路径');
    if (!isAbsolute(raw)) {
      throw new GitError('BAD_REQUEST', `仓库路径必须是绝对路径：${raw}`);
    }
    const resolvedRoot = await this.resolveRoot(raw, options);
    if (!resolvedRoot) {
      throw new GitError('NOT_A_REPO', `${raw} 不是 Git 仓库（或不是仓库工作区内的目录）`);
    }
    return resolvedRoot;
  }

  /**
   * Read the full local status document of CONTRACT §3.
   *
   * @param {string} path
   * @param {{defaultRemote?: string, secrets?: Iterable<string>}} [options]
   * @returns {Promise<object>}
   */
  async status(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const secrets = options.secrets;
    const [statusOut, remoteOut, tagOut, branchOut, stashOut, headOut] = await Promise.all([
      this.must(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch'], {
        cwd: root.root, label: 'status', secrets,
      }),
      this.run(['remote', '-v'], { cwd: root.root, label: 'remote', allowFailure: true, secrets }),
      this.run(['tag', '--list'], { cwd: root.root, label: 'tag', allowFailure: true, secrets }),
      this.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
        cwd: root.root, label: 'for-each-ref', allowFailure: true, secrets,
      }),
      this.run(['stash', 'list', '--format=%gd%x09%s'], {
        cwd: root.root, label: 'stash', allowFailure: true, secrets,
      }),
      this.run(['log', '-1', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI'], {
        cwd: root.root, label: 'log', allowFailure: true, secrets,
      }),
    ]);

    const parsed = parseStatusPorcelainZ(statusOut);
    const remotes = parseRemotes(remoteOut.stdout);

    const githubRemote = pickGithubRemote(remotes, options.defaultRemote);

    const tags = tagOut.stdout.split('\n').map((t) => t.trim()).filter(Boolean);
    const branches = branchOut.stdout.split('\n').map((b) => b.trim()).filter(Boolean);
    const stashes = [];
    for (const line of stashOut.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const [ref, message] = line.split('\t');
      const index = Number(/stash@\{(\d+)\}/.exec(ref ?? '')?.[1]);
      stashes.push({ index: Number.isFinite(index) ? index : stashes.length, message: message ?? '' });
    }

    let head = null;
    if (headOut.code === 0 && headOut.stdout.trim() !== '') {
      const [sha, shortSha, subject, author, date] = headOut.stdout.split('\x1f');
      if (sha) head = { sha, shortSha, subject, author, date };
    }

    return {
      isRepo: true,
      root: root.root,
      gitDir: root.gitDir || null,
      branch: parsed.header.branch,
      detachedHead: parsed.header.detachedHead,
      upstream: parsed.header.upstream,
      ahead: parsed.header.ahead,
      behind: parsed.header.behind,
      remotes,
      githubRemote,
      head,
      dirty: parsed.dirty,
      files: parsed.files,
      tags,
      branches,
      stashes,
    };
  }

  /**
   * Read a window of commits with lanes computed (CONTRACT §3 `Commit`).
   *
   * `--topo-order` is what makes the lane walk meaningful: parents always
   * appear after their children, so no lane is ever assigned to a commit whose
   * history has already been drawn.
   *
   * @param {string} path
   * @param {{limit?: number, ref?: string, secrets?: Iterable<string>}} [options]
   * @returns {Promise<{commits: object[], hasMore: boolean}>}
   */
  async log(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const limit = clampInt(options.limit, 1, 500, 60);
    const ref = typeof options.ref === 'string' && options.ref.trim() !== '' ? options.ref.trim() : 'HEAD';
    const out = await this.run([
      'log',
      '--topo-order',
      '--date=iso-strict',
      `-n`, String(limit + 1),
      '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D',
      ref,
      '--',
    ], { cwd: root.root, label: 'log', allowFailure: true, secrets: options.secrets });

    // An unborn branch (`git log` on a repo with no commits) exits non-zero;
    // that is an empty history, not an error.
    if (out.code !== 0) return { commits: [], hasMore: false };
    const rows = parseLogRows(out.stdout);
    const hasMore = rows.length > limit;
    const window = hasMore ? rows.slice(0, limit) : rows;
    return { commits: assignLanes(window), hasMore };
  }

  /**
   * `git diff` for one file, truncated per CONTRACT §3.
   *
   * @param {string} path
   * @param {{file: string, staged?: boolean, secrets?: Iterable<string>}} options
   * @returns {Promise<{file: string, patch: string, truncated: boolean}>}
   */
  async diff(path, options) {
    const root = await this.assertRepo(path, options);
    const file = typeof options.file === 'string' ? options.file.trim() : '';
    if (file === '') throw new GitError('BAD_REQUEST', '缺少文件路径');
    const args = ['diff', '--no-color'];
    if (options.staged === true) args.push('--cached');
    args.push('--', file);
    const out = await this.run(args, { cwd: root.root, label: 'diff', allowFailure: true, secrets: options.secrets });
    const patch = out.stdout;
    if (out.code !== 0) {
      throw new GitError('GIT_FAILED', `git diff 失败：${`${out.stdout}${out.stderr}`.trim()}`, { output: out.stderr });
    }
    return {
      file,
      patch: truncate(patch, MAX_PATCH_CHARS),
      truncated: patch.length > MAX_PATCH_CHARS,
    };
  }

  /**
   * One commit in detail: metadata, per-file line counts and the patch.
   *
   * @param {string} path
   * @param {{sha: string, secrets?: Iterable<string>}} options
   * @returns {Promise<object>}
   */
  async commitDetail(path, options) {
    const root = await this.assertRepo(path, options);
    const sha = typeof options.sha === 'string' ? options.sha.trim() : '';
    if (sha === '') throw new GitError('BAD_REQUEST', '缺少提交 SHA');
    const meta = await this.run(['log', '-1', '--date=iso-strict', '--pretty=format:%H%x1f%s%x1f%b%x1f%an%x1f%aI', sha], {
      cwd: root.root, label: 'log', allowFailure: true, secrets: options.secrets,
    });
    if (meta.code !== 0) {
      throw new GitError('NOT_FOUND', `找不到提交 ${sha}`, { output: meta.stderr });
    }
    const [resolvedSha, subject, body, author, date] = meta.stdout.split('\x1f');
    // `-m --first-parent` matters for MERGE commits: plain `git show` prints no
    // diff at all for a merge, so a merge row in the graph would open an empty
    // detail panel. Diffing against the first parent is what the user expects
    // to see ("what did this merge bring into my branch"), and for an ordinary
    // commit the flags change nothing.
    const [numstat, patch] = await Promise.all([
      this.run(['show', '--numstat', '--format=', '-z', '-m', '--first-parent', sha], {
        cwd: root.root, label: 'show', allowFailure: true, secrets: options.secrets,
      }),
      this.run(['show', '--format=', '--patch', '--no-color', '-m', '--first-parent', sha], {
        cwd: root.root, label: 'show', allowFailure: true, secrets: options.secrets,
      }),
    ]);
    const patchText = patch.stdout;
    return {
      sha: resolvedSha ?? sha,
      subject: subject ?? '',
      body: (body ?? '').trim(),
      author: author ?? '',
      date: date ?? '',
      files: parseNumstatZ(numstat.stdout),
      patch: truncate(patchText, MAX_PATCH_CHARS),
    };
  }

  /**
   * The branch HEAD points at, or `null` for a detached HEAD.
   *
   * `symbolic-ref` also answers for an UNBORN branch (a repository whose first
   * commit has not been made yet), where `git status --branch` reports
   * "No commits yet on main" instead. The push-target picker needs that case:
   * the very first push of a new repository must still be remembered per
   * branch.
   *
   * @param {string} path
   * @param {{secrets?: Iterable<string>, root?: string}} [options] `root` skips
   *   the (three-spawn) repository probe when the caller already has it.
   * @returns {Promise<string|null>}
   */
  async currentBranch(path, options = {}) {
    const root = nonEmpty(options.root) ?? (await this.assertRepo(path, options)).root;
    const out = await this.run(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: root, label: 'symbolic-ref', allowFailure: true, secrets: options.secrets,
    });
    // A detached HEAD makes git exit 1 with no output.
    const branch = out.code === 0 ? out.stdout.trim() : '';
    return branch === '' ? null : branch;
  }

  /**
   * Read one file from the WORKING TREE as a unified diff against /dev/null.
   *
   * Used by the pre-push review for UNTRACKED files: such a file has no diff at
   * all, so `git diff` says nothing about it — yet "a file I just wrote and
   * never added" is exactly where a freshly pasted token lives. `--no-index`
   * makes git treat the file as all-new, which also gives the review real line
   * numbers to cite.
   *
   * `--no-index` exits 1 when the inputs differ (the normal case here), so a
   * non-zero exit is not an error; only unreadable output is.
   *
   * @param {string} path repository path.
   * @param {string} file repository-relative file path.
   * @param {number} maxBytes refusal threshold (the diff is clipped past it).
   * @param {{secrets?: Iterable<string>, root?: string}} [options]
   * @returns {Promise<{text: string, binary?: boolean}>}
   */
  async readWorkingFile(path, file, maxBytes, options = {}) {
    const root = nonEmpty(options.root) ?? (await this.assertRepo(path, options)).root;
    const rel = nonEmpty(file);
    if (!rel) throw new GitError('BAD_REQUEST', '缺少文件路径');
    const limit = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 200 * 1024;
    const diff = await this.run(['diff', '--no-color', '--no-index', '--', '/dev/null', rel], {
      cwd: root, label: 'diff', allowFailure: true, secrets: options.secrets,
    });
    const text = diff.stdout ?? '';
    if (text === '') return { text: '' };
    // git prints this instead of a patch for binary content.
    if (/Binary files .* differ/.test(text)) return { text: '', binary: true };
    return { text: text.slice(0, limit * 2) };
  }

  /**
   * `git remote -v` as an array, without the rest of the status document.
   * @param {string} path
   * @param {{secrets?: Iterable<string>}} [options]
   * @returns {Promise<{remotes: {name: string, url: string}[]}>}
   */
  async remotes(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const out = await this.run(['remote', '-v'], {
      cwd: root.root, label: 'remote', allowFailure: true, secrets: options.secrets,
    });
    return { remotes: parseRemotes(out.stdout) };
  }

  /* ---------------------------------------------------------------- */
  /* Mutating operations                                              */
  /* ---------------------------------------------------------------- */

  /**
   * `git init` in `path`, creating the directory when missing.
   *
   * @param {string} path
   * @param {{secrets?: Iterable<string>}} [options]
   * @returns {Promise<{root: string, gitDir: string, output: string}>}
   */
  async init(path, options = {}) {
    const raw = typeof path === 'string' ? path.trim() : '';
    if (raw === '') throw new GitError('BAD_REQUEST', '缺少仓库路径');
    if (!isAbsolute(raw)) throw new GitError('BAD_REQUEST', `仓库路径必须是绝对路径：${raw}`);
    const dir = resolve(raw);
    await mkdir(dir, { recursive: true });
    const out = await this.run(['init'], { cwd: dir, label: 'init', secrets: options.secrets });
    if (out.code !== 0) {
      throw new GitError('GIT_FAILED', `git init 失败：${`${out.stdout}${out.stderr}`.trim()}`, { output: out.stderr });
    }
    // Re-resolve AFTER init: the caller needs the verified toplevel, and a
    // directory inside an existing repository initialises nothing new.
    const root = await this.resolveRoot(dir, options);
    return {
      root: root?.root ?? dir,
      gitDir: root?.gitDir ?? '',
      output: merged(out),
    };
  }

  /**
   * Add or update a remote.
   * @param {string} path
   * @param {{name?: string, url: string, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string, remote: {name: string, url: string}}>}
   */
  async setRemote(path, options) {
    const root = await this.assertRepo(path, options);
    const name = nonEmpty(options.name) ?? 'origin';
    const url = nonEmpty(options.url);
    if (!url) throw new GitError('BAD_REQUEST', '缺少远端地址');
    // `git remote get-url` exits 0 only when the remote already exists, which
    // decides between "add" and "set-url" without parsing config.
    const exists = await this.run(['remote', 'get-url', name], {
      cwd: root.root, allowFailure: true, secrets: options.secrets,
    });
    const args = exists.code === 0 ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
    const out = await this.run(args, { cwd: root.root, label: 'remote', secrets: options.secrets });
    if (out.code !== 0) {
      throw new GitError('GIT_FAILED', `设置远端 ${name} 失败：${`${out.stdout}${out.stderr}`.trim()}`, { output: out.stderr });
    }
    return { output: merged(out), remote: { name, url } };
  }

  /**
   * `git add -A` (the init flow's "stage everything but do not commit").
   * @param {string} path
   * @param {{secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async stageAll(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const out = await this.run(['add', '-A'], { cwd: root.root, label: 'add', secrets: options.secrets });
    if (out.code !== 0) {
      throw new GitError('GIT_FAILED', `git add -A 失败：${`${out.stdout}${out.stderr}`.trim()}`, { output: out.stderr });
    }
    return { output: merged(out) };
  }

  /**
   * Fetch from a remote (with the active account's token when given).
   *
   * @param {string} path
   * @param {{remote?: string, prune?: boolean, token?: string, secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async fetch(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const remote = nonEmpty(options.remote) ?? 'origin';
    const args = ['fetch', remote];
    if (options.prune === true) args.push('--prune');
    return this.#network(root.root, args, 'fetch', options);
  }

  /**
   * Pull a remote branch.
   *
   * @param {string} path
   * @param {{remote?: string, branch?: string, rebase?: boolean, token?: string,
   *   secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async pull(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const remote = nonEmpty(options.remote) ?? 'origin';
    const branch = nonEmpty(options.branch);
    const args = ['pull'];
    if (options.rebase === true) args.push('--rebase');
    args.push(remote);
    if (branch) args.push(branch);
    return this.#network(root.root, args, 'pull', options);
  }

  /**
   * Push the current (or named) branch.
   *
   * TWO DESTINATION FORMS, and both are the SAME command here:
   *
   *  - `remote` names a configured remote (`origin`, `fork`, …).
   *  - `url` pushes to an ad-hoc URL (CONTRACT §3b: a `target` repository the
   *    local clone has no remote for). Passing the URL as the push destination
   *    is what keeps `.git/config` untouched.
   *
   * WHY `--set-upstream` IS NOT USED FOR A URL: `git push --set-upstream <url>`
   * would write a `branch.<name>.remote=<url>` entry into `.git/config`, i.e.
   * exactly the pollution the contract forbids. `--set-upstream` therefore only
   * applies to a named remote, where it is what the user asked for.
   *
   * @param {string} path
   * @param {{remote?: string, url?: string, branch?: string, force?: boolean,
   *   setUpstream?: boolean, tags?: boolean, token?: string, username?: string,
   *   secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async push(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const url = nonEmpty(options.url);
    const remote = nonEmpty(options.remote) ?? 'origin';
    // A URL and a named remote are mutually exclusive; the URL wins because it
    // is the more specific instruction (the caller built it from `target`).
    const destination = url ?? remote;
    const branch = nonEmpty(options.branch);
    // `source` is what actually leaves the local repository. It is a branch
    // name by default, but a user picking a specific version in the panel may
    // hand us a commit sha or a tag — git accepts all three as a push source
    // (`<src>:<dst>`), and pinning it explicitly is what makes "push this
    // exact version" possible without moving HEAD first.
    const source = nonEmpty(options.source) ?? branch;
    const args = ['push'];
    // `--force-with-lease` rather than `--force`: the user asked for force, but
    // refusing to clobber commits pushed by someone else is the behaviour that
    // does not silently destroy their work.
    if (options.force === true) args.push('--force-with-lease');
    if (url === undefined && options.setUpstream !== false && source === branch) args.push('--set-upstream');
    if (options.tags === true) args.push('--tags');
    args.push(destination);
    // An explicit refspec matters for URL pushes: the URL has no configured
    // merge ref, so pushing the named branch is the only way to be sure WHICH
    // local branch lands on the other side.
    if (source) {
      // A commit sha can NEVER be pushed without an explicit destination: git
      // rejects `git push origin <sha>` outright ("cannot push a commit
      // without a refspec"). Failing here, before the network handshake, says
      // what to do instead of spending 20 s to reach a remote that then
      // refuses. A branch or tag source is fine on its own.
      const destinationBranch = branch;
      if (destinationBranch) {
        args.push(`${source}:${destinationBranch}`);
      } else if (SHA_RE.test(source)) {
        throw new GitError(
          'BAD_REQUEST',
          `推送提交 ${source.slice(0, 8)} 必须同时指定目标分支（git 不接受没有 refspec 的提交推送）。`,
        );
      } else {
        args.push(source);
      }
    }
    return this.#network(root.root, args, 'push', options);
  }

  /**
   * Stage and commit.
   *
   * @param {string} path
   * @param {{message: string, all?: boolean, files?: string[],
   *   secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async commit(path, options) {
    const root = await this.assertRepo(path, options);
    const message = nonEmpty(options.message);
    if (!message) throw new GitError('BAD_REQUEST', '提交信息不能为空');
    const files = Array.isArray(options.files) ? options.files.filter((f) => typeof f === 'string' && f !== '') : [];
    const addArgs = options.all !== false && files.length === 0 ? ['add', '-A'] : ['add', '--', ...files];
    const add = await this.run(addArgs, { cwd: root.root, label: 'add', secrets: options.secrets });
    if (add.code !== 0) {
      throw new GitError('GIT_FAILED', `git add 失败：${`${add.stdout}${add.stderr}`.trim()}`, { output: add.stderr });
    }
    const out = await this.run(['commit', '-m', message], {
      cwd: root.root, label: 'commit', secrets: options.secrets,
    });
    if (out.code !== 0) {
      const raw = `${add.stdout}${add.stderr}${out.stdout}${out.stderr}`.trim();
      // "nothing to commit" is a user-facing state, not a broken repository.
      const nothing = /nothing to commit|no changes added to commit/i.test(raw);
      throw new GitError(
        nothing ? 'CONFLICT' : 'GIT_FAILED',
        nothing ? '没有可提交的改动' : `git commit 失败：${raw}`,
        { output: raw },
      );
    }
    return { output: merged(add) + merged(out) };
  }

  /**
   * Checkout a branch, tag or sha.
   *
   * @param {string} path
   * @param {{ref: string, create?: boolean, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async checkout(path, options) {
    const root = await this.assertRepo(path, options);
    const ref = nonEmpty(options.ref);
    if (!ref) throw new GitError('BAD_REQUEST', '缺少要切换的分支或提交');
    const args = ['checkout'];
    if (options.create === true) args.push('-b');
    args.push(ref);
    return this.#write(root.root, args, 'checkout', options);
  }

  /**
   * Create a branch, optionally checking it out.
   *
   * @param {string} path
   * @param {{name: string, from?: string, checkout?: boolean,
   *   secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async createBranch(path, options) {
    const root = await this.assertRepo(path, options);
    const name = nonEmpty(options.name);
    if (!name) throw new GitError('BAD_REQUEST', '分支名不能为空');
    const from = nonEmpty(options.from);
    const args = options.checkout === false
      ? ['branch', name, ...(from ? [from] : [])]
      : ['checkout', '-b', name, ...(from ? [from] : [])];
    return this.#write(root.root, args, 'branch', options);
  }

  /**
   * Delete a branch.
   * @param {string} path
   * @param {{name: string, force?: boolean, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async deleteBranch(path, options) {
    const root = await this.assertRepo(path, options);
    const name = nonEmpty(options.name);
    if (!name) throw new GitError('BAD_REQUEST', '分支名不能为空');
    return this.#write(root.root, ['branch', options.force === true ? '-D' : '-d', name], 'branch', options);
  }

  /**
   * Merge a ref into the current branch.
   * @param {string} path
   * @param {{ref: string, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async merge(path, options) {
    const root = await this.assertRepo(path, options);
    const ref = nonEmpty(options.ref);
    if (!ref) throw new GitError('BAD_REQUEST', '缺少要合并的分支或提交');
    return this.#write(root.root, ['merge', '--no-edit', ref], 'merge', options);
  }

  /**
   * Reset to a ref.
   *
   * `mode: 'hard'` discards uncommitted work, which is why the ROUTE layer
   * requires `confirm: true` before it calls this and why the message here says
   * plainly what happened.
   *
   * @param {string} path
   * @param {{ref?: string, mode?: 'soft'|'mixed'|'hard',
   *   secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async reset(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const ref = nonEmpty(options.ref) ?? 'HEAD';
    const mode = options.mode === 'soft' || options.mode === 'hard' ? options.mode : 'mixed';
    return this.#write(root.root, ['reset', `--${mode}`, ref], 'reset', options);
  }

  /**
   * Revert one commit by creating a new commit that undoes it.
   *
   * WHY THIS IS NON-DESTRUCTIVE: `/local/revert` and `/local/revert-commit`
   * both mean "undo this commit" in the contract's route table, and reverting
   * is the only undo that never rewrites history the user may already have
   * pushed. Destructive rewinds belong to `/local/reset`.
   *
   * @param {string} path
   * @param {{sha: string, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async revert(path, options) {
    const root = await this.assertRepo(path, options);
    const sha = nonEmpty(options.sha);
    if (!sha) throw new GitError('BAD_REQUEST', '缺少提交 SHA');
    return this.#write(root.root, ['revert', '--no-edit', sha], 'revert', options);
  }

  /**
   * Create a tag, optionally pushing it.
   *
   * @param {string} path
   * @param {{name: string, ref?: string, push?: boolean, remote?: string,
   *   token?: string, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async tag(path, options) {
    const root = await this.assertRepo(path, options);
    const name = nonEmpty(options.name);
    if (!name) throw new GitError('BAD_REQUEST', '标签名不能为空');
    const ref = nonEmpty(options.ref) ?? 'HEAD';
    const created = await this.#write(root.root, ['tag', name, ref], 'tag', options);
    if (options.push !== true) return created;
    const remote = nonEmpty(options.remote) ?? 'origin';
    const pushed = await this.#network(
      root.root,
      ['push', remote, name],
      'push',
      options,
    );
    return { output: `${created.output}${pushed.output}` };
  }

  /**
   * Stash the working tree.
   * @param {string} path
   * @param {{message?: string, includeUntracked?: boolean,
   *   secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async stash(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const args = ['stash', 'push'];
    if (options.includeUntracked !== false) args.push('--include-untracked');
    const message = nonEmpty(options.message);
    if (message) args.push('-m', message);
    return this.#write(root.root, args, 'stash', options);
  }

  /**
   * Pop one stash entry.
   * @param {string} path
   * @param {{index?: number, secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async stashPop(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const index = Number.isInteger(options.index) && options.index >= 0 ? options.index : 0;
    return this.#write(root.root, ['stash', 'pop', `stash@{${index}}`], 'stash', options);
  }

  /**
   * Restore files from the index (or HEAD).
   *
   * `staged: true` discards BOTH the index and the worktree copy, which is what
   * "撤回这个文件的全部改动" means in the panel; `staged: false` only rewrites
   * the worktree file, leaving an already-staged version alone.
   *
   * @param {string} path
   * @param {{files: string[], staged?: boolean, secrets?: Iterable<string>}} options
   * @returns {Promise<{output: string}>}
   */
  async restore(path, options) {
    const root = await this.assertRepo(path, options);
    const files = Array.isArray(options.files) ? options.files.filter((f) => typeof f === 'string' && f !== '') : [];
    if (files.length === 0) throw new GitError('BAD_REQUEST', '缺少要还原的文件');
    const args = ['restore'];
    if (options.staged === true) args.push('--staged', '--worktree');
    args.push('--', ...files);
    return this.#write(root.root, args, 'restore', options);
  }

  /**
   * Discard EVERYTHING uncommitted: `git reset --hard` plus removal of
   * untracked files. Ignored files (node_modules, build output) are kept —
   * `clean -x` would delete them, which is never what the button means.
   *
   * @param {string} path
   * @param {{secrets?: Iterable<string>}} [options]
   * @returns {Promise<{output: string}>}
   */
  async discardAll(path, options = {}) {
    const root = await this.assertRepo(path, options);
    const resetOut = await this.#write(root.root, ['reset', '--hard', 'HEAD'], 'reset', options);
    const cleanOut = await this.#write(root.root, ['clean', '-fd'], 'clean', options);
    return { output: resetOut.output + cleanOut.output };
  }

  /**
   * Run one mutating command and convert a non-zero exit into GIT_FAILED with
   * git's raw output attached.
   * @private
   */
  async #write(cwd, args, label, options = {}) {
    const out = await this.run(args, { cwd, label, secrets: options.secrets });
    if (out.code !== 0) {
      const raw = `${out.stdout}${out.stderr}`.trim();
      throw new GitError('GIT_FAILED', `git ${label} 失败：${raw}`, { output: raw, args });
    }
    return { output: merged(out) };
  }

  /**
   * Run one network command: long-but-finite timeout, no interactive prompt,
   * token supplied per invocation only.
   * @private
   */
  async #network(cwd, args, label, options = {}) {
    const out = await this.run(args, {
      cwd,
      label,
      timeoutMs: NETWORK_TIMEOUT_MS,
      secrets: options.secrets,
      // One place: the token becomes configuration in the CHILD ENVIRONMENT
      // instead of an argv element, for every network command.
      env: authEnv(options.token, { username: options.username }),
    });
    if (out.code !== 0) {
      const raw = `${out.stdout}${out.stderr}`.trim();
      throw new GitError('GIT_FAILED', `git ${label} 失败：${networkHint(raw, args)}`, { output: raw, args });
    }
    return { output: merged(out) };
  }
}

/**
 * Turn the transport failures a user actually hits into an actionable Chinese
 * sentence, PREPENDED to git's own (already redacted) output.
 *
 * The two failures this plugin can create by itself are the interesting ones:
 *
 *  - `could not read Username/Password`: git's credential flow ran and had no
 *    terminal. Every network command here is started with
 *    `GIT_TERMINAL_PROMPT=0`, so this is a dead end for the request, not a
 *    transient hiccup — saying so (and naming the fix) beats leaving the user
 *    with a bare `fatal:` line.
 *  - certificate verification: the profile process may be behind an
 *    intercepting proxy. The panel already explains the gitPath workaround on
 *    API calls; the git path deserves the same hint.
 *
 * @param {string} raw merged git stdout+stderr.
 * @param {string[]} args the argv (used to tell a URL push from a remote one).
 * @returns {string} the message body.
 */
function networkHint(raw, args) {
  const text = String(raw ?? '');
  if (/could not read (Username|Password)|terminal prompts disabled/i.test(text)) {
    const urlPush = args.some((arg) => /^https?:\/\//i.test(arg));
    return '需要凭据时无法弹出输入窗口（本插件的 git 不允许交互式提示）。'
      + (urlPush
        ? '请确认已登录 GitHub 账号且令牌有 repo 权限；如仍失败，可先在本地添加远端再推送。'
        : '请确认远端地址正确、已登录 GitHub 账号且令牌有 repo 权限。')
      + `\n${text}`;
  }
  if (TLS_FAILURE.test(text)) {
    return 'git 无法校验 GitHub 的 TLS 证书（常见于企业代理、杀毒软件或系统时间错误）。'
    + '请修复证书/代理，或在插件设置里填写可用的「git 路径」。'
    + `\n${text}`;
  }
  return text;
}

/** Merge stdout + stderr the way CONTRACT §3 defines a write command's output. */
function merged(result) {
  return truncate(`${result.stdout}${result.stderr}`, MAX_OUTPUT_CHARS);
}

/** A trimmed non-empty string, or undefined. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** True when `path` names an existing directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Clamp an integer option into [min, max], falling back to `fallback`. */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Pick the remote that should be treated as "the GitHub remote".
 *
 * The configured `defaultRemote` wins when it IS a GitHub remote; otherwise the
 * first GitHub remote in `git remote -v` order, which is stable per repository.
 *
 * @param {{name: string, url: string}[]} remotes
 * @param {string} [defaultRemote]
 * @returns {{name: string, owner: string, repo: string, url: string}|null}
 */
function pickGithubRemote(remotes, defaultRemote) {
  const preferred = typeof defaultRemote === 'string' && defaultRemote.trim() !== '' ? defaultRemote.trim() : 'origin';
  const ordered = [
    ...remotes.filter((remote) => remote.name === preferred),
    ...remotes.filter((remote) => remote.name !== preferred),
  ];
  for (const remote of ordered) {
    if (!isGithubUrl(remote.url)) continue;
    const parsed = parseGithubRemote(remote.url);
    if (!parsed) continue;
    return { name: remote.name, owner: parsed.owner, repo: parsed.repo, url: remote.url };
  }
  return null;
}
