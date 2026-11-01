/**
 * dsh-push — Host half.
 *
 * Owns three things, in this order of importance:
 *
 *  1. THE HTTP API the browser half talks to. Every route in CONTRACT.md §1–§3
 *     is registered on the `webServer` service under `/api/push`, with
 *     the contract's JSON envelope, CSRF header guard and error-code
 *     vocabulary. Route shapes are grouped by PATH and dispatched by METHOD,
 *     because the contract puts a read and a write on the same path twice
 *     (`/local/commit`, `/releases`) and `webServer.register` refuses two
 *     handlers for one (kind, path).
 *
 *  2. THE AGENT TOOL `github_link`, which calls the same service methods so the
 *     model and the panel can never disagree about what a push does.
 *
 *  3. THE DURABLE STATE (accounts with their tokens, settings) in one atomic
 *     JSON document — see ./store.js.
 *
 * WHY THE ROUTE HANDLERS SNAPSHOT NOTHING BUT RE-READ THE STORE: unlike the
 * reference plugin (which snapshots long-lived services), every input here is
 * per-request user intent — settings, the active account, the repository path.
 * Reading them per request is what makes "switch account" and "change gitPath"
 * take effect on the very next click instead of after a restart. The cordis
 * services this module needs (`webServer`, `tools`) ARE snapshotted at mount,
 * because they only live as long as the owning fiber.
 *
 * @module src/host/index.js
 */

import {
  GithubError,
  // Aliased for the same reason as `repoDetail` below: the service has a
  // `contributions()` method of its own, so an unaliased import inside that
  // method body reads like accidental recursion.
  addCollaborator,
  contributions as fetchContributions,
  createRelease,
  createRepo,
  deleteBranchRemote,
  deleteRelease,
    repoLanguages,
  deleteReleaseAsset,
  uploadReleaseAsset,
deleteRepo,
  listNotifications,
  listReleases,
  listRepos,
  markNotificationRead,
  pollDeviceFlow,
  protectBranch,
  removeCollaborator,
  // Aliased: the service also has a `repoDetail()` method, and a same-named
  // import inside that method body reads like accidental recursion.
  repoDetail as fetchRepoDetail,
  repoManage as fetchRepoManage,
  renameBranch,
  renameRepo,
  searchRepos,
  startDeviceFlow,
  transferRepo,
  updateRelease,
  updateRepo,
  verifyToken,
} from './github.js';

// 工作区依赖检查需要读本地 package.json。
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

// DevDock 的 npm 模块（只读：认账号、列包、看版本）。
import {
  npmWhoami,
  npmSearchByMaintainer,
  npmPackument,
  npmLatestVersion,
  npmSearchText,
  npmPackageStatus,
} from './npm.js';

// 真正运行 npm（打包 / 发布）：文件筛选规则由 npm 自己算，才和用户手动执行一致。
import { NpmRunner, npmAuthEnv, parsePackJson, mapPackResult } from './npmcli.js';
import {
  GitError,
  GitRunner,
  githubPushUrl,
  isGithubUrl,
  parseGithubRemote,
  resolveGitBinary,
} from './git.js';
import {
  DEFAULT_SETTINGS,
  GithubLinkStore,
  normalizeRepoRoot,
  publicAccount,
  redactSecrets,
  resolveDshHome,
} from './store.js';
import {
  BUILTIN_PRESETS,
  REVIEW_CATEGORIES,
  collectReviewChanges,
  normalizeFinding,
  runModelReview,
  scanSecrets,
  MAX_FILE_BYTES,
  sortFindings,
} from './review.js';

// Robust Service base class fallback: the same technique the reference plugin
// uses, so this module can be imported (and exercised) outside a cordis host.
let ServiceClass;
try {
  const cordis = await import('@deepseek-ai/cordis');
  ServiceClass = cordis.Service;
} catch {
  ServiceClass = class Service {
    static init = Symbol.for('cordis.init');
    /**
     * @param {object} ctx
     * @param {string} name
     */
    constructor(ctx, name) {
      this.ctx = ctx;
      this.name = name;
    }
  };
}

/** HTTP prefix shared with the browser half (CONTRACT §0). */
const ROUTE_PREFIX = '/api/push';
/** CSRF marker: a custom header forces a CORS preflight the server never answers. */
const PLUGIN_HEADER = 'x-dsh-plugin';
const PLUGIN_HEADER_VALUE = 'push';

/** Wire code → HTTP status. Statuses are advisory; the code is the contract. */
const STATUS_BY_CODE = Object.freeze({
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  NO_ACCOUNT: 400,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  NETWORK: 502,
  GIT_MISSING: 503,
  GIT_FAILED: 400,
  NOT_A_REPO: 400,
  CONFLICT: 409,
  INTERNAL: 500,
});

/* ------------------------------------------------------------------ */
/*  HTTP plumbing                                                     */
/* ------------------------------------------------------------------ */

/**
 * An error carrying an HTTP status and a wire code.
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Map any thrown value onto `{status, code, message}`.
 *
 * Both plugin error types already carry a wire code; anything else is an
 * INTERNAL bug, and its message is still scrubbed because an unexpected error
 * may quote a URL with a token in it.
 *
 * @param {unknown} error
 * @param {(text: string) => string} scrub
 * @returns {{status: number, code: string, message: string, githubStatus?: number}}
 */
function toWireError(error, scrub) {
  const code = typeof error?.code === 'string' && STATUS_BY_CODE[error.code] !== undefined
    ? error.code
    : 'INTERNAL';
  const status = Number.isFinite(error?.statusCode)
    ? Number(error.statusCode)
    : (STATUS_BY_CODE[code] ?? 500);
  const message = scrub(String(error?.message ?? error ?? '未知错误'));
  const wire = { status, code, message };
  if (typeof error?.status === 'number') wire.githubStatus = error.status;
  return wire;
}

/** Write the contract's success envelope. */
function sendOk(res, data) {
  sendJson(res, 200, { ok: true, data });
}

/** Write the contract's failure envelope. */
function sendError(res, wire) {
  const error = { code: wire.code, message: wire.message };
  if (wire.githubStatus !== undefined) error.status = wire.githubStatus;
  sendJson(res, wire.status, { ok: false, error });
}

/** Write JSON with no caching (state must never be served stale). */
function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Read and parse a JSON object body; `{}` when the body is empty. */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 1 MiB is far beyond any legitimate body here (a settings patch); the cap
    // stops an accidental huge upload from being buffered in memory.
    if (size > 1_048_576) throw httpError(413, 'BAD_REQUEST', '请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw httpError(400, 'BAD_REQUEST', '请求体不是合法 JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw httpError(400, 'BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return data;
}

/** Query-string accessor bound to one request. */
function queryOf(req) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return (name) => url.searchParams.get(name);
}

/* ------------------------------------------------------------------ */
/*  Small validators shared by routes and the agent tool              */
/* ------------------------------------------------------------------ */

/** A required non-empty string field, or BAD_REQUEST. */
function requireString(body, field, label) {
  const value = body?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, 'BAD_REQUEST', `缺少${label ?? field}`);
  }
  return value.trim();
}

/** An optional string field (trimmed), or undefined. */
function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** An optional boolean field with a default. */
function optionalBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Clamp an integer query/body value. */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * The empty local-status document (`isRepo: false`), in the exact shape of
 * CONTRACT §3 so the client can render an "uninitialised" panel without a
 * second code path.
 * @returns {object}
 */
function emptyStatus() {
  return {
    isRepo: false,
    root: null,
    gitDir: null,
    branch: null,
    detachedHead: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    remotes: [],
    githubRemote: null,
    head: null,
    dirty: { changed: 0, staged: 0, untracked: 0, conflicted: 0 },
    files: [],
    tags: [],
    branches: [],
    stashes: [],
  };
}

/* ------------------------------------------------------------------ */
/*  The service                                                       */
/* ------------------------------------------------------------------ */

/**
 * The plugin's Host service.
 *
 * Exposed on the context as `githubLink` (a non-injected service, so a second
 * mount can detect itself and no other plugin can be forced to wait on it).
 */
/**
 * 判断一个 semver range 是否已经覆盖 latest。
 *
 * 这里故意只做保守判断：能明确判定"已满足"时才返回 true，其余一律当作
 * 可能过时。原因是这个值的用途只是提示「要不要去看看」，误报一次比漏报
 * 一次更容易接受——漏报会让用户以为自己是最新的。
 *
 * @param {string} range package.json 里写的版本范围
 * @param {string} latest 注册表上的最新版本
 * @returns {boolean}
 */
function rangeSatisfied(range, latest) {
  const clean = String(range || '').trim();
  if (clean === '' || clean === '*' || clean === 'latest') return true;
  // 精确版本：直接比字符串。
  if (/^v?=\d/.test(clean) || /^\d+\.\d+\.\d+$/.test(clean)) {
    return clean.replace(/^v?=?/, '') === latest;
  }
  // caret / tilde：比较主版本（tilde 再要求次版本相同）。
  const match = clean.match(/^[~^](\d+)(?:\.(\d+))?/);
  if (match) {
    const parts = latest.split('.');
    const major = Number(parts[0]);
    const minor = Number(parts[1]);
    if (!Number.isFinite(major)) return false;
    if (clean.startsWith('^')) return major === Number(match[1]);
    return major === Number(match[1]) && minor === Number(match[2]);
  }
  // 其余写法（>= 、|| 、tag 名等）交给保守分支。
  return false;
}

export class GithubLinkHost extends ServiceClass {
  /**
   * Only `webServer` is REQUIRED. The agent tool is an optional surface, so the
   * tools service is acquired through `ctx.inject(['tools'], ...)` in init():
   * a composition without a tools service still serves the panel, and a
   * composition that adds it later gets the tool without a remount.
   */
  static inject = ['webServer'];

  /** @type {GithubLinkStore} durable state. */
  #store;
  /** @type {(disposer: () => void) => void} unwinds routes + tool on unload. */
  #stop = () => {};
  /**
   * A review an agent asked for, waiting for the user to confirm it in the
   * panel. Only one at a time: a second request while this is set is answered
   * with "already pending" instead of stacking dialogs (or looping).
   * @type {{id: string, path: string, presetIds: string[], customPrompt: string,
   *   createdAt: number, source: string} | null}
   */
  #reviewRequest = null;

  /** Cached `git --version` probe, keyed by the gitPath it was taken for. */
  #gitProbe;
  /** Time of that probe (ms). */
  #gitProbeAt = 0;

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{home?: string}} [config] optional overrides (tests).
   */
  constructor(ctx, config = {}) {
    super(ctx, 'githubLink');
    this.#store = new GithubLinkStore({ home: config.home ?? resolveDshHome() });
  }

  /** The durable store (also what tests drive directly). */
  get store() {
    return this.#store;
  }

  /**
   * A runner bound to the CURRENT `gitPath` setting.
   *
   * Constructing one per call is deliberate: it costs nothing, and it means a
   * settings change applies to the next command instead of after a restart.
   * @returns {Promise<GitRunner>}
   */
  async runner() {
    const settings = await this.#store.settings();
    return new GitRunner({ gitPath: settings.gitPath });
  }

  /** Every token we hold, for output redaction. */
  async #secrets() {
    return this.#store.secrets();
  }

  /** Redact known tokens from arbitrary text. */
  async #scrub(text) {
    return redactSecrets(text, await this.#secrets());
  }

  /**
   * The active account WITH its token, or NO_ACCOUNT.
   * @returns {Promise<object>}
   */
  async #requireAccount() {
    const account = await this.#store.activeAccount();
    if (!account) {
      throw httpError(400, 'NO_ACCOUNT', '还没有登录 GitHub 账号，请先在设置里添加账号。');
    }
    return account;
  }

  /**
   * Refresh `lastUsedAt` for an account after it was actually used against
   * GitHub. Failures are swallowed: a bookkeeping write must never fail a
   * successful API call.
   * @param {string} accountId
   */
  async #touch(accountId) {
    try {
      await this.#store.mutate((state) => {
        const account = state.accounts.find((row) => row.id === accountId);
        if (account) account.lastUsedAt = new Date().toISOString();
      });
    } catch {
      // best effort
    }
  }

  /**
   * `{available, version}` for the git binary, cached for 10 s.
   *
   * `/state` is polled by the settings page, and each probe spawns a process;
   * a short cache keeps that cheap while still noticing an installed or
   * reconfigured git quickly.
   * @returns {Promise<{available: boolean, version: string|null}>}
   */
  async gitProbe() {
    const settings = await this.#store.settings();
    const key = settings.gitPath;
    const now = Date.now();
    if (this.#gitProbe && this.#gitProbe.key === key && now - this.#gitProbeAt < 10_000) {
      return this.#gitProbe.value;
    }
    const runner = new GitRunner({ gitPath: key });
    let value;
    try {
      value = await runner.probe();
    } catch {
      value = { available: false, version: null };
    }
    this.#gitProbe = { key, value };
    this.#gitProbeAt = now;
    return value;
  }

  /* ---------------- CONTRACT §1: accounts + settings ---------------- */

  /**
   * `GET /state`.
   * @returns {Promise<object>}
   */
  async state() {
    const [state, probe] = await Promise.all([this.#store.read(), this.gitProbe()]);
    return {
      accounts: state.accounts.map(publicAccount),
      activeAccountId: state.activeAccountId,
      settings: { ...DEFAULT_SETTINGS, ...state.settings },
      gitAvailable: probe.available,
      gitVersion: probe.version,
    };
  }

  /**
   * `POST /accounts/token` — validate then upsert (same login replaces).
   * @param {{token: string}} body
   * @returns {Promise<{accounts: object[], activeAccountId: string|null}>}
   */
  async addTokenAccount(body) {
    const token = requireString(body, 'token', ' GitHub 令牌');
    const profile = await verifyToken(token);
    const id = profile.login.toLowerCase();
    const result = await this.#store.mutate((state) => {
      const now = new Date().toISOString();
      const existing = state.accounts.find((account) => account.id === id);
      const record = {
        id,
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        htmlUrl: profile.htmlUrl,
        token,
        tokenKind: 'pat',
        scopes: profile.scopes,
        addedAt: existing?.addedAt ?? now,
        lastUsedAt: now,
      };
      if (existing) state.accounts = state.accounts.map((account) => (account.id === id ? record : account));
      else state.accounts = [...state.accounts, record];
      // Signing in a NEW account makes it active; re-submitting an existing
      // token must not steal the selection from the account the user is using.
      if (!existing || state.activeAccountId === null) state.activeAccountId = id;
      return { accounts: state.accounts.map(publicAccount), activeAccountId: state.activeAccountId };
    });
    return result;
  }

  /**
   * `POST /accounts/device/start` — begin the OAuth device flow.
   * @returns {Promise<object>}
   */
  async deviceStart() {
    const settings = await this.#store.settings();
    return startDeviceFlow({ clientId: settings.oauthClientId });
  }

  /**
   * `POST /accounts/device/poll` — one poll; stores the account on success.
   * @param {{deviceCode: string}} body
   * @returns {Promise<object>}
   */
  async devicePoll(body) {
    const deviceCode = requireString(body, 'deviceCode', ' deviceCode');
    const settings = await this.#store.settings();
    const polled = await pollDeviceFlow({ clientId: settings.oauthClientId, deviceCode });
    if (polled.status !== 'done' || typeof polled.token !== 'string') return { status: polled.status };

    // The OAuth token is validated through the same /user call as a PAT, so an
    // account record has identical fields regardless of how it was obtained.
    const profile = await verifyToken(polled.token);
    const id = profile.login.toLowerCase();
    const stored = await this.#store.mutate((state) => {
      const now = new Date().toISOString();
      const existing = state.accounts.find((account) => account.id === id);
      const record = {
        id,
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        htmlUrl: profile.htmlUrl,
        token: polled.token,
        tokenKind: 'oauth',
        scopes: profile.scopes,
        addedAt: existing?.addedAt ?? now,
        lastUsedAt: now,
      };
      if (existing) state.accounts = state.accounts.map((account) => (account.id === id ? record : account));
      else state.accounts = [...state.accounts, record];
      state.activeAccountId = id;
      return { accounts: state.accounts.map(publicAccount), activeAccountId: state.activeAccountId };
    });
    return { status: 'done', ...stored };
  }

  /**
   * `POST /accounts/activate`.
   * @param {{accountId: string}} body
   * @returns {Promise<{activeAccountId: string}>}
   */
  async activateAccount(body) {
    const accountId = requireString(body, 'accountId', ' accountId');
    const activeAccountId = await this.#store.mutate((state) => {
      const found = state.accounts.find((account) => account.id === accountId);
      if (!found) throw httpError(404, 'NOT_FOUND', `找不到账号 ${accountId}`);
      state.activeAccountId = accountId;
      return accountId;
    });
    return { activeAccountId };
  }

  /**
   * `POST /accounts/remove`.
   * @param {{accountId: string}} body
   * @returns {Promise<{accounts: object[], activeAccountId: string|null}>}
   */
  async removeAccount(body) {
    const accountId = requireString(body, 'accountId', ' accountId');
    return this.#store.mutate((state) => {
      if (!state.accounts.some((account) => account.id === accountId)) {
        throw httpError(404, 'NOT_FOUND', `找不到账号 ${accountId}`);
      }
      state.accounts = state.accounts.filter((account) => account.id !== accountId);
      if (state.activeAccountId === accountId) {
        // Fall back to the first remaining account so the panel is never left
        // showing "active: <deleted>" — or no active account while one exists.
        state.activeAccountId = state.accounts[0]?.id ?? null;
      }
      return { accounts: state.accounts.map(publicAccount), activeAccountId: state.activeAccountId };
    });
  }

  /**
   * `POST /settings` — merge a validated patch.
   * @param {object} body
   * @returns {Promise<{settings: object}>}
   */
  async updateSettings(body) {
    const patch = {};
    if (body.oauthClientId !== undefined) {
      if (typeof body.oauthClientId !== 'string') throw httpError(400, 'BAD_REQUEST', 'oauthClientId 必须是字符串');
      patch.oauthClientId = body.oauthClientId.trim();
    }
    if (body.defaultRemote !== undefined) {
      if (typeof body.defaultRemote !== 'string') throw httpError(400, 'BAD_REQUEST', 'defaultRemote 必须是字符串');
      patch.defaultRemote = body.defaultRemote.trim() === '' ? 'origin' : body.defaultRemote.trim();
    }
    if (body.showPrivate !== undefined) {
      if (typeof body.showPrivate !== 'boolean') throw httpError(400, 'BAD_REQUEST', 'showPrivate 必须是布尔值');
      patch.showPrivate = body.showPrivate;
    }
    if (body.gitPath !== undefined) {
      if (typeof body.gitPath !== 'string') throw httpError(400, 'BAD_REQUEST', 'gitPath 必须是字符串');
      patch.gitPath = body.gitPath.trim();
    }
    const settings = await this.#store.updateSettings(patch);
    // A changed gitPath invalidates the cached probe immediately.
    this.#gitProbe = undefined;
    return { settings };
  }

  /* ---------------- CONTRACT §2: remote repositories ---------------- */

  /**
   * `GET /repos` — list or search.
   * @param {{page?: string|number, q?: string, affiliation?: string, sort?: string}} query
   * @returns {Promise<object>}
   */
  async repos(query) {
    const account = await this.#requireAccount();
    const page = clampInt(query.page, 1, 1000, 1);
    const q = optionalString(query.q);
    const result = q
      ? await searchRepos({ token: account.token, login: account.login, q, page })
      : await listRepos({
        token: account.token,
        page,
        affiliation: optionalString(query.affiliation),
        sort: optionalString(query.sort),
      });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `GET /repos/detail`.
   * @param {{owner: string, name: string}} query
   * @returns {Promise<object>}
   */
  async repoDetail(query) {
    const account = await this.#requireAccount();
    const owner = requireString(query, 'owner', ' owner');
    const name = requireString(query, 'name', ' name');
    const result = await fetchRepoDetail({ token: account.token, owner, name });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/create`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoCreate(body) {
    const account = await this.#requireAccount();
    const name = requireString(body, 'name', '仓库名称');
    const result = await createRepo({
      token: account.token,
      name,
      owner: optionalString(body.owner),
      login: account.login,
      private: optionalBool(body.private, true),
      description: optionalString(body.description) ?? '',
      autoInit: optionalBool(body.autoInit, false),
    });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/delete`.
   * @param {object} body
   * @returns {Promise<{deleted: true}>}
   */
  async repoDelete(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', '仓库名称');
    // Deleting a repository is irreversible and needs the delete_repo
    // scope, so it is gated exactly like rename/transfer: a bare call with no
    // explicit confirmation is a mistake, not an intent.
    if (optionalBool(body.confirm, false) !== true) {
      throw httpError(
        409,
        'CONFLICT',
        `删除仓库会永久移除 ${owner}/${name} 在 GitHub 上的全部代码、Issue、PR 与发布，无法撤销，且需要令牌具备 delete_repo 权限范围。请确认后再执行（confirm: true）。`,
      );
    }
    const result = await deleteRepo({ token: account.token, owner, name });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `GET /repos/manage` — the management dialog's aggregate (CONTRACT §3c).
   *
   * Partial failure is the NORMAL case here: a token with `repo` but without
   * `admin:repo_hook` still gets stars, branches and releases, and only the
   * webhook field comes back `null` with a Chinese warning. `github.js` does
   * the `Promise.allSettled` fan-out; this method only supplies the account.
   *
   * @param {{owner: string, name: string}} query
   * @returns {Promise<object>}
   */
  async repoManage(query) {
    const account = await this.#requireAccount();
    const owner = requireString(query, 'owner', ' owner');
    const name = requireString(query, 'name', ' name');
    const result = await fetchRepoManage({ token: account.token, owner, name });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/update` — edit repository metadata (CONTRACT §3c).
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoUpdate(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const patch = {};
    // Every field is optional; only the ones present are forwarded, so the
    // route can no longer wipe a description the user did not edit.
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') throw httpError(400, 'BAD_REQUEST', 'description 必须是字符串');
      patch.description = body.description;
    }
    if (body.homepage !== undefined) {
      if (typeof body.homepage !== 'string') throw httpError(400, 'BAD_REQUEST', 'homepage 必须是字符串');
      patch.homepage = body.homepage;
    }
    if (body.private !== undefined) {
      if (typeof body.private !== 'boolean') throw httpError(400, 'BAD_REQUEST', 'private 必须是布尔值');
      patch.private = body.private;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw httpError(400, 'BAD_REQUEST', 'archived 必须是布尔值');
      patch.archived = body.archived;
    }
    if (body.topics !== undefined) {
      if (!Array.isArray(body.topics)) throw httpError(400, 'BAD_REQUEST', 'topics 必须是字符串数组');
      patch.topics = body.topics.filter((topic) => typeof topic === 'string');
    }
    if (body.defaultBranch !== undefined) {
      if (typeof body.defaultBranch !== 'string') throw httpError(400, 'BAD_REQUEST', 'defaultBranch 必须是字符串');
      patch.defaultBranch = body.defaultBranch;
    }
    const result = await updateRepo({ token: account.token, owner, name, patch });
    await this.#touch(account.id);
    // A topics-only change issues no PATCH, so there is no repository payload;
    // refetch it so every caller keeps receiving a complete repo object.
    if (!result.repo) {
      const refreshed = await fetchRepoDetail({ token: account.token, owner, name });
      return { repo: refreshed.repo, topics: result.topics };
    }
    return result;
  }

  /**
   * `POST /repos/branch/rename`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoBranchRename(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const from = requireString(body, 'from', '原分支名');
    const to = requireString(body, 'to', '新分支名');
    const result = await renameBranch({ token: account.token, owner, name, from, to });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/branch/delete`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoBranchDelete(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const branch = requireString(body, 'branch', '分支名');
    const result = await deleteBranchRemote({ token: account.token, owner, name, branch });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/branch/protect`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoBranchProtect(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const branch = requireString(body, 'branch', '分支名');
    if (typeof body.protected !== 'boolean') {
      throw httpError(400, 'BAD_REQUEST', 'protected 必须是布尔值');
    }
    const result = await protectBranch({
      token: account.token,
      owner,
      name,
      branch,
      protected: body.protected,
    });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/release/delete`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoReleaseDelete(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const id = requireString(body, 'id', ' release id');
    const result = await deleteRelease({ token: account.token, owner, name, id });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/release/update`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoReleaseUpdate(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const id = requireString(body, 'id', ' release id');
    const patch = {};
    // `body.name` is the REPOSITORY name (used above), so the release title
    // must arrive under its own key. Accepting `name` here made it
    // impossible to set a title without corrupting the repository path.
    const releaseName = optionalString(body.releaseName) ?? optionalString(body.title);
    if (releaseName !== undefined) {
      patch.name = releaseName;
    }
    if (body.body !== undefined) {
      if (typeof body.body !== 'string') throw httpError(400, 'BAD_REQUEST', 'body 必须是字符串');
      patch.body = body.body;
    }
    if (body.draft !== undefined) {
      if (typeof body.draft !== 'boolean') throw httpError(400, 'BAD_REQUEST', 'draft 必须是布尔值');
      patch.draft = body.draft;
    }
    if (body.prerelease !== undefined) {
      if (typeof body.prerelease !== 'boolean') throw httpError(400, 'BAD_REQUEST', 'prerelease 必须是布尔值');
      patch.prerelease = body.prerelease;
    }
    // Never spread `patch` into an object that already has `name`: the spread
    // overwrote the repository name with the release title.
    const result = await updateRelease({
      token: account.token,
      owner,
      repo: name,
      id,
      title: patch.name,
      body: patch.body,
      draft: patch.draft,
      prerelease: patch.prerelease,
    });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/collaborator/add`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoCollaboratorAdd(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const user = requireString(body, 'user', ' GitHub 用户名');
    const permission = optionalString(body.permission) ?? 'push';
    const result = await addCollaborator({ token: account.token, owner, name, user, permission });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/collaborator/remove`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoCollaboratorRemove(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const user = requireString(body, 'user', ' GitHub 用户名');
    const result = await removeCollaborator({ token: account.token, owner, name, user });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/rename` — destructive; requires `confirm: true`.
   *
   * The confirmation pattern (and its wording) is copied from `/local/reset`
   * and `/local/discard-all`: a 409 CONFLICT that says exactly what will
   * happen and what field acknowledges it.
   *
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoRename(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const newName = requireString(body, 'newName', '新仓库名称');
    if (optionalBool(body.confirm, false) !== true) {
      throw httpError(
        409,
        'CONFLICT',
        `重命名仓库会改变它的地址：旧链接会被 GitHub 重定向，但本地远端、其他协作者的克隆都需要手动更新。请确认后再执行（confirm: true）。`,
      );
    }
    const result = await renameRepo({ token: account.token, owner, name, newName });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /repos/transfer` — destructive; requires `confirm: true`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async repoTransfer(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', ' name');
    const newOwner = requireString(body, 'newOwner', '新的仓库所有者');
    if (optionalBool(body.confirm, false) !== true) {
      throw httpError(
        409,
        'CONFLICT',
        `转移仓库会把它移交给 ${newOwner}，原所有者将失去管理权限，且 Webhook、协作者与 Actions 配置可能失效。请确认后再执行（confirm: true）。`,
      );
    }
    const result = await transferRepo({ token: account.token, owner, name, newOwner });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `GET /releases`.
   * @param {{owner: string, repo: string}} query
   * @returns {Promise<object>}
   */
  async releases(query) {
    const account = await this.#requireAccount();
    const owner = requireString(query, 'owner', ' owner');
    const repo = requireString(query, 'repo', '仓库名称');
    const result = await listReleases({ token: account.token, owner, repo });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /releases`.
   * @param {object} body
   * @returns {Promise<object>}
   */
  async releaseCreate(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const repo = requireString(body, 'repo', '仓库名称');
    const tagName = requireString(body, 'tagName', '标签名');
    const result = await createRelease({
      token: account.token,
      owner,
      repo,
      tagName,
      name: optionalString(body.name),
      body: optionalString(body.body),
      target: optionalString(body.target),
      draft: optionalBool(body.draft, false),
      prerelease: optionalBool(body.prerelease, false),
    });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `GET /contributions` — the active account's contribution calendar.
   *
   * `login` defaults to the ACTIVE account so the panel can ask with no
   * arguments; naming another user is allowed because GitHub's calendar is
   * public for public activity. A token without `read:user` resolves to
   * `{unavailable:true}` rather than an error, so the page keeps rendering.
   *
   * @param {{login?: string, days?: string|number}} query
   * @returns {Promise<object>}
   */
  async contributions(query) {
    const account = await this.#requireAccount();
    const login = optionalString(query.login) ?? account.login;
    const result = await fetchContributions({
      token: account.token,
      login,
      days: clampInt(query.days, 1, 365, 365),
    });
    // A scope-denied answer never reached GitHub's data, so it is not "use".
    if (result.unavailable !== true) await this.#touch(account.id);
    return result;
  }

  /**
   * `GET /notifications` — recent notification threads ("最近消息").
   * @param {{all?: string, limit?: string|number}} query
   * @returns {Promise<{items: object[], unreadCount: number}>}
   */
  async notifications(query) {
    const account = await this.#requireAccount();
    const result = await listNotifications({
      token: account.token,
      // Query strings carry text, so `true`/`1` are the accepted truthy forms;
      // anything else means "unread only", which is GitHub's own default.
      all: query.all === 'true' || query.all === '1',
      limit: clampInt(query.limit, 1, 50, 30),
    });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `POST /notifications/read` — mark one thread read.
   * @param {{id: string}} body
   * @returns {Promise<{read: true}>}
   */
  async notificationRead(body) {
    const account = await this.#requireAccount();
    const id = requireString(body, 'id', '通知 id');
    const result = await markNotificationRead({ token: account.token, id });
    await this.#touch(account.id);
    return result;
  }

  /* ---------------- CONTRACT §3: local repository ---------------- */

  /**
   * `GET /local/status`.
   *
   * A directory that is not a repository is a NORMAL answer here
   * (`isRepo:false`), not an error: the sidebar's Git tab is opened on arbitrary
   * workspaces, most of which are not repositories.
   * @param {string} path
   * @returns {Promise<object>}
   */
  async localStatus(path) {
    const target = requireString({ path }, 'path', '仓库路径');
    const settings = await this.#store.settings();
    const runner = new GitRunner({ gitPath: settings.gitPath });
    const secrets = await this.#secrets();
    const probe = await runner.probe();
    if (!probe.available) {
      throw new GitError(
        'GIT_MISSING',
        `找不到可用的 git（当前使用 ${runner.binary}）。请安装 Git，或在插件设置里填写「git 路径」。`,
      );
    }
    try {
      return await runner.status(target, { defaultRemote: settings.defaultRemote, secrets });
    } catch (error) {
      // ONLY "not a repository" degrades to the empty document. A bad argument
      // (a relative path, say) must still be reported: silently answering
      // "not a repo" would hide the real problem from the panel.
      if (error?.code === 'NOT_A_REPO') return emptyStatus();
      throw error;
    }
  }

  /**
   * `GET /local/log`.
   * @param {{path: string, limit?: string|number, ref?: string}} query
   * @returns {Promise<object>}
   */
  async localLog(query) {
    const path = requireString(query, 'path', '仓库路径');
    const settings = await this.#store.settings();
    const runner = new GitRunner({ gitPath: settings.gitPath });
    return runner.log(path, {
      limit: clampInt(query.limit, 1, 500, 60),
      ref: optionalString(query.ref),
      secrets: await this.#secrets(),
    });
  }

  /**
   * `GET /local/diff`.
   * @param {{path: string, file: string, staged?: string}} query
   * @returns {Promise<object>}
   */
  async localDiff(query) {
    const path = requireString(query, 'path', '仓库路径');
    const file = requireString(query, 'file', '文件路径');
    const settings = await this.#store.settings();
    const runner = new GitRunner({ gitPath: settings.gitPath });
    return runner.diff(path, {
      file,
      staged: query.staged === 'true' || query.staged === '1',
      secrets: await this.#secrets(),
    });
  }

  /**
   * `GET /local/commit`.
   * @param {{path: string, sha: string}} query
   * @returns {Promise<object>}
   */
  async localCommitDetail(query) {
    const path = requireString(query, 'path', '仓库路径');
    const sha = requireString(query, 'sha', '提交 SHA');
    const settings = await this.#store.settings();
    const runner = new GitRunner({ gitPath: settings.gitPath });
    return runner.commitDetail(path, { sha, secrets: await this.#secrets() });
  }

  /**
   * `GET /local/remotes`.
   * @param {{path: string}} query
   * @returns {Promise<object>}
   */
  async localRemotes(query) {
    const path = requireString(query, 'path', '仓库路径');
    const settings = await this.#store.settings();
    const runner = new GitRunner({ gitPath: settings.gitPath });
    return runner.remotes(path, { secrets: await this.#secrets() });
  }

  /**
   * The token to attach to one network command, if any.
   *
   * A GitHub **https** remote is authenticated with the active account's token;
   * an ssh remote must NOT get one (git+ssh has its own auth and an injected
   * header would be meaningless). A missing account on an https GitHub remote
   * is reported as NO_ACCOUNT rather than letting git fail with a credential
   * prompt that cannot appear.
   *
   * @param {GitRunner} runner
   * @param {string} path
   * @param {string} remote
   * @returns {Promise<string|undefined>}
   */
  async #tokenForRemote(runner, path, remote) {
    let remotes;
    try {
      remotes = (await runner.remotes(path)).remotes;
    } catch {
      // A repository whose remotes cannot be read gets no token; git's own
      // error is clearer than anything invented here.
      return undefined;
    }
    const target = remotes.find((row) => row.name === remote);
    if (!target || !isGithubUrl(target.url)) return undefined;
    if (!/^https?:/i.test(target.url)) return undefined;
    // The remote's URL is quoted (it is not a secret) because it is what tells
    // the user WHICH remote needs an account.
    return this.#githubHttpsToken(`远端 ${remote}`, `（${target.url}）`);
  }

  /**
   * The active account's token, requiring an account to exist.
   *
   * Shared by the remote-name path and the by-URL path (CONTRACT §3b): an
   * anonymous https push to GitHub is pointless — it can only fail with a
   * credential prompt that this Host deliberately never shows — so both paths
   * fail early with an actionable NO_ACCOUNT.
   *
   * @param {string} what names the destination in the Chinese message.
   * @param {string} [detail] an extra parenthetical (the URL, already scrubbed
   *   by the caller — real tokens never reach this argument).
   * @returns {Promise<string>}
   */
  async #githubHttpsToken(what, detail = '') {
    const account = await this.#store.activeAccount();
    if (!account) {
      throw httpError(
        400,
        'NO_ACCOUNT',
        `${what} 指向 GitHub${detail}，需要先在设置里登录一个 GitHub 账号才能认证。`,
      );
    }
    return account.token;
  }

  /** Build a runner from the live settings (shared by every local route). */
  async #runnerAndSecrets() {
    const settings = await this.#store.settings();
    return {
      settings,
      runner: new GitRunner({ gitPath: settings.gitPath }),
      secrets: await this.#secrets(),
    };
  }

  /**
   * The remote a network route should use.
   *
   * The body's `remote` wins; otherwise `settings.defaultRemote` — which exists
   * precisely so a user whose repositories all use `upstream` does not have to
   * name it on every click — and `origin` only as the last resort.
   *
   * @param {string|undefined} requested the body's `remote`.
   * @param {string} defaultRemote the settings value.
   * @returns {string}
   */
  #pickRemote(requested, defaultRemote) {
    const explicit = optionalString(requested);
    if (explicit !== undefined) return explicit;
    const fallback = optionalString(defaultRemote);
    return fallback ?? 'origin';
  }

  /**
   * `POST /local/init`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localInit(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const initOut = await runner.init(path, { secrets });
    let output = initOut.output;
    if (optionalBool(body.createRemote, false)) {
      const account = await this.#requireAccount();
      // The name defaults to the directory's own name, which is what a
      // "create the GitHub repo for this folder" button means.
      const name = optionalString(body.name)
        ?? initOut.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        ?? '';
      if (name === '') throw httpError(400, 'BAD_REQUEST', '缺少仓库名称');
      const created = await createRepo({
        token: account.token,
        name,
        owner: optionalString(body.owner),
        login: account.login,
        private: optionalBool(body.private, true),
        description: '',
        autoInit: false,
      });
      await this.#touch(account.id);
      const remoteName = optionalString(body.remoteName) ?? 'origin';
      const remoteOut = await runner.setRemote(initOut.root, {
        name: remoteName,
        url: created.repo.cloneUrl,
        secrets,
      });
      output += remoteOut.output;
    }
    // Stage everything but do NOT commit: the first commit message is the
    // user's decision, and the contract says so explicitly.
    const staged = await runner.stageAll(initOut.root, { secrets });
    return { output: output + staged.output };
  }

  /**
   * `POST /local/remote`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localSetRemote(body) {
    const path = requireString(body, 'path', '仓库路径');
    const url = requireString(body, 'url', '远端地址');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const name = optionalString(body.name) ?? 'origin';
    // The contract asks this route to resolve owner/repo for a GitHub URL. The
    // response may only carry `output`, so the resolution is used for the one
    // thing it can do here: reject a GitHub URL that names no repository
    // (`https://github.com/`, `https://github.com/owner`), which git would
    // otherwise store happily and every later push would fail against.
    if (isGithubUrl(url) && parseGithubRemote(url) === null) {
      throw httpError(400, 'BAD_REQUEST', `无法从 ${url} 解析出 GitHub 仓库（需要 owner/repo 两段）。`);
    }
    const result = await runner.setRemote(path, { name, url, secrets });
    return { output: result.output };
  }

  /**
   * `POST /local/fetch`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localFetch(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { settings, runner, secrets } = await this.#runnerAndSecrets();
    const remote = this.#pickRemote(body.remote, settings.defaultRemote);
    const token = await this.#tokenForRemote(runner, path, remote);
    const result = await runner.fetch(path, {
      remote,
      prune: optionalBool(body.prune, false),
      token,
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/pull`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localPull(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { settings, runner, secrets } = await this.#runnerAndSecrets();
    const remote = this.#pickRemote(body.remote, settings.defaultRemote);
    const token = await this.#tokenForRemote(runner, path, remote);
    const result = await runner.pull(path, {
      remote,
      branch: optionalString(body.branch),
      rebase: optionalBool(body.rebase, false),
      token,
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/push` — CONTRACT §3b aware.
   *
   * DESTINATION RESOLUTION (in order, the first one that applies wins):
   *
   *  1. `target: {owner, repo}` — an existing remote that already points at
   *     that repository is REUSED (so `.git/config` is untouched AND the push
   *     gets the remote's own refspec/upstream behaviour); otherwise the push
   *     goes straight to the constructed https URL. The URL form is the
   *     contract's "never pollute the user's .git/config" rule; the token
   *     rides along as a per-invocation header and is never written anywhere.
   *  2. `remote: '<name>'` — the pre-§3b behaviour, unchanged.
   *  3. Neither → the remembered target for this branch, then
   *     `settings.defaultRemote`, then `origin`.
   *
   * MEMORY: only a SUCCESSFUL push is recorded, and `remember: false` opts out.
   * The key is `(normalizedRepoRoot, branch)` — see store.js.
   *
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localPush(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { settings, runner, secrets } = await this.#runnerAndSecrets();

    // The root is resolved ONCE and reused: `assertRepo` costs three git spawns
    // and every helper below would otherwise repeat it.
    const root = (await runner.assertRepo(path, { secrets })).root;
    // The branch is needed THREE times here (memory lookup, refspec, memory
    // write), so it is resolved once. An explicit body.branch wins; otherwise
    // the branch HEAD points at; a detached HEAD leaves it null.
    const requestedBranch = optionalString(body.branch);
    const branch = requestedBranch ?? (await runner.currentBranch(path, { secrets, root }));

    const target = await this.#resolvePushTarget({
      runner,
      path,
      root,
      branch,
      settings,
      body,
      secrets,
    });

    // A URL push has no configured merge ref, so it NEEDS an explicit refspec.
    // With a detached HEAD and no `branch` there is no name to push, and git's
    // own error ("You are not currently on a branch") arrives only after the
    // network handshake — failing here is faster and says what to do.
    if (target.url !== undefined && branch === null && requestedBranch === undefined) {
      throw httpError(
        400,
        'BAD_REQUEST',
        '当前处于分离 HEAD 状态，直接推送到 GitHub 仓库需要指定分支名（branch）。',
      );
    }

    const result = await runner.push(path, {
      remote: target.url === undefined ? target.remote : undefined,
      url: target.url,
      // NAMED REMOTE: the body's branch, exactly as before — omitting it lets
      // git apply `push.default`/the configured upstream, which is the
      // behaviour the existing route has always had.
      // URL: a URL has no configured merge ref, so the RESOLVED branch (the
      // body's value, else the branch HEAD points at) must be sent as the
      // refspec; otherwise `git push <url>` has nothing to push.
      branch: target.url === undefined ? requestedBranch : (branch ?? undefined),
      // WHAT LEAVES the repository. Defaults to the branch, but the panel may
      // ask for a specific version — a commit sha or a tag — which git accepts
      // as a push source as long as a destination branch is named with it.
      source: optionalString(body.source),
      force: optionalBool(body.force, false),
      setUpstream: optionalBool(body.setUpstream, true),
      tags: optionalBool(body.tags, false),
      token: target.token,
      secrets,
    });

    // Recorded only after the push actually succeeded: a failed push must not
    // change what the next click defaults to.
    if (optionalBool(body.remember, true) !== false) {
      try {
        await this.#store.rememberPushTarget(root, branch, {
          remote: target.remote,
          owner: target.owner,
          repo: target.repo,
          ref: branch ?? '',
          at: new Date().toISOString(),
        });
      } catch {
        // Bookkeeping must never fail a push the user just completed.
      }
    }
    return { output: result.output };
  }

  /**
   * Decide WHERE and WITH WHICH CREDENTIAL one `/local/push` should go.
   *
   * Split out of {@link localPush} because the decision has four inputs and two
   * outputs (destination + token) and is the whole point of CONTRACT §3b.
   *
   * @param {object} options
   * @returns {Promise<{remote: string, url?: string, token?: string,
   *   owner: string, repo: string}>}
   */
  async #resolvePushTarget({ runner, path, root, branch, settings, body, secrets }) {
    const target = body.target && typeof body.target === 'object' ? body.target : null;

    /* 1. An explicit GitHub repository. */
    if (target) {
      const owner = requireString(target, 'owner', '目标仓库的 owner');
      const repo = requireString(target, 'repo', '目标仓库名称');
      // Reuse a remote that ALREADY points at this repository. Matching is
      // case-insensitive because GitHub owners/repos are.
      const matched = await this.#remoteForRepo(runner, path, owner, repo, secrets);
      if (matched) {
        // The reused remote keeps ITS OWN transport: an ssh remote gets no
        // token (and needs no account), an https one gets the header.
        const token = await this.#tokenForRemote(runner, path, matched.name);
        return { remote: matched.name, token, owner, repo };
      }
      // No remote → push to the URL directly. `x-access-token` is the
      // documented https username; the TOKEN itself is never part of the URL
      // (it would leak through argv, git's error output and any proxy log).
      const token = await this.#githubHttpsToken(`目标仓库 ${owner}/${repo}`);
      return { remote: '', url: githubPushUrl(owner, repo), token, owner, repo };
    }

    /* 2. A named remote. */
    const explicitRemote = optionalString(body.remote);
    if (explicitRemote !== undefined) {
      const token = await this.#tokenForRemote(runner, path, explicitRemote);
      const parsed = await this.#remoteRepo(runner, path, explicitRemote, secrets);
      return {
        remote: explicitRemote,
        token,
        owner: parsed?.owner ?? '',
        repo: parsed?.repo ?? '',
      };
    }

    /* 3a. The remembered target for THIS branch. */
    if (branch !== null) {
      const memory = await this.#store.pushMemoryFor(root, branch);
      if (memory) {
        const remotes = await this.#safeRemotes(runner, path, secrets);
        // A remembered remote may have been renamed or removed since; only
        // reuse it when it still exists, otherwise fall back to the URL that
        // was recorded (it is derived from owner/repo, so nothing is lost).
        const stillThere = memory.remote !== '' && remotes.some((row) => row.name === memory.remote);
        if (stillThere) {
          const token = await this.#tokenForRemote(runner, path, memory.remote);
          return { remote: memory.remote, token, owner: memory.owner, repo: memory.repo };
        }
        if (memory.owner !== '' && memory.repo !== '') {
          // The remembered destination was a by-URL push, or its remote is
          // gone: go back to the same repository, still without touching the
          // configuration.
          const token = await this.#githubHttpsToken(`记忆的目标仓库 ${memory.owner}/${memory.repo}`);
          return {
            remote: '',
            url: githubPushUrl(memory.owner, memory.repo),
            token,
            owner: memory.owner,
            repo: memory.repo,
          };
        }
      }
    }

    /* 3b. `settings.defaultRemote`, then `origin`. */
    const remote = this.#pickRemote(undefined, settings.defaultRemote);
    const token = await this.#tokenForRemote(runner, path, remote);
    const parsed = await this.#remoteRepo(runner, path, remote, secrets);
    return { remote, token, owner: parsed?.owner ?? '', repo: parsed?.repo ?? '' };
  }

  /**
   * `git remote -v` as an array, or `[]` when the repository cannot answer.
   *
   * `secrets` is passed through so a remote URL that embeds a credential
   * (`https://user:TOKEN@github.com/…`, which a user can create by hand) is
   * scrubbed by the runner before it can reach `/push/targets`'s response.
   */
  async #safeRemotes(runner, path, secrets) {
    try {
      return (await runner.remotes(path, { secrets })).remotes;
    } catch {
      return [];
    }
  }

  /** The `{owner, repo}` one named remote points at, or null. */
  async #remoteRepo(runner, path, remote, secrets) {
    const remotes = await this.#safeRemotes(runner, path, secrets);
    const row = remotes.find((candidate) => candidate.name === remote);
    return row ? parseGithubRemote(row.url) : null;
  }

  /**
   * The first remote whose GitHub URL names `owner/repo`, or null.
   *
   * Redaction does not break the match: it only masks the userinfo segment
   * (`https://***@github.com/o/r.git`), and `parseGithubRemote` reads the path.
   */
  async #remoteForRepo(runner, path, owner, repo, secrets) {
    const remotes = await this.#safeRemotes(runner, path, secrets);
    for (const row of remotes) {
      const parsed = parseGithubRemote(row.url);
      if (!parsed) continue;
      if (parsed.owner.toLowerCase() === owner.toLowerCase()
        && parsed.repo.toLowerCase() === repo.toLowerCase()) {
        return row;
      }
    }
    return null;
  }

  /**
   * `GET /push/targets` — the push-target picker's candidate document
   * (CONTRACT §3b).
   *
   * A directory that is not a repository answers the empty document instead of
   * failing: the picker is rendered next to the local-status panel, which is
   * routinely opened on a non-repository workspace.
   *
   * @param {{path: string}} query
   * @returns {Promise<object>}
   */
  async pushTargets(query) {
    const path = requireString(query, 'path', '仓库路径');
    const { runner, secrets } = await this.#runnerAndSecrets();
    let root;
    try {
      root = (await runner.assertRepo(path, { secrets })).root;
    } catch (error) {
      if (error?.code === 'NOT_A_REPO') {
        return { remotes: [], memory: null, branch: null, repoRoot: null };
      }
      throw error;
    }
    const [remotes, branch] = await Promise.all([
      this.#safeRemotes(runner, path, secrets),
      runner.currentBranch(path, { secrets }),
    ]);
    const memory = branch === null ? null : await this.#store.pushMemoryFor(root, branch);
    return {
      remotes: remotes.map((row) => {
        const parsed = parseGithubRemote(row.url);
        return {
          name: row.name,
          url: row.url,
          owner: parsed?.owner ?? null,
          repo: parsed?.repo ?? null,
        };
      }),
      memory,
      branch,
      repoRoot: root,
    };
  }

  /**
   * `GET /push/remotes` — the picker's GitHub repository search (CONTRACT §3b).
   *
   * Deliberately a SEPARATE mapper from `/repos`: the picker only needs enough
   * to build a push destination, and reusing the full `RemoteRepo` shape here
   * would send permissions/avatars the picker never draws.
   *
   * @param {{q?: string, page?: string|number}} query
   * @returns {Promise<{items: object[], page: number, hasMore: boolean}>}
   */
  async pushRemotes(query) {
    const account = await this.#requireAccount();
    const page = clampInt(query.page, 1, 1000, 1);
    const q = optionalString(query.q);
    const result = q
      ? await searchRepos({ token: account.token, login: account.login, q, page })
      : await listRepos({ token: account.token, page });
    await this.#touch(account.id);
    return {
      items: result.items.map((repo) => ({
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        cloneUrl: repo.cloneUrl,
        sshUrl: repo.sshUrl,
        htmlUrl: repo.htmlUrl,
      })),
      page: result.page,
      hasMore: result.hasMore,
    };
  }

  /**
   * `GET /push/memory` — every remembered target for one repository
   * (CONTRACT §3b, debug view).
   *
   * @param {{path: string}} query
   * @returns {Promise<{entries: object[]}>}
   */
  async pushMemory(query) {
    const path = requireString(query, 'path', '仓库路径');
    const { runner, secrets } = await this.#runnerAndSecrets();
    let root;
    try {
      root = (await runner.assertRepo(path, { secrets })).root;
    } catch (error) {
      if (error?.code === 'NOT_A_REPO') return { entries: [] };
      throw error;
    }
    return { entries: await this.#store.pushMemoryEntries(root) };
  }

  /**
   * `POST /local/push/target/forget` — drop one branch's remembered target.
   *
   * Not in CONTRACT §3b's table, and OPTIONAL for the client: it exists because
   * a remembered target that has become wrong (pushed to the wrong fork once)
   * would otherwise be permanent from inside the panel.
   *
   * @param {object} body
   * @returns {Promise<{forgotten: boolean}>}
   */
  async localForgetPushTarget(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const root = (await runner.assertRepo(path, { secrets })).root;
    const branch = optionalString(body.branch)
      ?? (await runner.currentBranch(path, { secrets }));
    if (branch === null) throw httpError(400, 'BAD_REQUEST', '当前处于分离 HEAD 状态，请指定分支名');
    return { forgotten: await this.#store.forgetPushTarget(root, branch) };
  }

  /**
   * `POST /local/commit`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localCommit(body) {
    const path = requireString(body, 'path', '仓库路径');
    const message = requireString(body, 'message', '提交信息');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const files = Array.isArray(body.files)
      ? body.files.filter((file) => typeof file === 'string' && file !== '')
      : undefined;
    const result = await runner.commit(path, {
      message,
      all: optionalBool(body.all, true),
      files,
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/checkout`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localCheckout(body) {
    const path = requireString(body, 'path', '仓库路径');
    const ref = requireString(body, 'ref', '要切换的分支或提交');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.checkout(path, {
      ref,
      create: optionalBool(body.create, false),
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/branch`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localBranch(body) {
    const path = requireString(body, 'path', '仓库路径');
    const name = requireString(body, 'name', '分支名');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.createBranch(path, {
      name,
      from: optionalString(body.from),
      checkout: optionalBool(body.checkout, true),
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/branch/delete`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localBranchDelete(body) {
    const path = requireString(body, 'path', '仓库路径');
    const name = requireString(body, 'name', '分支名');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.deleteBranch(path, {
      name,
      force: optionalBool(body.force, false),
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/merge`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localMerge(body) {
    const path = requireString(body, 'path', '仓库路径');
    const ref = requireString(body, 'ref', '要合并的分支或提交');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.merge(path, { ref, secrets });
    return { output: result.output };
  }

  /**
   * `POST /local/reset` — `mode: 'hard'` is destructive, so it needs `confirm`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localReset(body) {
    const path = requireString(body, 'path', '仓库路径');
    const mode = body.mode === 'soft' || body.mode === 'hard' ? body.mode : 'mixed';
    if (mode === 'hard' && optionalBool(body.confirm, false) !== true) {
      throw httpError(409, 'CONFLICT', '硬重置会永久丢弃所有未提交的改动，请确认后再执行（confirm: true）。');
    }
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.reset(path, {
      ref: optionalString(body.ref) ?? 'HEAD',
      mode,
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/revert` and `POST /local/revert-commit`.
   *
   * Both routes undo one commit by REVERTING it (a new commit), never by
   * rewinding history: the contract's two rows describe the same undo, and the
   * non-destructive form is the one that cannot lose already-pushed work.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localRevert(body) {
    const path = requireString(body, 'path', '仓库路径');
    const sha = requireString(body, 'sha', '提交 SHA');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.revert(path, { sha, secrets });
    return { output: result.output };
  }

  /**
   * `POST /local/tag`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localTag(body) {
    const path = requireString(body, 'path', '仓库路径');
    const name = requireString(body, 'name', '标签名');
    const { settings, runner, secrets } = await this.#runnerAndSecrets();
    const remote = this.#pickRemote(body.remote, settings.defaultRemote);
    const wantsPush = optionalBool(body.push, false);
    const token = wantsPush ? await this.#tokenForRemote(runner, path, remote) : undefined;
    const result = await runner.tag(path, {
      name,
      ref: optionalString(body.ref) ?? 'HEAD',
      push: wantsPush,
      remote,
      token,
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/stash`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localStash(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.stash(path, {
      message: optionalString(body.message),
      includeUntracked: optionalBool(body.includeUntracked, true),
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/stash/pop`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localStashPop(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.stashPop(path, {
      index: clampInt(body.index, 0, 999, 0),
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/restore`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localRestore(body) {
    const path = requireString(body, 'path', '仓库路径');
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) throw httpError(400, 'BAD_REQUEST', '缺少要还原的文件');
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.restore(path, {
      files,
      staged: optionalBool(body.staged, false),
      secrets,
    });
    return { output: result.output };
  }

  /**
   * `POST /local/discard-all` — destructive; requires `confirm: true`.
   * @param {object} body
   * @returns {Promise<{output: string}>}
   */
  async localDiscardAll(body) {
    const path = requireString(body, 'path', '仓库路径');
    if (optionalBool(body.confirm, false) !== true) {
      throw httpError(409, 'CONFLICT', '丢弃全部改动会永久删除所有未提交内容（含未跟踪文件），请确认后再执行（confirm: true）。');
    }
    const { runner, secrets } = await this.#runnerAndSecrets();
    const result = await runner.discardAll(path, { secrets });
    return { output: result.output };
  }

  /* ---------------- CONTRACT §4: the agent tool ---------------- */

  /**
   * One `github_link` tool call. Every arm delegates to a method above, so the
   * model and the browser can never diverge.
   *
   * @param {{action: string, path?: string, message?: string, remote?: string,
   *   branch?: string, limit?: number, force?: boolean, q?: string,
   *   page?: number}} args
   * @param {{resolvePath?: () => Promise<string>}} context
   * @returns {Promise<object>} the tool's canonical output value.
   */
  /**
   * Which repository a tool-initiated release should land in.
   *
   * An explicit owner/repo wins; otherwise the working directory's own GitHub
   * remote decides, because "publish this checkout" is what the caller means.
   * Guessing a repository would be worse than failing, so an unattached
   * directory gets a clear instruction instead.
   *
   * @param {string} path repository path.
   * @param {object} args tool arguments (`owner`, `repo`).
   * @returns {Promise<{owner: string, repo: string}>}
   */
  async #toolReleaseTarget(path, args) {
    const explicitOwner = optionalString(args?.owner);
    const explicitRepo = optionalString(args?.repo);
    if (explicitOwner && explicitRepo) return { owner: explicitOwner, repo: explicitRepo };
    const status = await this.localStatus(path);
    if (!status.isRepo) {
      throw httpError(400, 'NOT_A_REPO', `${status.root ?? path} 不是 Git 仓库，无法推断要发布到哪个仓库。`);
    }
    if (status.githubRemote && status.githubRemote.owner && status.githubRemote.repo) {
      return { owner: status.githubRemote.owner, repo: status.githubRemote.repo };
    }
    throw httpError(
      400,
      'BAD_REQUEST',
      '当前工作区没有关联 GitHub 远端，无法推断要发布到哪个仓库；请传 owner 与 repo，或先用 /local/remote 关联远端。',
    );
  }

  async toolCall(args, context = {}) {
    const action = String(args?.action ?? '');
    const cwd = async () => {
      const explicit = optionalString(args?.path);
      if (explicit) return explicit;
      if (typeof context.resolvePath === 'function') {
        const resolved = await context.resolvePath();
        if (typeof resolved === 'string' && resolved !== '') return resolved;
      }
      return process.cwd();
    };
    switch (action) {
      case 'status': {
        return { action, status: await this.localStatus(await cwd()) };
      }
      case 'log': {
        const window = await this.localLog({ path: await cwd(), limit: args?.limit });
        return { action, ...window };
      }
      case 'push': {
        // A named repository replaces the local remote, matching what the
        // panel's picker does; without this the agent could only push to a
        // remote a human had already configured.
        const owner = optionalString(args?.owner);
        const repo = optionalString(args?.repo);
        const target = owner && repo ? { owner, repo } : undefined;
        const result = await this.localPush({
          path: await cwd(),
          remote: target ? undefined : optionalString(args?.remote),
          target,
          branch: optionalString(args?.branch),
          force: optionalBool(args?.force, false),
        });
        return { action, output: result.output };
      }
      case 'pull': {
        const result = await this.localPull({
          path: await cwd(),
          remote: optionalString(args?.remote),
          branch: optionalString(args?.branch),
        });
        return { action, output: result.output };
      }
      case 'commit': {
        const result = await this.localCommit({
          path: await cwd(),
          message: requireString(args, 'message', '提交信息'),
          all: true,
        });
        return { action, output: result.output };
      }
      case 'repos': {
        const result = await this.repos({ page: args?.page, q: optionalString(args?.q) });
        return {
          action,
          page: result.page,
          hasMore: result.hasMore,
          repos: result.items.map((repo) => ({
            fullName: repo.fullName,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            updatedAt: repo.updatedAt,
            htmlUrl: repo.htmlUrl,
          })),
        };
      }
      case 'accounts': {
        const state = await this.state();
        return {
          action,
          activeAccountId: state.activeAccountId,
          accounts: state.accounts.map((account) => ({
            id: account.id,
            login: account.login,
            tokenKind: account.tokenKind,
            scopes: account.scopes,
          })),
        };
      }
      case 'create_repo': {
        // Creating the remote is what makes the very first push possible, so
        // the agent needs it: without this it could only push to a repository
        // a human had already made by hand.
        const result = await this.repoCreate({
          name: requireString(args, 'repoName', '仓库名'),
          private: optionalBool(args?.isPrivate, true),
          description: optionalString(args?.description) ?? '',
          autoInit: optionalBool(args?.autoInit, false),
        });
        return {
          action,
          repo: {
            fullName: result.repo.fullName,
            private: result.repo.private,
            defaultBranch: result.repo.defaultBranch,
            htmlUrl: result.repo.htmlUrl,
            cloneUrl: result.repo.cloneUrl,
          },
        };
      }
      case 'release': {
        // Which repository this lands in: the argument, else the GitHub remote
        // the working directory is already attached to. Resolving it from the
        // remote is what lets the agent "publish this checkout".
        const tagName = requireString(args, 'tagName', '标签名');
        const target = await this.#toolReleaseTarget(await cwd(), args);
        const result = await this.releaseCreate({
          owner: target.owner,
          repo: target.repo,
          tagName,
          name: optionalString(args?.releaseName) ?? tagName,
          body: optionalString(args?.releaseBody) ?? '',
          target: optionalString(args?.branch),
          draft: optionalBool(args?.draft, false),
          prerelease: optionalBool(args?.prerelease, false),
        });
        return {
          action,
          release: {
            id: result.release.id,
            tagName: result.release.tagName,
            name: result.release.name,
            draft: result.release.draft,
            htmlUrl: result.release.htmlUrl,
          },
        };
      }
      case 'review': {
        // NEVER run a review on the model's own initiative: the user must see
        // the dialog and choose what is inspected. Record a request; the panel
        // picks it up and opens the normal review dialog.
        const presetIds = Array.isArray(args?.presetIds)
          ? args.presetIds.filter((id) => typeof id === 'string' && id !== '')
          : [];
        const raised = this.#raiseReviewRequest({
          path: await cwd(),
          presetIds,
          customPrompt: optionalString(args?.customPrompt) ?? '',
          source: 'agent',
        });
        return { action, reviewRequest: raised };
      }
      default:
        throw httpError(
          400,
          'BAD_REQUEST',
          `未知 action「${action}」；可用：status、log、push、pull、commit、repos、accounts、create_repo、release、review。`,
        );
    }
  }

  /* ---------------- repository information (languages + assets) ---------------- */

  /**
   * `GET /repos/languages` — the byte/percentage breakdown the cards bar uses.
   *
   * A failure here must not break a repository list, so a scope or network
   * problem degrades to an empty list with a warning rather than an error.
   *
   * @param {{owner: string, name: string}} query
   * @returns {Promise<{items: object[]}>}
   */
  async repoLanguages(query) {
    const account = await this.#requireAccount();
    const owner = requireString(query, 'owner', ' owner');
    const name = requireString(query, 'name', ' name');
    try {
      const result = await repoLanguages({ token: account.token, owner, name });
      await this.#touch(account.id);
      return result;
    } catch (error) {
      // Degrade: the card simply renders without the language bar.
      if (error && (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND')) {
        return { items: [], warning: '无法读取语言构成（权限或仓库不可见）。' };
      }
      throw error;
    }
  }

  /**
   * `POST /releases/asset/delete` — remove one uploaded asset.
   *
   * @param {object} body
   * @returns {Promise<{deleted: true}>}
   */
  async releaseAssetDelete(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', '仓库名称');
    const assetId = requireString(body, 'assetId', '附件 id');
    const result = await deleteReleaseAsset({
      token: account.token,
      owner,
      name,
      assetId,
    });
    await this.#touch(account.id);
    return result;
  }
  /**
   * `POST /releases/asset` — attach a file to a release.
   *
   * The body carries base64 because the transport is JSON. Uploads are the one
   * place where a size cap matters: GitHub rejects assets over 2 GB, and
   * buffering an arbitrary file in memory would be worse, so the cap is applied
   * here with a Chinese explanation.
   *
   * @param {object} body
   * @returns {Promise<{asset: object}>}
   */
  async releaseAssetUpload(body) {
    const account = await this.#requireAccount();
    const owner = requireString(body, 'owner', ' owner');
    const name = requireString(body, 'name', '仓库名称');
    const releaseId = requireString(body, 'releaseId', '发布 id');
    const fileName = requireString(body, 'fileName', '文件名');
    const base64 = requireString(body, 'base64', '文件内容');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw httpError(400, 'BAD_REQUEST', '文件内容为空。');
    const MAX_BYTES = 200 * 1024 * 1024;
    if (bytes.length > MAX_BYTES) {
      throw httpError(
        400,
        'BAD_REQUEST',
        `附件超过 ${MAX_BYTES / 1024 / 1024} MB，请改用更小的文件或分卷发布。`,
      );
    }
    const result = await uploadReleaseAsset({
      token: account.token,
      owner,
      name,
      releaseId,
      fileName,
      bytes,
      contentType: optionalString(body.contentType),
    });
    await this.#touch(account.id);
    return result;
  }

  /**
   * `GET /diagnostics` — why can (or can't) the agent call this plugin?
   *
   * The agent tool is an optional surface, and a registration failure is
   * otherwise invisible: the model simply never sees the tool. This reports
   * the recorded outcome plus a live probe, so the answer is a fact rather
   * than a guess.
   *
   * @returns {Promise<object>}
   */
  async diagnostics() {
    const ctx = this.ctx;
    let tools = null;
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools;
    } catch {
      tools = null;
    }
    let visible = false;
    let toolNames = [];
    if (tools && typeof tools.get === 'function') {
      try {
        visible = Boolean(tools.get('github_link'));
      } catch {
        visible = false;
      }
    }
    if (tools && typeof tools.schemas === 'function') {
      try {
        toolNames = (tools.schemas() || [])
          .map((schema) => (schema && schema.name ? schema.name : ''))
          .filter((name) => name === 'github_link');
      } catch {
        toolNames = [];
      }
    }
    return {
      toolsService: tools ? 'present' : 'absent',
      tool: {
        name: 'github_link',
        attempted: toolRegistration.attempted,
        registered: toolRegistration.registered,
        visible,
        inSchemas: toolNames.length > 0,
        error: toolRegistration.error,
      },
    };
  }
  /* ---------------- review request gate (agent must ask a human) ---------------- */

  /**
   * Record an agent-initiated review request for the panel to confirm.
   *
   * One slot only. A second request while one is waiting is answered with
   * `alreadyPending`, which is what stops an agent from re-requesting in a
   * loop when the user has simply not clicked yet.
   *
   * @param {{path: string, presetIds: string[], customPrompt: string, source: string}} request
   * @returns {object}
   */
  #raiseReviewRequest(request) {
    if (this.#reviewRequest) {
      return {
        status: 'already_pending',
        message: '已有一个待确认的审查请求，用户尚未在界面中确认。不要重复请求，也不要自行执行审查。',
        pending: this.#publicReviewRequest(),
      };
    }
    this.#reviewRequest = {
      id: `rvreq_${Date.now().toString(36)}`,
      path: String(request.path ?? ''),
      presetIds: Array.isArray(request.presetIds) ? request.presetIds : [],
      customPrompt: String(request.customPrompt ?? ''),
      source: String(request.source ?? 'agent'),
      createdAt: Date.now(),
    };
    return {
      status: 'awaiting_user',
      message: '已在界面中打开审查配置窗口，等待用户选择审查项。在用户确认并开始之前，不要再次调用 review，也不要用其他方式自行执行审查。',
      pending: this.#publicReviewRequest(),
    };
  }

  /** The pending request in a shape the client can render. */
  #publicReviewRequest() {
    const request = this.#reviewRequest;
    if (!request) return null;
    return {
      id: request.id,
      path: request.path,
      presetIds: [...request.presetIds],
      customPrompt: request.customPrompt,
      source: request.source,
      createdAt: request.createdAt,
    };
  }

  /**
   * `GET /review/pending` — what the panel polls to know it must open the dialog.
   * @returns {Promise<{pending: object|null}>}
   */
  async reviewPending() {
    return { pending: this.#publicReviewRequest() };
  }

  /**
   * `POST /review/pending/clear` — the user answered the request (started it,
   * or dismissed it). Clearing is what lets a later agent request raise a new
   * dialog instead of being swallowed by the dedupe guard.
   * @param {object} [body]
   * @returns {Promise<{cleared: boolean}>}
   */
  async reviewPendingClear(body) {
    const id = optionalString(body?.id);
    if (id !== undefined && this.#reviewRequest && this.#reviewRequest.id !== id) {
      return { cleared: false };
    }
    const had = this.#reviewRequest !== null;
    this.#reviewRequest = null;
    return { cleared: had };
  }

  /* ---------------- DevDock npm module (read-only) ---------------- */

  /**
   * `GET /npm/accounts` — npm accounts without their tokens.
   * @returns {Promise<object>}
   */
  async npmAccounts() {
    return this.#store.npmAccounts();
  }

  /**
   * `POST /npm/account` — verify a token against the registry, then store it.
   *
   * The token is checked BEFORE it is saved: storing an unverified token is
   * how a settings page ends up showing an account that cannot do anything.
   *
   * @param {object} body `{ token }`
   * @returns {Promise<object>}
   */
  async npmAccountAdd(body) {
    const token = requireString(body, 'token', 'npm 令牌').trim();
    const who = await npmWhoami({ token });
    const saved = await this.#store.saveNpmAccount({ login: who.login, token });
    return saved;
  }

  /**
   * `POST /npm/account/remove` — forget one npm account.
   * @param {object} body `{ id }`
   * @returns {Promise<{removed: boolean}>}
   */
  async npmAccountRemove(body) {
    const id = requireString(body, 'id', '账号 id');
    const removed = await this.#store.deleteNpmAccount(id);
    if (!removed) throw httpError(404, 'NOT_FOUND', '找不到这个 npm 账号，可能已被移除。');
    return { removed: true };
  }

  /**
   * `POST /npm/account/active` — switch the current npm account.
   * @param {object} body `{ id }`
   * @returns {Promise<{activeId: string}>}
   */
  async npmAccountActive(body) {
    const id = requireString(body, 'id', '账号 id');
    const ok = await this.#store.setActiveNpmAccount(id);
    if (!ok) throw httpError(404, 'NOT_FOUND', '找不到这个 npm 账号。');
    return { activeId: id };
  }

  /** 当前 npm 账号，缺失时给出可执行的提示而不是空结果。 */
  async #requireNpmAccount() {
    const account = await this.#store.activeNpmAccount();
    if (!account) {
      throw httpError(401, 'NO_ACCOUNT', '还没有登录 npm。请在设置 › npm 中添加一个 Granular Access Token。');
    }
    return account;
  }

  /**
   * `GET /npm/packages` — packages the current account maintains.
   * @param {object} query
   * @returns {Promise<object>}
   */
  async npmPackages(query) {
    const account = await this.#requireNpmAccount();
    const result = await npmSearchByMaintainer({
      token: account.token,
      login: account.login,
      size: Number.isFinite(query && query.size) ? Number(query.size) : 20,
      from: Number.isFinite(query && query.from) ? Number(query.from) : 0,
    });
    await this.#store.touchNpmAccount(account.id);
    return {
      login: account.login,
      items: result.items,
      total: result.total,
    };
  }

  /* ---------------- npm CLI: 初始化 / 打包 / 发布 ---------------- */

  /** @returns {NpmRunner} 复用同一个执行器（二进制与超时只解析一次）。 */
  #npmRunner() {
    if (!this.#npmRunnerCache) this.#npmRunnerCache = new NpmRunner();
    return this.#npmRunnerCache;
  }

  #npmRunnerCache = null;

  /**
   * `POST /npm/init` — 给一个还没有 package.json 的目录生成一份。
   *
   * 只在文件不存在时写，绝不覆盖：一个已有 package.json 的目录被意外
   * 重置，代价远大于省掉一次手动创建。
   *
   * @param {{path?: string, name?: string, version?: string}} body
   * @returns {Promise<object>}
   */
  async npmInit(body) {
    const dir = typeof body.path === 'string' && body.path.trim() !== ''
      ? body.path.trim()
      : process.cwd();
    const file = path.join(dir, 'package.json');

    try {
      await readFile(file, 'utf8');
      throw httpError(409, 'BAD_REQUEST', '这个目录已经有 package.json 了，不会覆盖它。');
    } catch (error) {
      if (error && error.code !== 'ENOENT' && !error.status) throw error;
      if (error && error.status) throw error;
    }

    // 默认包名取目录名：npm 只接受小写与有限字符，先规范化再判断。
    const fallback = path.basename(dir).toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^-+|-+$/g, '');
    const name = typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : (fallback === '' ? 'my-package' : fallback);
    const version = typeof body.version === 'string' && body.version.trim() !== ''
      ? body.version.trim()
      : '0.1.0';

    const doc = {
      name,
      version,
      description: '',
      main: 'index.js',
      scripts: { test: 'echo "no test specified" && exit 1' },
      keywords: [],
      license: 'MIT',
      files: ['index.js'],
    };

    try {
      await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    } catch (error) {
      throw httpError(500, 'INTERNAL', `无法写入 package.json：${error.message}`);
    }

    return { path: file, created: true, name, version };
  }

  /**
   * `GET /npm/pack` — 预演打包：npm 会收进哪些文件、多大。
   *
   * 只跑 `--dry-run`，不落任何文件。这是「打包审查」的数据来源。
   *
   * @param {{path?: string}} query
   * @returns {Promise<object>}
   */
  async npmPackInspect(query) {
    const dir = typeof query.path === 'string' && query.path.trim() !== ''
      ? query.path.trim()
      : process.cwd();
    const runner = this.#npmRunner();
    const result = await runner.run(['pack', '--dry-run', '--json'], { cwd: dir });
    const packed = mapPackResult(parsePackJson(result.stdout));
    return { ...packed, dryRun: true };
  }

  /**
   * `POST /npm/pack` — 真正生成 .tgz。
   *
   * @param {{path?: string}} body
   * @returns {Promise<object>}
   */
  async npmPack(body) {
    const dir = typeof body.path === 'string' && body.path.trim() !== ''
      ? body.path.trim()
      : process.cwd();
    const runner = this.#npmRunner();
    const result = await runner.run(['pack', '--json'], { cwd: dir });
    const packed = mapPackResult(parsePackJson(result.stdout));
    return { ...packed, dryRun: false, path: path.join(dir, packed.filename) };
  }

  /**
   * `POST /npm/review/run` — 发布前审查。
   *
   * 与 GitHub 的推送前审查共用预设、模型选择与结果结构；差别只在
   * 审查对象——这里是「npm pack 会打进去的文件」，而不是 git diff。
   *
   * @param {object} body `{ path, presetIds, customPrompt, provider, model,
   *   reasoningEffort, maxFiles }`
   * @returns {Promise<object>}
   */
  async npmPublishReview(body) {
    const dir = typeof body.path === 'string' && body.path.trim() !== ''
      ? body.path.trim()
      : process.cwd();

    // 1. npm 会打进去哪些文件——与打包面板同一数据源，结果必然一致。
    const runner = this.#npmRunner();
    const packed = mapPackResult(parsePackJson(
      (await runner.run(['pack', '--dry-run', '--json'], { cwd: dir })).stdout,
    ));

    // 2. 读这些文件的文本内容。二进制与超大文件跳过并记下原因。
    const maxFiles = Number.isFinite(body.maxFiles) ? Number(body.maxFiles) : 80;
    const maxBytes = MAX_FILE_BYTES;
    const files = [];
    const chunks = [];
    let truncated = false;

    for (const row of packed.files) {
      if (chunks.length >= maxFiles) { truncated = true; break; }
      const rel = row.path.replace(/\/$/, '');
      if (/(^|\/)(node_modules|\.git)\//.test(rel)) continue;
      if (row.size > maxBytes) {
        files.push({ path: rel, skipped: '文件过大' });
        truncated = true;
        continue;
      }
      let text;
      try {
        text = await readFile(path.join(dir, rel), 'utf8');
      } catch {
        files.push({ path: rel, skipped: '无法读取' });
        continue;
      }
      if (text.includes('\u0000')) {
        files.push({ path: rel, skipped: '二进制文件' });
        continue;
      }
      files.push({ path: rel });
      chunks.push({ path: rel, text });
    }

    // 3. 规则扫描：永远执行，免费且确定。
    const ruleFindings = [];
    for (const chunk of chunks) {
      ruleFindings.push(...scanSecrets(chunk.text, { file: chunk.path }));
    }

    // 4. 包完整性：这些不是「代码问题」，但发布前必须看见。
    if (packed.totalFiles === 0) {
      ruleFindings.push(normalizeFinding({
        severity: 'blocker',
        title: '包内没有任何文件',
        detail: 'npm pack 没有收集到文件，发布出去会是一个空包。检查 files 字段与 .npmignore。',
        file: 'package.json',
      }));
    }

    if (!packed.files.some((row) => /(^|\/)readme(\.md|\.txt)?$/i.test(row.path))) {
      ruleFindings.push(normalizeFinding({
        severity: 'medium',
        title: '包里没有 README',
        detail: 'npm 页面会没有任何说明文字，用户看到的是一个空白页。',
        file: 'README.md',
      }));
    }

    const sizeLimit = 10 * 1024 * 1024;
    if (packed.size !== null && packed.size > sizeLimit) {
      ruleFindings.push(normalizeFinding({
        severity: 'medium',
        title: '包体积偏大',
        detail: `压缩后 ${Math.round(packed.size / 1024)} KB。检查是否误把构建产物或测试数据打进来了。`,
        file: 'package.json',
      }));
    }

    // 5. 模型审查：与 reviewRun 同样的解析方式与调用形状。
    const presetIds = Array.isArray(body.presetIds)
      ? body.presetIds.filter((id) => typeof id === 'string' && id !== '')
      : [];
    const stored = await this.#store.reviewPresets();
    const chosen = [
      ...BUILTIN_PRESETS.filter((preset) => presetIds.includes(preset.id)),
      ...stored.filter((preset) => presetIds.includes(preset.id)),
    ];
    const customPrompt = optionalString(body.customPrompt) ?? '';

    const llm = this.#llm();
    let provider = optionalString(body.provider);
    let model = optionalString(body.model);
    if (llm && (!provider || !model)) {
      try {
        const fallback = await this.reviewModels();
        if (fallback.default) {
          provider = provider ?? fallback.default.provider;
          model = model ?? fallback.default.model;
        }
      } catch { /* 保留调用方给的值 */ }
    }

    const instructions = [
      ...chosen.map((preset) => `## ${preset.title}\n${preset.prompt}`),
      ...(customPrompt ? [`## 用户补充要求\n${customPrompt}`] : []),
    ].join('\n\n');

    /* 明确告诉模型它看的是什么、不是什么。少了这段，模型会把
     * 「没有出现在包里的文件」误报成「项目缺少文件」。 */
    const promptParts = [];
    if (instructions !== '') promptParts.push(instructions);
    promptParts.push('## 审查范围');
    promptParts.push('本次审查的是 npm 发布包的内容：以下文件就是 npm pack 会打进去的全部文件，'
      + '不代表项目里只有这些文件。未列出的文件不会随包发布，不要据此推断项目缺少文件。');
    promptParts.push(`## 包内文件（${files.length} 个，压缩后 ${packed.size ?? 0} 字节）`);
    promptParts.push(files.map((file) => `- ${file.path}${file.skipped ? `（未送审：${file.skipped}）` : ''}`).join('\n'));
    promptParts.push('## 内容');
    promptParts.push(chunks.length === 0
      ? '（没有可审查的文本内容）'
      : chunks.map((chunk) => `### ${chunk.path}\n\`\`\`\n${chunk.text}\n\`\`\``).join('\n\n'));

    if (truncated) {
      promptParts.push('严重提示：因体积或数量限制，本次内容并不完整。只针对你实际看到的内容报告问题。');
    }

    let modelFindings = [];
    let summary = '';
    let usage;
    let degraded = false;

    if (!llm) {
      degraded = true;
      summary = '宿主未提供 llm 服务，本次只执行了规则检查（敏感信息扫描）。';
    } else if (!provider || !model) {
      degraded = true;
      summary = '未找到可用的模型，本次只执行了规则检查（敏感信息扫描）。';
    } else if (chunks.length === 0) {
      summary = '包里没有可审查的文本内容。';
    } else {
      try {
        const result = await runModelReview(llm, {
          provider,
          model,
          reasoningEffort: optionalString(body.reasoningEffort),
          prompt: promptParts.join('\n\n'),
        });
        modelFindings = result.findings.map(normalizeFinding);
        summary = result.summary;
        usage = result.usage;
      } catch (error) {
        degraded = true;
        summary = `模型审查失败（${String(error && error.message ? error.message : error)}），本次只执行了规则检查。`;
      }
    }

    const findings = sortFindings([...ruleFindings, ...modelFindings]);
    if (summary === '') {
      summary = findings.length === 0 ? '未发现明显问题。' : `共发现 ${findings.length} 处需要关注的问题。`;
    }

    return {
      reviewId: `npmreview_${Date.now().toString(36)}`,
      scope: 'package',
      model: provider && model
        ? { provider, model, label: `${provider} / ${model}` }
        : null,
      effort: optionalString(body.reasoningEffort) ?? null,
      files,
      findings,
      summary,
      usage,
      degraded,
      truncated,
      pack: {
        totalFiles: packed.totalFiles,
        size: packed.size,
        unpackedSize: packed.unpackedSize,
      },
    };
  }

  /**
   * `POST /npm/publish` — 发布到 npm。
   *
   * 需要 2FA 的账号必须带 otp；没有 otp 时 npm 的报错会被原样翻译成一句
   * 可执行的提示，而不是让用户对着 EOTP 发呆。
   *
   * @param {{path?: string, otp?: string, tag?: string}} body
   * @returns {Promise<object>}
   */
  async npmPublish(body) {
    const account = await this.#store.activeNpmAccount();
    if (!account) {
      throw httpError(401, 'NO_ACCOUNT', '还没有登录 npm，请先在设置 › npm 添加令牌。');
    }
    const dir = typeof body.path === 'string' && body.path.trim() !== ''
      ? body.path.trim()
      : process.cwd();

    const args = ['publish', '--json'];
    // 防御性校验：--tag 是 dist-tag 名，只允许 npm 认可的字符；
    // --otp 是 6-8 位数字。任何越界字符直接拒绝，不进入子进程 argv。
    const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
    if (tag !== '') {
      if (!/^[a-zA-Z0-9._@-]+$/.test(tag) || tag.length > 64) {
        throw httpError(400, 'BAD_REQUEST', '发布标签（tag）含非法字符，只能是字母、数字、点、下划线、连字符。');
      }
      args.push('--tag', tag);
    }
    const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
    if (otp !== '') {
      if (!/^\d{6,8}$/.test(otp)) {
        throw httpError(400, 'BAD_REQUEST', '验证码（otp）必须是 6 到 8 位数字。');
      }
      args.push('--otp', otp);
    }

    const runner = this.#npmRunner();
    try {
      const result = await runner.run(args, {
        cwd: dir,
        env: npmAuthEnv(account.token),
      });
      const packed = mapPackResult(parsePackJson(result.stdout));
      await this.#store.touchNpmAccount(account.id);
      return { published: true, name: packed.name, version: packed.version };
    } catch (error) {
      const text = `${error.stderr || ''} ${error.message || ''}`;
      if (/EOTP|one-time password|two-factor/i.test(text)) {
        throw httpError(401, 'UNAUTHORIZED', '这次发布需要一次性验证码（2FA）：请在发布对话框里填入 6 位验证码后重试。');
      }
      if (/E403|403 Forbidden|cannot publish over/i.test(text)) {
        throw httpError(403, 'FORBIDDEN', error.message);
      }
      throw httpError(500, 'INTERNAL', error.message);
    }
  }

  /**
   * `GET /npm/search` — 按关键词搜索 npm 上的包。
   *
   * 公开数据，不要求登录；有账号时带上令牌，私有包才搜得到。
   *
   * @param {{q?: string, size?: number}} query
   * @returns {Promise<object>}
   */
  async npmSearch(query) {
    const text = typeof query.q === 'string' ? query.q.trim() : '';
    if (text === '') throw httpError(400, 'BAD_REQUEST', '请输入要搜索的包名或关键词。');
    const account = await this.#store.activeNpmAccount();
    const result = await npmSearchText({
      text,
      size: Number.isFinite(query.size) ? Number(query.size) : 20,
      token: account ? account.token : undefined,
    });
    return { query: text, items: result.items, total: result.total };
  }

  /**
   * `GET /npm/preflight` — 发布前自检。
   *
   * 把「发了才发现包名被占 / 版本重复 / 忘了 README」这几类错误提前到
   * 本地就能发现。检查分三级：fail 会直接导致发布失败，warn 多半是遗漏，
   * info 只是提示。
   *
   * 只读本地 package.json 与 registry，不写任何东西。
   *
   * @param {{path?: string}} options
   * @returns {Promise<object>}
   */
  async npmPreflight(options) {
    const dir = typeof options.path === 'string' && options.path.trim() !== ''
      ? options.path.trim()
      : process.cwd();
    const file = path.join(dir, 'package.json');
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      throw httpError(404, 'NOT_FOUND', `这个目录下没有 package.json：${dir}`);
    }
    let doc;
    try { doc = JSON.parse(raw); } catch {
      throw httpError(400, 'BAD_REQUEST', 'package.json 不是合法 JSON。');
    }

    const checks = [];
    const add = (id, level, message, hint) => checks.push({ id, level, message, hint: hint || '' });
    const exists = async (rel) => {
      try { await readFile(path.join(dir, rel)); return true; } catch { return false; }
    };

    const name = typeof doc.name === 'string' ? doc.name.trim() : '';
    const version = typeof doc.version === 'string' ? doc.version.trim() : '';

    if (name === '') add('name', 'fail', '缺少 name 字段', 'npm 用 name 作为包的唯一标识');
    else if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
      add('name', 'fail', 'name 不是合法的 npm 包名', '只能是小写字母、数字、- . _ ~；scope 用 @scope/name');
    } else {
      add('name', 'pass', 'name 格式合法', name);
    }

    if (version === '') add('version', 'fail', '缺少 version 字段', '发布必须带版本号');
    else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      add('version', 'fail', 'version 不是合法 semver', version);
    } else {
      add('version', 'pass', 'version 格式合法', version);
    }

    // registry 占用：名字被占用不一定是问题，版本重复一定是。
    if (name !== '') {
      const account = await this.#store.activeNpmAccount();
      const status = await npmPackageStatus({ name, token: account ? account.token : undefined });
      if (status.error) {
        add('registry', 'warn', '无法查询 registry', status.error);
      } else if (!status.exists) {
        add('registry', 'pass', '包名未被占用', name);
      } else {
        add('registry', 'info', 'npm 上已存在同名包',
          '如果这是你自己的包就正常；否则发布会被拒绝。latest 为 ' + (status.latest || '—'));
        if (version !== '' && status.versions.includes(version)) {
          add('version-taken', 'fail', '这个版本已经发布过',
            version + ' 已存在，请提升版本号后再发布');
        }
      }
    }

    // 常见遗漏：README / LICENSE / files。
    if (await exists('README.md')) add('readme', 'pass', 'README.md 存在', '');
    else add('readme', 'warn', '缺少 README.md', 'npm 页面会没有说明');

    const licenseFile = (await exists('LICENSE')) || (await exists('LICENSE.md'));
    if (licenseFile) add('license', 'pass', '许可证文件存在', '');
    else if (typeof doc.license === 'string' && doc.license !== '') {
      add('license', 'pass', 'package.json 声明了 license', doc.license);
    } else {
      add('license', 'warn', '没有许可证文件，也没声明 license', '默认发布出去的包是不可自由使用的');
    }

    const files = Array.isArray(doc.files) ? doc.files : null;
    if (files) {
      add('files', 'pass', 'package.json 声明了 files', files.length + ' 项');
    } else {
      add('files', 'warn', '没有声明 files 字段', '默认会把目录下几乎所有文件都发布出去');
    }

    // 入口文件必须真实存在，否则装了也 require 不到。
    if (typeof doc.main === 'string' && doc.main !== '') {
      if (await exists(doc.main)) add('main', 'pass', 'main 指向的文件存在', doc.main);
      else add('main', 'fail', 'main 指向的文件不存在', doc.main);
    }

    if (doc.private === true) {
      add('private', 'fail', 'package.json 标了 private: true', 'private 的包无法发布，先去掉这个字段');
    }

    const counts = {
      fail: checks.filter((row) => row.level === 'fail').length,
      warn: checks.filter((row) => row.level === 'warn').length,
      pass: checks.filter((row) => row.level === 'pass').length,
      info: checks.filter((row) => row.level === 'info').length,
    };

    return {
      path: file,
      name,
      version,
      checks,
      counts,
      // 只有 fail 会阻止发布；warn 值得看一眼但不必拦。
      publishable: counts.fail === 0,
    };
  }

  /**
   * `GET /npm/deps` — 工作区 package.json 里的依赖  /**
   * `GET /npm/deps` — 工作区 package.json 里的依赖，逐个比对 npm 上的最新版。
   *
   * 这是本插件少有的「不需要跳去别处」的 npm 能力：它读的是本地文件，
   * 只把版本号拿去问 registry，最后在面板里直接给出「有没有更新」。
   *
   * 之所以并发受限，是因为一个正常项目有几十个依赖，逐个串行会慢到没人
   * 愿意等；但全部并发又会触发 registry 的速率限制。
   *
   * @param {{path?: string, token?: string}} options
   * @returns {Promise<object>}
   */
  async npmProjectDeps(options) {
    const dir = typeof options.path === 'string' && options.path.trim() !== ''
      ? options.path.trim()
      : process.cwd();
    const file = path.join(dir, 'package.json');
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      throw httpError(404, 'NOT_FOUND', `这个目录下没有 package.json：${dir}`);
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw httpError(400, 'BAD_REQUEST', 'package.json 不是合法 JSON，无法解析。');
    }

    const groups = [
      ['dependencies', doc.dependencies],
      ['devDependencies', doc.devDependencies],
    ];
    const rows = [];
    for (const [group, table] of groups) {
      if (!table || typeof table !== 'object') continue;
      for (const [name, range] of Object.entries(table)) {
        if (typeof range !== 'string') continue;
        rows.push({ name, range, group });
      }
    }

    const account = await this.#store.activeNpmAccount();
    const token = account ? account.token : undefined;

    // 限并发 6：既不慢到不可用，也不至于把注册表打到限流。
    const CONCURRENCY = 6;
    const results = [];
    for (let index = 0; index < rows.length; index += CONCURRENCY) {
      const slice = rows.slice(index, index + CONCURRENCY);
      const settled = await Promise.all(slice.map(async (row) => {
        const info = await npmLatestVersion({ name: row.name, token });
        return {
          ...row,
          latest: info.latest,
          error: info.error ?? null,
          outdated: info.latest !== null && !rangeSatisfied(row.range, info.latest),
        };
      }));
      results.push(...settled);
    }

    return {
      path: file,
      name: typeof doc.name === 'string' ? doc.name : '',
      version: typeof doc.version === 'string' ? doc.version : '',
      items: results,
      total: results.length,
      outdated: results.filter((row) => row.outdated).length,
      failed: results.filter((row) => row.error !== null).length,
    };
  }

  /**
   * `GET /npm/package` — one package's versions and dist-tags.  /**
   * `GET /npm/package` — one package's versions and dist-tags.
   *
   * Public data, so no token is required; a token is still passed when one is
   * available so private/org packages resolve too.
   *
   * @param {object} query
   * @returns {Promise<object>}
   */
  async npmPackage(query) {
    const name = requireString(query, 'name', '包名').trim();
    const account = await this.#store.activeNpmAccount();
    const result = await npmPackument({ name, token: account ? account.token : undefined });
    return result;
  }

  /* ---------------- CONTRACT §3d: pre-push review ---------------- */  /* ---------------- CONTRACT §3d: pre-push review ---------------- */

  /**
   * `GET /review/presets` — built-ins plus the user's saved prompts.
   *
   * Built-ins are code, never stored: wiping the saved list must not remove the
   * product's own opinion about what deserves checking.
   *
   * @returns {Promise<{builtin: object[], custom: object[], categories: object[]}>}
   */
  async reviewPresets() {
    const custom = await this.#store.reviewPresets();
    return {
      builtin: BUILTIN_PRESETS.map((preset) => ({ ...preset, builtin: true })),
      custom,
      categories: REVIEW_CATEGORIES.map((category) => ({ ...category })),
    };
  }

  /**
   * `POST /review/presets` — save (or replace) a user preset.
   * @param {object} body
   * @returns {Promise<{preset: object}>}
   */
  async reviewPresetSave(body) {
    const title = requireString(body, 'title', '预设标题');
    const prompt = requireString(body, 'prompt', '提示词');
    const preset = await this.#store.saveReviewPreset({
      id: optionalString(body.id),
      title,
      prompt,
      description: optionalString(body.description) ?? '',
      category: optionalString(body.category) ?? 'custom',
    });
    return { preset };
  }

  /**
   * `POST /review/presets/delete` — remove one saved preset.
   *
   * Built-ins are refused explicitly: they are not in the store, so a silent
   * "not found" would look like a bug to a user who just clicked delete.
   *
   * @param {object} body
   * @returns {Promise<{deleted: true}>}
   */
  async reviewPresetDelete(body) {
    const id = requireString(body, 'id', '预设 id');
    if (BUILTIN_PRESETS.some((preset) => preset.id === id)) {
      throw httpError(409, 'CONFLICT', '内置审查项不能删除，只能在审查时取消勾选。');
    }
    const removed = await this.#store.deleteReviewPreset(id);
    if (!removed) throw httpError(404, 'NOT_FOUND', '找不到这条预设，可能已被删除。');
    return { deleted: true };
  }

  /**
   * `GET /review/models` — provider/model/effort candidates for the pickers.
   *
   * Read from the host's `llm` service through `ctx.get`: it is optional, and a
   * composition without it must still serve the review UI (which then shows
   * "宿主未提供模型配置" and runs rule-based review only).
   *
   * @returns {Promise<{providers: object[], default: object|null}>}
   */
  async reviewModels() {
    const llm = this.#llm();
    const providers = [];
    let fallback = null;
    if (llm) {
      try {
        const list = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
        for (const provider of list) {
          let models = [];
          try {
            models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : [];
          } catch {
            models = [];
          }
          const mapped = [];
          for (const model of models) {
            let efforts = [];
            let defaultEffort;
            try {
              const info = typeof llm.resolveModelInfo === 'function'
                ? await llm.resolveModelInfo(provider.id, model.id)
                : null;
              const reasoning = info && info.reasoning ? info.reasoning : null;
              if (reasoning && Array.isArray(reasoning.efforts)) {
                efforts = reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name }));
              }
              if (reasoning && reasoning.defaultEffort) defaultEffort = reasoning.defaultEffort;
            } catch {
              efforts = [];
            }
            mapped.push({ id: model.id, name: model.name || model.id, efforts, defaultEffort });
          }
          providers.push({ id: provider.id, name: provider.name || provider.id, models: mapped });
          if (fallback === null && mapped.length > 0) {
            fallback = { provider: provider.id, model: mapped[0].id };
          }
        }
      } catch {
        // A provider directory that cannot enumerate must not break the panel.
      }
    }
    return { providers, default: fallback };
  }

  /**
   * `POST /review/project` — 一次审查覆盖整个项目。
   *
   * 同一份代码既是 git 的改动源，也是 npm 的发布内容。分别跑两次审查
   * 既慢又会让同一问题报两遍。这里一次收齐：
   *
   *   - git：未提交改动（存在仓库时）
   *   - npm：npm pack 会打进去的文件（存在 package.json 时）
   *
   * 结果按 scope 标注来源，界面据此分组；用户在各自插件里提交即可。
   *
   * @param {object} body `{ path, presetIds, customPrompt, provider, model,
   *   reasoningEffort, includeGit, includePack, maxFiles }`
   * @returns {Promise<object>}
   */
  async reviewProject(body) {
    const dir = typeof body.path === 'string' && body.path.trim() !== ''
      ? body.path.trim()
      : process.cwd();

    const collections = [];
    const skipped = [];

    /* ---- 1. git 改动 ---- */
    const wantGit = body.includeGit !== false;
    if (wantGit) {
      const gitDir = path.join(dir, '.git');
      let isRepo = false;
      try { isRepo = (await stat(gitDir)).isDirectory(); } catch { isRepo = false; }
      if (isRepo) {
        try {
          const { runner, secrets } = await this.#runnerAndSecrets();
          const root = (await runner.assertRepo(dir, { secrets })).root;
          const changes = await collectReviewChanges(runner, root, {
            staged: false,
            maxFiles: Number.isFinite(body.maxFiles) ? Number(body.maxFiles) : 60,
            secrets,
          });
          for (const chunk of changes.chunks) {
            collections.push({ scope: 'git', path: chunk.path, text: chunk.text });
          }
          if (changes.truncated) skipped.push({ scope: 'git', reason: '改动过多，已截断' });
        } catch (error) {
          skipped.push({ scope: 'git', reason: error.message });
        }
      } else {
        skipped.push({ scope: 'git', reason: '不是 git 仓库' });
      }
    }

    /* ---- 2. npm 包内容 ---- */
    const wantPack = body.includePack !== false;
    let packed = null;
    if (wantPack) {
      try {
        await readFile(path.join(dir, 'package.json'), 'utf8');
        const runner = this.#npmRunner();
        packed = mapPackResult(parsePackJson(
          (await runner.run(['pack', '--dry-run', '--json'], { cwd: dir })).stdout,
        ));
        const maxBytes = MAX_FILE_BYTES;
        for (const row of packed.files) {
          const rel = row.path.replace(/\/$/, '');
          if (/(^|\/)(node_modules|\.git)\//.test(rel)) continue;
          // 已经在 git 里出现过的文件不重复审：同一份内容只报一次。
          if (collections.some((row2) => row2.path === rel)) continue;
          if (row.size > maxBytes) {
            skipped.push({ scope: 'npm', reason: `${rel} 过大` });
            continue;
          }
          try {
            const text = await readFile(path.join(dir, rel), 'utf8');
            if (text.includes('\u0000')) continue;
            collections.push({ scope: 'npm', path: rel, text });
          } catch { /* 读不到就跳过 */ }
        }
      } catch (error) {
        skipped.push({ scope: 'npm', reason: error.code === 'ENOENT' ? '没有 package.json' : error.message });
      }
    }

    /* ---- 3. 规则扫描 ---- */
    const ruleFindings = [];
    for (const row of collections) {
      for (const finding of scanSecrets(row.text, { file: row.path })) {
        ruleFindings.push({ ...normalizeFinding(finding), scope: row.scope });
      }
    }

    /* ---- 4. 模型审查（一次覆盖全部内容） ---- */
    const presetIds = Array.isArray(body.presetIds)
      ? body.presetIds.filter((id) => typeof id === 'string' && id !== '')
      : [];
    const stored = await this.#store.reviewPresets();
    const chosen = [
      ...BUILTIN_PRESETS.filter((preset) => presetIds.includes(preset.id)),
      ...stored.filter((preset) => presetIds.includes(preset.id)),
    ];
    const customPrompt = optionalString(body.customPrompt) ?? '';

    const llm = this.#llm();
    let provider = optionalString(body.provider);
    let model = optionalString(body.model);
    if (llm && (!provider || !model)) {
      try {
        const fallback = await this.reviewModels();
        if (fallback.default) {
          provider = provider ?? fallback.default.provider;
          model = model ?? fallback.default.model;
        }
      } catch { /* 保留调用方的值 */ }
    }

    let modelFindings = [];
    let summary = '';
    let usage;
    let degraded = false;

    const scopes = new Set(collections.map((row) => row.scope));
    if (collections.length === 0) {
      summary = '没有可审查的内容：既没有未提交的 git 改动，也没有可打包的 npm 文件。';
    } else if (!llm) {
      degraded = true;
      summary = '宿主未提供 llm 服务，本次只执行了规则检查（敏感信息扫描）。';
    } else if (!provider || !model) {
      degraded = true;
      summary = '未找到可用的模型，本次只执行了规则检查（敏感信息扫描）。';
    } else {
      const instructions = [
        ...chosen.map((preset) => `## ${preset.title}\n${preset.prompt}`),
        ...(customPrompt ? [`## 用户补充要求\n${customPrompt}`] : []),
      ].join('\n\n');

      const promptParts = [];
      if (instructions !== '') promptParts.push(instructions);
      promptParts.push('## 审查范围');
      promptParts.push('这是一个项目的完整待发布内容，包含两部分：'
        + 'git 未提交改动（即将提交）和 npm 包内容（即将发布）。'
        + '同一条问题只报一次，报告时说明它影响哪一部分。'
        + '未列出的文件不代表项目缺少文件，只代表本次不涉及。');
      promptParts.push(`## 文件（${collections.length} 个）`);
      promptParts.push(collections.map((row) => `- [${row.scope}] ${row.path}`).join('\n'));
      promptParts.push('## 内容');
      promptParts.push(collections.map((row) =>
        `### [${row.scope}] ${row.path}\n\`\`\`\n${row.text}\n\`\`\``).join('\n\n'));

      try {
        const result = await runModelReview(llm, {
          provider,
          model,
          reasoningEffort: optionalString(body.reasoningEffort),
          prompt: promptParts.join('\n\n'),
        });
        modelFindings = result.findings.map((row) => ({
          ...normalizeFinding(row),
          scope: row.scope || (scopes.size > 1 ? 'both' : [...scopes][0] || 'project'),
        }));
        summary = result.summary;
        usage = result.usage;
      } catch (error) {
        degraded = true;
        summary = `模型审查失败（${String(error && error.message ? error.message : error)}），本次只执行了规则检查。`;
      }
    }

    const findings = sortFindings([...ruleFindings, ...modelFindings]);
    if (summary === '') {
      summary = findings.length === 0 ? '未发现明显问题。' : `共发现 ${findings.length} 处需要关注的问题。`;
    }

    return {
      reviewId: `project_${Date.now().toString(36)}`,
      scope: 'project',
      model: provider && model ? { provider, model, label: `${provider} / ${model}` } : null,
      effort: optionalString(body.reasoningEffort) ?? null,
      files: collections.map((row) => ({ path: row.path, scope: row.scope })),
      findings,
      summary,
      usage,
      degraded,
      skipped,
      pack: packed
        ? { totalFiles: packed.totalFiles, size: packed.size, unpackedSize: packed.unpackedSize }
        : null,
    };
  }

  /**
   * `POST /review/run` — review the changes that would be pushed.  /**
   * `POST /review/run` — review the changes that would be pushed.
   *
   * Two passes, ALWAYS in this order and with this failure posture:
   *   1. rule scan (cheap, deterministic, never skipped);
   *   2. model review (skipped or degraded when `llm` is unavailable).
   * A review that cannot reach a model still returns `ok` with the rule
   * findings: the whole point is to inform a push, never to block one.
   *
   * @param {object} body
   * @returns {Promise<object>}
   */
  async reviewRun(body) {
    const path = requireString(body, 'path', '仓库路径');
    const { settings, runner, secrets } = await this.#runnerAndSecrets();
    const root = (await runner.assertRepo(path, { secrets })).root;

    const presetIds = Array.isArray(body.presetIds)
      ? body.presetIds.filter((id) => typeof id === 'string' && id !== '')
      : [];
    const custom = await this.#store.reviewPresets();
    const chosen = [
      ...BUILTIN_PRESETS.filter((preset) => presetIds.includes(preset.id)),
      ...custom.filter((preset) => presetIds.includes(preset.id)),
    ];
    const customPrompt = optionalString(body.customPrompt) ?? '';

    const changes = await collectReviewChanges(runner, root, {
      staged: optionalBool(body.staged, false),
      includeFiles: Array.isArray(body.includeFiles) ? body.includeFiles : undefined,
      maxFiles: Number.isFinite(body.maxFiles) ? body.maxFiles : 60,
      secrets,
    });

    // ---- pass 1: rules ------------------------------------------------
    const ruleFindings = [];
    for (const chunk of changes.chunks) {
      ruleFindings.push(...scanSecrets(chunk.text, { file: chunk.path }));
    }

    // ---- pass 2: the model (best effort) ------------------------------
    const llm = this.#llm();
    const wantedProvider = optionalString(body.provider);
    const wantedModel = optionalString(body.model);
    let provider = wantedProvider;
    let model = wantedModel;
    if (llm && (!provider || !model)) {
      try {
        const fallback = await this.reviewModels();
        if (fallback.default) {
          provider = provider ?? fallback.default.provider;
          model = model ?? fallback.default.model;
        }
      } catch {
        // keep the caller's values; runModelReview will decline cleanly
      }
    }

    const instructions = [
      ...chosen.map((preset) => `## ${preset.title}\n${preset.prompt}`),
      ...(customPrompt ? [`## 用户补充要求\n${customPrompt}`] : []),
    ].join('\n\n');

    const promptParts = [];
    if (instructions !== '') promptParts.push(instructions);
    promptParts.push(`## 变更文件（${changes.files.length} 个）`);
    promptParts.push(changes.files.map((file) => `- ${file.path}${file.skipped ? `（未送审：${file.skipped}）` : ''}`).join('\n'));
    promptParts.push('## 差异');
    promptParts.push(changes.patch === '' ? '（没有可审查的改动）' : changes.patch);

    /* What the model is looking at, and — just as important — what it is
     * NOT looking at. Without this a size-truncated patch reads as "these
     * files are missing from the project", which is a false alarm on exactly
     * the release review that matters most. */
    promptParts.splice(2, 0, '## 审查范围');
    promptParts.splice(3, 0, changes.scope === 'outgoing'
      ? `当前分支有 ${changes.range ? changes.range.count : '若干'} 个提交尚未推送，本次审查的是它们相对远端的差异。`
      : '本次审查的是工作区中尚未提交的改动。');
    promptParts.splice(4, 0, '注意：文件列表只包含本次改动涉及的文件。未出现在列表中的文件属于仓库既有内容，' +
      '不代表它们不存在、未提交或不随包发布——不要据此推断项目缺少文件。');

    if (changes.truncated === true) {
      promptParts.splice(5, 0, '严重提示：本次差异因体积限制被截断，你看到的内容并不完整。' +
        '不要因为某个改动看起来缺失就断定功能不完整，只针对你实际看到的内容报告问题。');
    }

    let modelFindings = [];
    let summary = '';
    let usage;
    let degraded = false;
    const effectiveProvider = provider;
    const effectiveModel = model;

    if (changes.patch === '') {
      summary = '没有检测到待推送的改动。';
    } else if (!llm) {
      degraded = true;
      summary = '宿主未提供 llm 服务，本次只执行了规则检查（敏感信息扫描）。';
    } else if (!effectiveProvider || !effectiveModel) {
      degraded = true;
      summary = '未找到可用的模型，本次只执行了规则检查（敏感信息扫描）。';
    } else {
      try {
        const result = await runModelReview(llm, {
          provider: effectiveProvider,
          model: effectiveModel,
          reasoningEffort: optionalString(body.reasoningEffort),
          prompt: promptParts.join('\n\n'),
        });
        modelFindings = result.findings.map(normalizeFinding);
        summary = result.summary;
        usage = result.usage;
      } catch (error) {
        degraded = true;
        summary = `模型审查失败（${String(error && error.message ? error.message : error)}），本次只执行了规则检查。`;
      }
    }

    const findings = sortFindings([...ruleFindings, ...modelFindings]);
    if (summary === '') {
      summary = findings.length === 0 ? '未发现明显问题。' : `共发现 ${findings.length} 处需要关注的问题。`;
    }

    return {
      reviewId: `review_${Date.now().toString(36)}`,
      model: effectiveProvider && effectiveModel
        ? { provider: effectiveProvider, model: effectiveModel, label: `${effectiveProvider} / ${effectiveModel}` }
        : null,
      effort: optionalString(body.reasoningEffort) ?? null,
      files: changes.files,
      findings,
      summary,
      usage,
      degraded,
      truncated: changes.truncated,
      // "working" = uncommitted changes; "outgoing" = the commits a push
      // would send. The two are different questions and the panel says which
      // one was answered, so a clean result is never mistaken for the other.
      scope: changes.scope === 'outgoing' ? 'outgoing' : 'working',
      outgoingCommits: changes.range ? changes.range.count : 0,
    };
  }

  /**
   * The host `llm` service, when this composition has one.
   * @returns {object|undefined}
   */
  #llm() {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    try {
      return typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
    } catch {
      return undefined;
    }
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Boot: register routes and the agent tool, both bound to this fiber.
   * @returns {Promise<void>}
   */
  async [ServiceClass.init || Symbol.for('cordis.init')]() {
    const ctx = this.ctx;
    const undo = [];
    try {
      const disposeRoutes = registerRoutes(ctx, this);
      if (disposeRoutes) undo.push(disposeRoutes);
    } catch (error) {
      // Never leave a half-mounted plugin: unwinding here keeps a failed
      // install from occupying routes that the retry then cannot take.
      for (const fn of undo) {
        try {
          fn();
        } catch {
          // best effort
        }
      }
      throw error;
    }
    this.#stop = () => {
      for (const fn of undo) {
        try {
          fn();
        } catch {
          // best effort
        }
      }
    };
    // cordis only unwinds effects registered through ctx.effect; a class
    // dispose() is not called on unload, so routes and the tool must be
    // installed as effects or an in-process reload leaks them — the next mount
    // would then die on webServer.register's duplicate-path throw.
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => this.#stop, 'push: /api/push/* routes');
    }

    // The agent tool lives in its own child fiber: `tools` is an OPTIONAL
    // service, and a composition that never publishes it must still serve the
    // panel. A nested inject also re-registers the tool if the tools service
    // is replaced (its provider restarting) without remounting the plugin.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scoped) => {
        const disposeTool = registerTool(scoped, this);
        if (disposeTool) {
          if (typeof scoped.effect === 'function') {
            scoped.effect(() => disposeTool, 'push: github_link tool');
          } else {
            this.#stop = ((previous) => () => {
              try {
                disposeTool();
              } finally {
                previous();
              }
            })(this.#stop);
          }
        }
      });
    }
  }

  /** Idempotent teardown (also reached through the effect above). */
  dispose() {
    this.#stop();
    this.#stop = () => {};
  }
}

/* ------------------------------------------------------------------ */
/*  Route table                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the route table: one entry per (path, method).
 *
 * The paths are literal contract paths, so a typo is a contract violation that
 * shows up immediately in the panel — there is no dynamic segment anywhere.
 *
 * @param {GithubLinkHost} host
 * @returns {{path: string, method: string, run: (ctx: object) => Promise<any>}[]}
 */
function buildRoutes(host) {
  /** GET route. */
  const get = (path, run) => ({ path, method: 'GET', run });
  /** POST route. */
  const post = (path, run) => ({ path, method: 'POST', run });

  return [
    // §1 accounts + settings
    get('/state', async () => ({ data: await host.state() })),
    get('/npm/accounts', async () => ({ data: await host.npmAccounts() })),
    post('/npm/account', async ({ body }) => ({ data: await host.npmAccountAdd(body) })),
    post('/npm/account/remove', async ({ body }) => ({ data: await host.npmAccountRemove(body) })),
    post('/npm/account/active', async ({ body }) => ({ data: await host.npmAccountActive(body) })),
    get('/npm/packages', async ({ query }) => ({
      data: await host.npmPackages({ size: Number(query('size')) || undefined, from: Number(query('from')) || 0 }),
    })),
    get('/npm/package', async ({ query }) => ({ data: await host.npmPackage({ name: query('name') }) })),
    get('/npm/search', async ({ query }) => ({
      data: await host.npmSearch({
        q: query('q'),
        size: Number(query('size')) || undefined,
      }),
    })),
    post('/npm/init', async ({ body }) => ({ data: await host.npmInit(body) })),
    get('/npm/pack', async ({ query }) => ({ data: await host.npmPackInspect({ path: query('path') }) })),
    post('/npm/pack', async ({ body }) => ({ data: await host.npmPack(body) })),
    post('/npm/publish', async ({ body }) => ({ data: await host.npmPublish(body) })),
    post('/npm/review/run', async ({ body }) => ({ data: await host.npmPublishReview(body) })),
    get('/npm/preflight', async ({ query }) => ({
      data: await host.npmPreflight({ path: query('path') }),
    })),
    get('/npm/deps', async ({ query }) => ({
      data: await host.npmProjectDeps({ path: query('path') }),
    })),
    get('/diagnostics', async () => ({ data: await host.diagnostics() })),
    post('/accounts/token', async ({ body }) => ({ data: await host.addTokenAccount(body) })),
    post('/accounts/device/start', async () => ({ data: await host.deviceStart() })),
    post('/accounts/device/poll', async ({ body }) => ({ data: await host.devicePoll(body) })),
    post('/accounts/activate', async ({ body }) => ({ data: await host.activateAccount(body) })),
    post('/accounts/remove', async ({ body }) => ({ data: await host.removeAccount(body) })),
    post('/settings', async ({ body }) => ({ data: await host.updateSettings(body) })),

    // §2 remote repositories
    get('/repos', async ({ query }) => ({
      data: await host.repos({
        page: query('page'),
        q: query('q'),
        affiliation: query('affiliation'),
        sort: query('sort'),
      }),
    })),
    get('/repos/detail', async ({ query }) => ({ data: await host.repoDetail({ owner: query('owner'), name: query('name') }) })),
    post('/repos/create', async ({ body }) => ({ data: await host.repoCreate(body) })),
    post('/repos/delete', async ({ body }) => ({ data: await host.repoDelete(body) })),

    // §3c repository management — the aggregate read, then the writes. The
    // rename/transfer routes answer CONFLICT without `confirm: true`, exactly
    // like the destructive local-git routes below.
    get('/repos/languages', async ({ query }) => ({
      data: await host.repoLanguages({ owner: query('owner'), name: query('name') }),
    })),
    post('/releases/asset', async ({ body }) => ({ data: await host.releaseAssetUpload(body) })),
    post('/releases/asset/delete', async ({ body }) => ({ data: await host.releaseAssetDelete(body) })),
    get('/repos/manage', async ({ query }) => ({
      data: await host.repoManage({ owner: query('owner'), name: query('name') }),
    })),
    post('/repos/update', async ({ body }) => ({ data: await host.repoUpdate(body) })),
    post('/repos/branch/rename', async ({ body }) => ({ data: await host.repoBranchRename(body) })),
    post('/repos/branch/delete', async ({ body }) => ({ data: await host.repoBranchDelete(body) })),
    post('/repos/branch/protect', async ({ body }) => ({ data: await host.repoBranchProtect(body) })),
    post('/repos/release/delete', async ({ body }) => ({ data: await host.repoReleaseDelete(body) })),
    post('/repos/release/update', async ({ body }) => ({ data: await host.repoReleaseUpdate(body) })),
    post('/repos/collaborator/add', async ({ body }) => ({ data: await host.repoCollaboratorAdd(body) })),
    post('/repos/collaborator/remove', async ({ body }) => ({ data: await host.repoCollaboratorRemove(body) })),
    post('/repos/rename', async ({ body }) => ({ data: await host.repoRename(body) })),
    post('/repos/transfer', async ({ body }) => ({ data: await host.repoTransfer(body) })),

    // `/releases` carries BOTH a read and a write (CONTRACT §2), so the method
    // decides which one runs — webServer allows a single handler per path.
    get('/releases', async ({ query }) => ({ data: await host.releases({ owner: query('owner'), repo: query('repo') }) })),
    post('/releases', async ({ body }) => ({ data: await host.releaseCreate(body) })),

    // §2 activity: contribution calendar (GraphQL) + notifications ("最近消息")
    get('/contributions', async ({ query }) => ({
      data: await host.contributions({ login: query('login'), days: query('days') }),
    })),
    get('/notifications', async ({ query }) => ({
      data: await host.notifications({ all: query('all'), limit: query('limit') }),
    })),
    post('/notifications/read', async ({ body }) => ({ data: await host.notificationRead(body) })),

    // §3 local repository — reads
    get('/local/status', async ({ query }) => ({ data: await host.localStatus(query('path')) })),
    get('/local/log', async ({ query }) => ({
      data: await host.localLog({ path: query('path'), limit: query('limit'), ref: query('ref') }),
    })),
    get('/local/diff', async ({ query }) => ({
      data: await host.localDiff({ path: query('path'), file: query('file'), staged: query('staged') }),
    })),
    get('/local/remotes', async ({ query }) => ({ data: await host.localRemotes({ path: query('path') }) })),
    // `/local/commit` is a READ with ?sha= and a WRITE with a body (CONTRACT §3).
    get('/local/commit', async ({ query }) => ({
      data: await host.localCommitDetail({ path: query('path'), sha: query('sha') }),
    })),

    // §3 local repository — writes
    post('/local/init', async ({ body }) => ({ data: await host.localInit(body) })),
    post('/local/remote', async ({ body }) => ({ data: await host.localSetRemote(body) })),
    post('/local/fetch', async ({ body }) => ({ data: await host.localFetch(body) })),
    post('/local/pull', async ({ body }) => ({ data: await host.localPull(body) })),
    post('/local/push', async ({ body }) => ({ data: await host.localPush(body) })),
    post('/local/commit', async ({ body }) => ({ data: await host.localCommit(body) })),
    post('/local/checkout', async ({ body }) => ({ data: await host.localCheckout(body) })),
    post('/local/branch', async ({ body }) => ({ data: await host.localBranch(body) })),
    post('/local/branch/delete', async ({ body }) => ({ data: await host.localBranchDelete(body) })),
    post('/local/merge', async ({ body }) => ({ data: await host.localMerge(body) })),
    post('/local/reset', async ({ body }) => ({ data: await host.localReset(body) })),
    post('/local/revert', async ({ body }) => ({ data: await host.localRevert(body) })),
    post('/local/revert-commit', async ({ body }) => ({ data: await host.localRevert(body) })),
    post('/local/tag', async ({ body }) => ({ data: await host.localTag(body) })),
    post('/local/stash', async ({ body }) => ({ data: await host.localStash(body) })),
    post('/local/stash/pop', async ({ body }) => ({ data: await host.localStashPop(body) })),
    post('/local/restore', async ({ body }) => ({ data: await host.localRestore(body) })),
    post('/local/discard-all', async ({ body }) => ({ data: await host.localDiscardAll(body) })),

    // §3d pre-push review
    get('/review/presets', async () => ({ data: await host.reviewPresets() })),
    post('/review/presets', async ({ body }) => ({ data: await host.reviewPresetSave(body) })),
    post('/review/presets/delete', async ({ body }) => ({ data: await host.reviewPresetDelete(body) })),
    get('/review/models', async () => ({ data: await host.reviewModels() })),
    get('/review/pending', async () => ({ data: await host.reviewPending() })),
    post('/review/pending/clear', async ({ body }) => ({ data: await host.reviewPendingClear(body) })),
    post('/review/run', async ({ body }) => ({ data: await host.reviewRun(body) })),
    post('/review/project', async ({ body }) => ({ data: await host.reviewProject(body) })),

    // §3b push targets + per-branch memory
    get('/push/targets', async ({ query }) => ({ data: await host.pushTargets({ path: query('path') }) })),
    get('/push/remotes', async ({ query }) => ({
      data: await host.pushRemotes({ q: query('q'), page: query('page') }),
    })),
    get('/push/memory', async ({ query }) => ({ data: await host.pushMemory({ path: query('path') }) })),
    // Optional companion to `/local/push` (see the service method): forget one
    // branch's remembered target so a wrong one is not permanent.
    post('/local/push/target/forget', async ({ body }) => ({ data: await host.localForgetPushTarget(body) })),
  ];
}

/**
 * Register every route on the `webServer` service.
 *
 * Handlers are grouped by PATH because one path may serve both a GET and a
 * POST; the group dispatches on `req.method` and answers 405 for anything else.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {GithubLinkHost} host
 * @returns {(() => void)|null} disposer, or null without a webServer.
 */
function registerRoutes(ctx, host) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') return null;

  const byPath = new Map();
  for (const route of buildRoutes(host)) {
    const full = `${ROUTE_PREFIX}${route.path}`;
    const existing = byPath.get(full);
    if (existing) existing[route.method] = route.run;
    else byPath.set(full, { [route.method]: route.run });
  }

  const disposers = [];
  for (const [path, methods] of byPath) {
    const handler = async (req, res) => {
      // The token list is read ONCE per request, before anything can fail, so
      // the error path can scrub messages synchronously. A failed read leaves
      // an empty list: the pattern-based redaction in store.js still masks
      // recognizable GitHub token shapes.
      let secrets = [];
      try {
        secrets = await host.store.secrets();
      } catch {
        secrets = [];
      }
      try {
        // CSRF guard: a non-GET request must carry the plugin header. A custom
        // header cannot be set cross-origin without a preflight this server
        // never answers, so it proves same-origin intent.
        if (req.method !== 'GET' && req.headers[PLUGIN_HEADER] !== PLUGIN_HEADER_VALUE) {
          throw httpError(403, 'FORBIDDEN', `缺少请求头 ${PLUGIN_HEADER}: ${PLUGIN_HEADER_VALUE}`);
        }
        const run = methods[req.method];
        if (typeof run !== 'function') {
          throw httpError(405, 'BAD_REQUEST', `该路径不支持 ${req.method} 方法`);
        }
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await run({ body, query: queryOf(req), req });
        sendOk(res, result.data);
      } catch (error) {
        sendError(res, toWireError(error, (text) => redactSecrets(text, secrets)));
      }
    };
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler }));
    } catch (error) {
      // A leaked route from a previous instance only clears on a profile
      // restart, so say that instead of surfacing a bare duplicate error.
      throw new Error(
        `dsh-push: 无法注册路由 ${path}：${error?.message ?? error}`
        + '（可能是上一次加载残留的路由；重启 DSH 后重试）',
        { cause: error },
      );
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // best effort
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Agent tool                                                        */
/* ------------------------------------------------------------------ */

/** The `github_link` tool's parameter schema (plain JSON Schema). */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'log', 'push', 'pull', 'commit', 'repos', 'accounts', 'create_repo', 'release', 'review'],
      description: '要执行的操作：status（本地仓库状态）、log（提交图）、push（推送）、pull（拉取）、commit（提交）、repos（远端仓库列表）、accounts（已登录账号）。',
    },
    path: {
      type: 'string',
      description: '本地仓库目录的绝对路径；省略时使用当前会话的工作目录。',
    },
    message: {
      type: 'string',
      description: 'commit 时必填：提交信息。',
    },
    remote: {
      type: 'string',
      description: '远端名称，默认 origin。',
    },
    branch: {
      type: 'string',
      description: 'push/pull 时可指定分支名；省略则使用当前分支。',
    },
    limit: {
      type: 'number',
      description: 'log 返回的提交条数，默认 60，最大 500。',
    },
    force: {
      type: 'boolean',
      description: 'push 时强制推送（使用 --force-with-lease，不会覆盖他人提交）。',
    },
    q: {
      type: 'string',
      description: 'repos 时的搜索关键词，留空则列出全部仓库。',
    },
    page: {
      type: 'number',
      description: 'repos 的页码，从 1 开始。',
    },
    repoName: {
      type: 'string',
      description: 'create_repo 时的仓库名；release 时省略则用当前工作区的远端仓库。',
    },
    owner: {
      type: 'string',
      description: 'push/release 的目标仓库所有者；与 repo 一起使用时替代本地远端。',
    },
    repo: {
      type: 'string',
      description: 'push/release 的目标仓库名。',
    },
    description: {
      type: 'string',
      description: 'create_repo 时的仓库简介。',
    },
    isPrivate: {
      type: 'boolean',
      description: 'create_repo 时是否创建为私有仓库，默认 true。',
    },
    autoInit: {
      type: 'boolean',
      description: 'create_repo 时是否带一个初始 README 提交（有提交才能打标签或发布），默认 false。',
    },
    tagName: {
      type: 'string',
      description: 'release 时的标签名，例如 v1.2.0；不存在会被创建。',
    },
    releaseName: {
      type: 'string',
      description: 'release 的标题，默认与标签名相同。',
    },
    releaseBody: {
      type: 'string',
      description: 'release 的说明文字。',
    },
    draft: {
      type: 'boolean',
      description: 'release 时是否存为草稿。',
    },
    presetIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'review 时要使用的内置审查项 id，例如 builtin_secrets_token。',
    },
    customPrompt: {
      type: 'string',
      description: 'review 时的额外审查要求。',
    },
  },
  required: ['action'],
};

/** The tool's output schema: one object covering every action's payload. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    action: { type: 'string' },
    output: { type: 'string' },
    status: { type: 'object', additionalProperties: true },
    commits: { type: 'array', items: { type: 'object', additionalProperties: true } },
    hasMore: { type: 'boolean' },
    page: { type: 'number' },
    repos: { type: 'array', items: { type: 'object', additionalProperties: true } },
    accounts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    // `activeAccountId` is nullable, and this host's schema subset can express
    // neither `type: [...]` nor `anyOf`. Declaring it would reject the whole
    // registration, so it is left to `additionalProperties: true` above — the
    // value still carries the field; the schema just does not describe it.
  },
};

/**
 * Render one tool result as the single text block the model reads.
 * @param {object} value the canonical output value.
 * @returns {string}
 */
function renderToolResult(value) {
  const action = String(value?.action ?? '');
  if (typeof value?.output === 'string') return `【${action}】\n${value.output}`;
  if (action === 'status') {
    const status = value.status ?? {};
    if (!status.isRepo) return `【status】${status.root ?? '当前目录'} 不是 Git 仓库。`;
    const dirty = status.dirty ?? {};
    const lines = [
      `【status】${status.root}`,
      `分支：${status.detachedHead ? '(分离 HEAD)' : (status.branch ?? '(未知)')}`
        + `　上游：${status.upstream ?? '未设置'}`
        + `　领先 ${status.ahead} / 落后 ${status.behind}`,
      `改动：已暂存 ${dirty.staged}，未暂存/已修改 ${dirty.changed}，未跟踪 ${dirty.untracked}，冲突 ${dirty.conflicted}`,
    ];
    if (status.files?.length) {
      lines.push('文件：');
      for (const file of status.files.slice(0, 40)) {
        lines.push(`  ${file.index}${file.worktree} ${file.path}${file.untracked ? '（未跟踪）' : ''}`);
      }
      if (status.files.length > 40) lines.push(`  …共 ${status.files.length} 个`);
    }
    return lines.join('\n');
  }
  if (action === 'log') {
    const commits = value.commits ?? [];
    if (commits.length === 0) return '【log】没有提交记录。';
    return ['【log】最近提交（lane 为图列号）：']
      .concat(commits.map((commit) => `  ${String(commit.lane).padStart(2, ' ')} ${commit.shortSha} ${commit.subject}`))
      .join('\n');
  }
  if (action === 'repos') {
    const repos = value.repos ?? [];
    if (repos.length === 0) return '【repos】没有匹配的仓库。';
    return [`【repos】第 ${value.page ?? 1} 页${value.hasMore ? '（还有更多）' : ''}：`]
      .concat(repos.map((repo) => `  ${repo.fullName}${repo.private ? '（私有）' : ''} · 默认分支 ${repo.defaultBranch}`))
      .join('\n');
  }
  if (action === 'accounts') {
    const accounts = value.accounts ?? [];
    if (accounts.length === 0) return '【accounts】还没有登录任何 GitHub 账号。';
    return ['【accounts】']
      .concat(accounts.map((account) => `  ${account.login}${account.id === value.activeAccountId ? '（当前）' : ''} · ${account.tokenKind} · [${account.scopes.join(', ')}]`))
      .join('\n');
  }
  return JSON.stringify(value);
}

/**
 * Register the `github_link` agent tool.
 *
 * Registration is best-effort: a host composition without the tools service
 * still serves the HTTP API, so a missing `register` returns null instead of
 * failing the mount.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {GithubLinkHost} host
 * @returns {(() => void)|null} disposer, or null when no tools service exists.
 */
/**
 * The last agent-tool registration outcome, for GET /diagnostics.
 *
 * `{ attempted, registered, visible, error }` — `visible` is probed live from
 * the tools service, so it also catches a registration that succeeded and was
 * later removed (a reload, a scope restriction).
 */
let toolRegistration = { attempted: false, registered: false, error: null };

function registerTool(ctx, host) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools;
  if (!tools || typeof tools.register !== 'function') return null;

  const definition = {
    name: 'github_link',
    description:
      '操作当前工作区的 GitHub / Git 仓库：查看本地状态（分支、ahead/behind、文件改动）、查看提交图（带 lane 图列）、推送、拉取、提交，以及列出当前账号的 GitHub 远端仓库和已登录账号。'
      + '默认作用于当前会话的工作目录；需要别的目录时传绝对路径 path。所有输出为中文文本。'
      + '推送/拉取会自动使用插件里已登录的当前账号令牌，令牌不会写进仓库配置。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
    },
    timeoutMs: 200_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      const sessionCwd = exec?.agent?.session?.header?.cwd
        ?? exec?.agent?.session?.cwd
        ?? undefined;
      try {
        return await host.toolCall(args ?? {}, {
          resolvePath: async () => (typeof sessionCwd === 'string' ? sessionCwd : process.cwd()),
        });
      } catch (error) {
        const wire = toWireError(error, (text) => redactSecrets(text));
        // The tool surface has no error envelope: the model sees the message,
        // and the code is kept in front so it can react to NO_ACCOUNT etc.
        throw new Error(`[${wire.code}] ${wire.message}`);
      }
    },
  };

  try {
    const dispose = tools.register(definition);
    toolRegistration = { attempted: true, registered: true, error: null };
    return () => {
      toolRegistration = { attempted: true, registered: false, error: null };
      if (typeof dispose === 'function') dispose();
    };
  } catch (error) {
    // A name collision with another plugin must not take the HTTP API down,
    // but it must not be invisible either: /diagnostics reports it.
    toolRegistration = {
      attempted: true,
      registered: false,
      error: String(error && error.message ? error.message : error),
    };
    console?.warn?.(`dsh-push: github_link 工具注册失败：${error?.message ?? error}`);
    return null;
  }
}

/** Resolve the git binary this host would use right now (diagnostics). */
export function currentGitBinary(gitPath) {
  return resolveGitBinary(gitPath);
}

export { GitError, GithubError };

export default GithubLinkHost;
