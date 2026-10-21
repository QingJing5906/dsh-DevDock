/**
 * dsh-push — durable Host state (accounts + settings + push memory).
 *
 * Everything the Host half remembers between requests lives in ONE JSON
 * document under the DSH home:
 *
 *   $DSH_HOME/push/state.json      (or ~/.dsh/push/state.json)
 *
 * WHY ONE DOCUMENT: accounts and settings change together (activating an
 * account, flipping `gitPath`), so splitting them across files would create a
 * torn-state window for no benefit. The file also carries the ACCESS TOKENS,
 * which is why every read used for the wire goes through {@link publicAccount}
 * and every error string goes through {@link redactSecrets}.
 *
 * WHY ATOMIC WRITE (temp + rename): a profile process that dies mid-write must
 * never leave a truncated JSON document behind — the next boot would lose
 * every account the user added. `rename` over the existing file is atomic on
 * both POSIX and Windows (MoveFileEx with REPLACE_EXISTING).
 *
 * @module src/host/store.js
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Settings the document always carries, in the exact shape of CONTRACT §1. */
export const DEFAULT_SETTINGS = Object.freeze({
  oauthClientId: '',
  defaultRemote: 'origin',
  showPrivate: true,
  gitPath: '',
});

/**
 * Current document schema version. Bump only with a migration below.
 *
 * `pushMemory` (CONTRACT §3b) was added WITHOUT a version bump on purpose: it
 * is an additive, self-degrading table (`normalizeState` fills `{}` when it is
 * absent), and a bump would force a migration for a document that is already
 * valid under both versions.
 */
const STATE_VERSION = 1;

/**
 * Resolve the DSH home directory.
 *
 * Mirrors the documented convention (`$DSH_HOME` when set and non-empty,
 * otherwise `~/.dsh`) rather than reading a service, so this module stays
 * importable by a bare smoke-test script that never boots cordis.
 *
 * @returns {string} absolute home directory.
 */
export function resolveDshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured !== '' ? configured : join(homedir(), '.dsh');
}

/**
 * Redact secrets from a string before it can reach a log line, a JSON response
 * or a git output field.
 *
 * WHY BOTH LISTS: we know the tokens we hold (exact substring removal), but a
 * token can also appear inside a message we did not build — git echoing a
 * header, an upstream error body quoting an Authorization value. The pattern
 * pass catches GitHub's documented token prefixes, and the last rule masks
 * any URL userinfo (`https://x-access-token:TOKEN@github.com`).
 *
 * @param {unknown} text value to sanitize (coerced with String()).
 * @param {Iterable<string>} [secrets] exact secret strings to remove.
 * @returns {string} the sanitized text.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('***');
  }
  return out
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/(https?:\/\/)[^\s/@]+@/g, '$1***@');
}

/**
 * The wire-safe projection of a stored account: the token is REMOVED.
 *
 * @param {object} account stored account record (carries `token`).
 * @returns {object} CONTRACT §1 `Account`.
 */
export function publicAccount(account) {
  return {
    id: String(account.id ?? ''),
    login: String(account.login ?? ''),
    name: account.name ?? null,
    avatarUrl: account.avatarUrl ?? null,
    htmlUrl: account.htmlUrl ?? null,
    tokenKind: account.tokenKind === 'oauth' ? 'oauth' : 'pat',
    scopes: Array.isArray(account.scopes) ? account.scopes.filter((s) => typeof s === 'string') : [],
    addedAt: typeof account.addedAt === 'string' ? account.addedAt : new Date(0).toISOString(),
    lastUsedAt: typeof account.lastUsedAt === 'string' ? account.lastUsedAt : null,
  };
}

/** A fresh, empty document. */
function emptyState() {
  return {
    version: STATE_VERSION,
    accounts: [],
    activeAccountId: null,
    settings: { ...DEFAULT_SETTINGS },
    // CONTRACT §3b: (仓库根, 分支) → 上次成功推送的目标. Always present so a
    // caller never has to distinguish "absent" from "empty".
    pushMemory: {},
    // CONTRACT §3d: the user's SAVED review prompts. Built-ins live in code,
    // so this table only ever holds presets the user created.
    reviewPresets: [],
  };
}

/**
 * Normalize a repository root into the key prefix used by `pushMemory`.
 *
 * THE PROBLEM THIS SOLVES: the same repository reaches the Host as any of
 * `D:\x\y`, `D:/x/y`, `d:\x\y\` — the client sends the session cwd, the user may
 * type a path, and git itself prints forward slashes on Windows. Remembering
 * "which target did I push this branch to" must not depend on which spelling
 * arrived, so every variant collapses to ONE string:
 *
 *   absolute → forward slashes → lowercase Windows drive letter → no trailing
 *   slash.
 *
 * The rest of the path keeps its case: Windows is case-insensitive but POSIX is
 * not, and a Linux user's `/home/A` and `/home/a` are different repositories.
 * Lowercasing the whole path would silently merge them.
 *
 * @param {string} root absolute repository root as reported by git.
 * @returns {string} the normalized form (`''` for a non-string/empty input).
 */
export function normalizeRepoRoot(root) {
  const raw = typeof root === 'string' ? root.trim() : '';
  if (raw === '') return '';
  // Windows accepts both separators; forward-slash everything first so the
  // drive-letter rule below does not need two forms.
  let out = raw.replace(/\\/g, '/');
  // `D:` and `d:` are the same drive on Windows; only the drive letter is
  // case-folded (see above), never the rest of the path.
  out = out.replace(/^([A-Za-z]):\//, (_match, letter) => `${String(letter).toLowerCase()}:/`);
  // `D:/x/y/`, `D:/x/y//` → `D:/x/y`. The root `/` stays `/`.
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

/**
 * The `pushMemory` table key for (repository, branch).
 *
 * `|` is the separator because it cannot appear in a Windows path and is
 * extremely unusual in a POSIX one, so the key round-trips without escaping.
 *
 * @param {string} root repository root (normalized here).
 * @param {string} branch branch name.
 * @returns {string} `<normalizedRepoRoot>|<branch>`.
 */
export function pushMemoryKey(root, branch) {
  return `${normalizeRepoRoot(root)}|${String(branch ?? '').trim()}`;
}

/**
 * Coerce the saved review-preset list (CONTRACT §3d).
 *
 * A preset needs an id, a title and a prompt to be usable; anything missing one
 * is dropped. Duplicate ids keep the first occurrence, so a hand-edited
 * document cannot make the panel render two cards with the same key.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeReviewPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt : '';
    if (id === '' || title === '' || prompt.trim() === '') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      prompt,
      description: typeof candidate.description === 'string' ? candidate.description : '',
      category: typeof candidate.category === 'string' && candidate.category !== ''
        ? candidate.category
        : 'custom',
      builtin: false,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
    });
  }
  return out;
}

/**
 * Coerce one persisted memory entry, dropping anything unusable.
 * @param {unknown} raw
 * @returns {object|undefined}
 */
function normalizePushMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const remote = typeof raw.remote === 'string' ? raw.remote.trim() : '';
  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  const ref = typeof raw.ref === 'string' ? raw.ref.trim() : '';
  if (owner === '' || repo === '') return undefined;
  return {
    // A URL-pushed target has no remote name; the contract allows that, so an
    // empty `remote` is preserved verbatim instead of rejecting the entry.
    remote,
    owner,
    repo,
    ref,
    at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : new Date(0).toISOString(),
  };
}

/**
 * Coerce the persisted `pushMemory` table.
 *
 * A corrupt table (an array, a string, `null`, a file hand-edited into
 * nonsense) degrades to `{}` — exactly like a malformed account is dropped, so
 * one bad key can never take /state down.
 *
 * @param {unknown} raw
 * @returns {Record<string, object>}
 */
function normalizePushMemory(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = normalizePushMemoryEntry(value);
    if (!entry) continue;
    const at = key.lastIndexOf('|');
    if (at <= 0 || at === key.length - 1) continue;
    const root = normalizeRepoRoot(key.slice(0, at));
    const branch = key.slice(at + 1).trim();
    if (root === '' || branch === '') continue;
    // Re-key through the normalizer so a hand-written `D:\x\y|main` collides
    // with the canonical entry instead of becoming a second one.
    out[`${root}|${branch}`] = entry;
  }
  return out;
}

/** Coerce one persisted account record, dropping anything unusable. */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const login = typeof raw.login === 'string' ? raw.login.trim() : '';
  const token = typeof raw.token === 'string' ? raw.token : '';
  if (login === '' || token === '') return undefined;
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : login.toLowerCase(),
    login,
    name: typeof raw.name === 'string' ? raw.name : null,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null,
    htmlUrl: typeof raw.htmlUrl === 'string' ? raw.htmlUrl : null,
    token,
    tokenKind: raw.tokenKind === 'oauth' ? 'oauth' : 'pat',
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s) => typeof s === 'string') : [],
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date().toISOString(),
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
  };
}

/** Coerce the persisted settings object into the contract shape. */
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.oauthClientId === 'string') out.oauthClientId = raw.oauthClientId.trim();
  if (typeof raw.defaultRemote === 'string' && raw.defaultRemote.trim() !== '') out.defaultRemote = raw.defaultRemote.trim();
  if (typeof raw.showPrivate === 'boolean') out.showPrivate = raw.showPrivate;
  if (typeof raw.gitPath === 'string') out.gitPath = raw.gitPath.trim();
  return out;
}

/**
 * Drop a leading UTF-8 byte-order mark.
 *
 * `JSON.parse` treats U+FEFF as an unexpected token, so a document saved with
 * a BOM (Windows PowerShell 5.1's `-Encoding utf8`, many editors) parses as
 * "corrupt" and its accounts silently vanish. Trimming one leading BOM is
 * always correct for JSON, whose grammar allows no leading character.
 *
 * @param {string} text raw document text.
 * @returns {string} the same text without a leading BOM.
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normalize a whole persisted document.
 *
 * A malformed sibling (an account without a token, an activeAccountId that
 * points at a removed login) is DROPPED rather than throwing: a hand-edited or
 * half-migrated state file must degrade to "fewer accounts", never to a plugin
 * that cannot answer /state at all.
 *
 * @param {unknown} raw parsed JSON.
 * @returns {object} a valid state document.
 */
function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  if (Array.isArray(raw.accounts)) {
    const seen = new Set();
    for (const candidate of raw.accounts) {
      const account = normalizeAccount(candidate);
      if (!account || seen.has(account.id)) continue;
      seen.add(account.id);
      state.accounts.push(account);
    }
  }
  state.settings = normalizeSettings(raw.settings);
  // CONTRACT §3b: an absent or corrupt table is `{}`, never an exception.
  state.pushMemory = normalizePushMemory(raw.pushMemory);
  // CONTRACT §3d: same rule for the saved review prompts. A malformed entry is
  // dropped rather than failing the whole document — a hand-edited preset list
  // must degrade to "fewer presets", never to a plugin that cannot answer.
  state.reviewPresets = normalizeReviewPresets(raw.reviewPresets);
  const active = typeof raw.activeAccountId === 'string' ? raw.activeAccountId : null;
  state.activeAccountId = active !== null && state.accounts.some((a) => a.id === active)
    ? active
    : (state.accounts[0]?.id ?? null);
  return state;
}

/**
 * Durable store for the plugin's accounts + settings.
 *
 * Reads are cached in memory and invalidated on every write (the file is
 * tiny; the cache exists so a burst of /state calls from the panel does not
 * hammer the disk). Writes are serialized through one promise chain so two
 * concurrent mutations can never interleave their read-modify-write.
 */
export class GithubLinkStore {
  /** @type {string} absolute directory holding the state document. */
  #dir;
  /** @type {string} absolute path of the state document. */
  #file;
  /** @type {string} pre-rename document, adopted only while `#file` is absent. */
  #legacyFile;
  /** @type {object|undefined} last successfully read/written document. */
  #cache;
  /** @type {Promise<unknown>} mutation queue tail. */
  #queue = Promise.resolve();

  /**
   * @param {{home?: string}} [options] `home` overrides the DSH home (tests).
   */
  constructor(options = {}) {
    const home = options.home ?? resolveDshHome();
    this.#dir = join(home, 'push');
    this.#file = join(this.#dir, 'state.json');
    // The bundle was published as `dsh-github-link` before it was renamed, and
    // at least one build stored its accounts under that old directory. Nobody
    // should have to sign in again because a package changed its name, so an
    // existing old document is adopted on first read when the new one is
    // absent. Reading it is enough: the first write lands in the new location.
    this.#legacyFile = join(home, 'github-link', 'state.json');
  }

  /**
   * The document to read: the current one, else a pre-rename one.
   * @returns {Promise<{file: string, raw: string}|undefined>}
   */
  async #readSource() {
    for (const file of [this.#file, this.#legacyFile]) {
      if (!file) continue;
      try {
        return { file, raw: await readFile(file, 'utf8') };
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        // Unreadable-but-present (ACL, EACCES) must not be reported as "no
        // accounts", and must not silently fall through to the legacy path.
        throw error;
      }
    }
    return undefined;
  }

  /** Absolute path of the state document (diagnostics only — never sent). */
  get statePath() {
    return this.#file;
  }

  /** Read the document from disk (cached), falling back to an empty one. */
  async read() {
    if (this.#cache) return this.#cache;
    let source;
    try {
      source = await this.#readSource();
    } catch (error) {
      // Unreadable-but-present (ACL, EACCES) must not be reported as "no
      // accounts": surface it so the caller can show a real diagnosis.
      throw error;
    }
    if (source === undefined) {
      this.#cache = emptyState();
      return this.#cache;
    }
    let parsed;
    try {
      // Strip a UTF-8 BOM before parsing. A user (or an editor, or a
      // PowerShell `Set-Content -Encoding utf8` on Windows PowerShell 5.1)
      // writing this file by hand produces `EF BB BF` + `{...}`, and
      // `JSON.parse` rejects the BOM as an unexpected token — which would
      // quietly drop every saved account and token into the empty-state path.
      // Accepting the BOM costs one comparison and makes hand-recovery safe.
      parsed = JSON.parse(stripBom(source.raw));
    } catch {
      // A corrupt document is preserved on disk (we do not overwrite until the
      // next write) but the in-memory view starts empty.
      parsed = undefined;
    }
    this.#cache = normalizeState(parsed);
    return this.#cache;
  }

  /**
   * Atomically replace the document.
   *
   * Writes a sibling temp file (mode 0600) and renames it over the target, so
   * a crash leaves either the old or the new document — never a partial one.
   *
   * @param {object} state document to persist (already normalized).
   * @returns {Promise<object>} the persisted document.
   */
  async write(state) {
    const normalized = normalizeState(state);
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    const body = `${JSON.stringify(normalized, null, 2)}\n`;
    await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      // `mode` on writeFile is masked by umask; an explicit chmod is what makes
      // the 0600 guarantee real for the file that now holds the tokens.
      await chmod(temp, 0o600).catch(() => {});
    }
    await rename(temp, this.#file);
    this.#cache = normalized;
    return normalized;
  }

  /**
   * Run one read-modify-write mutation, serialized against every other one.
   *
   * @template T
   * @param {(state: object) => (T|Promise<T>)} mutator receives a deep-enough
   *   copy to mutate freely; returning a value resolves the call with it.
   * @returns {Promise<T>} the mutator's return value.
   */
  mutate(mutator) {
    const run = async () => {
      const current = await this.read();
      // Clone so a throwing mutator cannot leave a half-applied cache behind.
      const draft = {
        version: STATE_VERSION,
        accounts: current.accounts.map((a) => ({ ...a })),
        activeAccountId: current.activeAccountId,
        settings: { ...current.settings },
        // The push-memory table is cloned too: a mutator that rewrites one
        // branch's entry must not alias the cached object.
        pushMemory: Object.fromEntries(
          Object.entries(current.pushMemory ?? {}).map(([key, entry]) => [key, { ...entry }]),
        ),
        // Saved review prompts are cloned for the same reason. Omitting this
        // table made every write silently DROP the presets a user had just
        // saved: the mutation landed, the save reported success, and the next
        // read found an empty list.
        reviewPresets: (current.reviewPresets ?? []).map((preset) => ({ ...preset })),
      };
      const result = await mutator(draft);
      await this.write(draft);
      return result;
    };
    // Chain on the tail, and keep the chain alive after a rejection so one
    // failed write does not deadlock every later mutation.
    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(() => {}, () => {});
    return queued;
  }

  /**
   * Find one stored account (WITH its token) by local id.
   * @param {string} accountId
   * @returns {Promise<object|undefined>}
   */
  async accountById(accountId) {
    const state = await this.read();
    return state.accounts.find((account) => account.id === accountId);
  }

  /**
   * The active account WITH its token, or undefined when nobody is signed in.
   * @returns {Promise<object|undefined>}
   */
  async activeAccount() {
    const state = await this.read();
    if (state.activeAccountId === null) return undefined;
    return state.accounts.find((account) => account.id === state.activeAccountId);
  }

  /**
   * Token strings currently held — the redaction list for git/API output.
   * @returns {Promise<string[]>}
   */
  async secrets() {
    const state = await this.read();
    return state.accounts.map((account) => account.token).filter((token) => typeof token === 'string' && token !== '');
  }

  /** Current settings (a copy — callers may not mutate the cache). */
  async settings() {
    const state = await this.read();
    return { ...state.settings };
  }

  /**
   * Merge a validated settings patch and persist it.
   * @param {Partial<{oauthClientId: string, defaultRemote: string, showPrivate: boolean, gitPath: string}>} patch
   * @returns {Promise<object>} the full settings object.
   */
  async updateSettings(patch) {
    return this.mutate((state) => {
      state.settings = normalizeSettings({ ...state.settings, ...patch });
      return { ...state.settings };
    });
  }

  /* ---------------- CONTRACT §3b: push target memory ---------------- */

  /**
   * The remembered push target for ONE (repository, branch).
   *
   * A read, so it must never go through `mutate` (which would rewrite the
   * document — and take the write queue — for a pure lookup on every panel
   * render).
   *
   * @param {string} root repository root, in any spelling.
   * @param {string} branch branch name.
   * @returns {Promise<{remote: string, owner: string, repo: string, ref: string, at: string}|null>}
   */
  async pushMemoryFor(root, branch) {
    const normalizedBranch = String(branch ?? '').trim();
    if (normalizedBranch === '') return null;
    const state = await this.read();
    const entry = state.pushMemory?.[pushMemoryKey(root, normalizedBranch)];
    return entry ? { ...entry } : null;
  }

  /**
   * Every remembered target for one repository (all branches).
   *
   * @param {string} root repository root, in any spelling.
   * @returns {Promise<{branch: string, remote: string, owner: string, repo: string, ref: string, at: string}[]>}
   *   sorted by branch name, so the debug view is stable between calls.
   */
  async pushMemoryEntries(root) {
    const prefix = `${normalizeRepoRoot(root)}|`;
    if (prefix === '|') return [];
    const state = await this.read();
    const out = [];
    for (const [key, entry] of Object.entries(state.pushMemory ?? {})) {
      if (!key.startsWith(prefix)) continue;
      out.push({ branch: key.slice(prefix.length), ...entry });
    }
    out.sort((left, right) => (left.branch < right.branch ? -1 : left.branch > right.branch ? 1 : 0));
    return out;
  }

  /**
   * Record the target of one SUCCESSFUL push.
   *
   * Goes through {@link mutate} so it serializes against every other write and
   * lands atomically.
   *
   * @param {string} root repository root, in any spelling.
   * @param {string} branch branch name.
   * @param {{remote: string, owner: string, repo: string, ref: string, at: string}} entry
   * @returns {Promise<object|null>} the stored entry, or null for a key that
   *   cannot be formed (no root / no branch).
   */
  async rememberPushTarget(root, branch, entry) {
    const normalizedBranch = String(branch ?? '').trim();
    if (normalizeRepoRoot(root) === '' || normalizedBranch === '') return null;
    const key = pushMemoryKey(root, normalizedBranch);
    const record = normalizePushMemoryEntry(entry);
    if (!record) return null;
    return this.mutate((state) => {
      if (!state.pushMemory || typeof state.pushMemory !== 'object' || Array.isArray(state.pushMemory)) {
        state.pushMemory = {};
      }
      state.pushMemory[key] = record;
      return { ...record };
    });
  }

  /**
   * Forget one branch's remembered target.
   * @param {string} root
   * @param {string} branch
   * @returns {Promise<boolean>} whether an entry existed.
   */
  async forgetPushTarget(root, branch) {
    const normalizedBranch = String(branch ?? '').trim();
    if (normalizeRepoRoot(root) === '' || normalizedBranch === '') return false;
    const key = pushMemoryKey(root, normalizedBranch);
    return this.mutate((state) => {
      if (!state.pushMemory || typeof state.pushMemory !== 'object') return false;
      if (!(key in state.pushMemory)) return false;
      delete state.pushMemory[key];
      return true;
    });
  }

  /* ---------------- CONTRACT §3d: saved review prompts ---------------- */

  /**
   * Every preset the user saved.
   * @returns {Promise<object[]>} a detached copy.
   */
  async reviewPresets() {
    const state = await this.read();
    return state.reviewPresets.map((preset) => ({ ...preset }));
  }

  /**
   * Save one preset, replacing any preset with the same id.
   *
   * Replacing rather than appending is what makes "edit a saved prompt" a
   * single verb; the panel never has to distinguish create from update.
   *
   * @param {{id?: string, title: string, prompt: string, description?: string, category?: string}} input
   * @returns {Promise<object>} the stored preset.
   */
  async saveReviewPreset(input) {
    const now = new Date().toISOString();
    return this.mutate((state) => {
      const list = Array.isArray(state.reviewPresets) ? state.reviewPresets : [];
      const id = typeof input.id === 'string' && input.id.trim() !== ''
        ? input.id.trim()
        : `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const preset = {
        id,
        title: String(input.title ?? '').trim(),
        prompt: String(input.prompt ?? ''),
        description: String(input.description ?? ''),
        category: String(input.category ?? 'custom') || 'custom',
        builtin: false,
        createdAt: now,
        updatedAt: now,
      };
      const index = list.findIndex((row) => row.id === id);
      if (index >= 0) {
        // Preserve the original creation time across an update.
        preset.createdAt = list[index].createdAt ?? now;
        state.reviewPresets = list.map((row, i) => (i === index ? preset : row));
      } else {
        state.reviewPresets = [...list, preset];
      }
      return { ...preset };
    });
  }

  /**
   * Remove one saved preset.
   * @param {string} id
   * @returns {Promise<boolean>} whether a preset was removed.
   */
  async deleteReviewPreset(id) {
    const wanted = String(id ?? '').trim();
    if (wanted === '') return false;
    return this.mutate((state) => {
      const list = Array.isArray(state.reviewPresets) ? state.reviewPresets : [];
      const next = list.filter((row) => row.id !== wanted);
      if (next.length === list.length) return false;
      state.reviewPresets = next;
      return true;
    });
  }
}
