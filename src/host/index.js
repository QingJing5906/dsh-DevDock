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
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') throw httpError(400, 'BAD_REQUEST', 'name 必须是字符串');
      patch.name = body.name;
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
    const result = await updateRelease({ token: account.token, owner, name, id, ...patch });
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
        // The MODEL can run the same review the dialog runs; it just cannot
        // open a dialog (that is a user-facing surface). Findings come back
        // as text so they can be read and acted on in the same turn.
        const presetIds = Array.isArray(args?.presetIds)
          ? args.presetIds.filter((id) => typeof id === 'string' && id !== '')
          : [];
        const result = await this.reviewRun({
          path: await cwd(),
          presetIds,
          customPrompt: optionalString(args?.customPrompt) ?? '',
          staged: optionalBool(args?.staged, false),
        });
        return {
          action,
          review: {
            summary: String(result.summary ?? ''),
            degraded: result.degraded === true,
            // Projected field by field: a finding legitimately omits file,
            // line and suggestion, and `undefined` is not lossless JSON, so
            // passing the objects through failed the whole tool call.
            model: result.model
              ? {
                provider: String(result.model.provider ?? ''),
                model: String(result.model.model ?? ''),
                label: String(result.model.label ?? ''),
              }
              : null,
            effort: result.effort === undefined || result.effort === null
              ? null
              : String(result.effort),
            files: result.files.map((entry) => String(entry.path)),
            findings: result.findings.map((finding) => ({
              severity: String(finding.severity ?? ''),
              category: String(finding.category ?? ''),
              title: String(finding.title ?? ''),
              detail: String(finding.detail ?? ''),
              file: finding.file === undefined ? null : String(finding.file),
              line: Number.isFinite(finding.line) ? finding.line : null,
              suggestion: finding.suggestion === undefined ? '' : String(finding.suggestion),
            })),
          },
        };
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
  /* ---------------- CONTRACT §3d: pre-push review ---------------- */

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
    post('/review/run', async ({ body }) => ({ data: await host.reviewRun(body) })),

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
