/**
 * dsh-push — GitHub REST client.
 *
 * WHY `node:https` AND NOT `fetch`/undici: this Host runs inside the DSH
 * profile process, where `fetch` is undici's implementation. On the machine
 * this plugin was written on, undici's TLS stack refuses GitHub with a
 * certificate error while nothing else about the network is broken — a
 * difference that is invisible to the user and impossible to work around from
 * inside the plugin. Plain `node:https` gives control of the socket, a real
 * timeout (AbortSignal on the request) and the exact error code, which is what
 * makes the NETWORK error message actionable instead of a generic failure.
 *
 * EVERY request carries a hard timeout. A background HTTP server must never
 * hold a browser request open on a dead socket, so the default is 15 s and the
 * abort surfaces as `NETWORK` with a Chinese message naming the TLS/proxy
 * cause and pointing at the `gitPath` setting when that is the likely culprit.
 *
 * @module src/host/github.js
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/** Default ceiling for one GitHub API call (CONTRACT-independent; the browser
 *  gives up long before a dead socket would). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The REST base URL.
 *
 * Read from the environment so a test can point the whole client at a local
 * server and exercise the real request path (status codes, headers, body
 * decoding) instead of stubbing the transport. Unset in production, where it
 * is exactly the public API.
 */
const API_BASE = process.env.DSH_PUSH_API_BASE || 'https://api.github.com';
/** GraphQL has its own endpoint; the REST helpers below never reach it. */
const GRAPHQL_URL = `${API_BASE}/graphql`;
const WEB_ORIGIN = 'https://github.com';
const ACCEPT_JSON = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
/** GitHub rejects requests without a User-Agent; this one also tells GitHub's
 *  abuse detection which software is calling. */
const USER_AGENT = 'dsh-push (+https://github.com/)';

/**
 * One GitHub failure, already translated into the CONTRACT §0 vocabulary.
 *
 * `status` is GitHub's own HTTP status when one exists — the client shows it
 * to help the user distinguish "wrong token" from "repository gone".
 */
export class GithubError extends Error {
  /**
   * @param {string} code FORBIDDEN|BAD_REQUEST|NOT_FOUND|NO_ACCOUNT|
   *   UNAUTHORIZED|RATE_LIMITED|NETWORK|INTERNAL.
   * @param {string} message human-readable Chinese message.
   * @param {{status?: number, cause?: unknown}} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GithubError';
    this.code = code;
    if (typeof details.status === 'number') this.status = details.status;
  }
}

/**
 * Translate a low-level socket error into the NETWORK code with a message a
 * Chinese-speaking user can act on.
 *
 * The message must name the actual cause because there is no way for the panel
 * to distinguish "offline" from "corporate TLS interception" from "the
 * connection timed out" — the user fixes all three differently.
 *
 * @param {NodeJS.ErrnoException|Error} error
 * @param {string} target the URL or host that failed.
 * @param {number} timeoutMs
 * @returns {GithubError}
 */
function networkError(error, target, timeoutMs) {
  const code = String(error?.code ?? '');
  const name = String(error?.name ?? '');
  const timedOut = name === 'AbortError' || code === 'ABORT_ERR' || name === 'TimeoutError';
  if (timedOut) {
    return new GithubError(
      'NETWORK',
      `连接 GitHub 超时（${Math.round(timeoutMs / 1000)} 秒）：${target}。`
      + '请检查网络或代理设置；如果只是本机 TLS 证书被拦截，可在插件设置里改用可用代理，或改用可用的 git（设置项「git 路径」）。',
      { cause: error },
    );
  }
  const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO|ERR_TLS/i.test(`${code} ${error?.message ?? ''}`);
  const dns = code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL';
  const refused = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT';
  let hint;
  if (tls) {
    hint = '本机 TLS/证书校验未能通过 GitHub 的证书（常见于系统时间错误、企业代理或杀毒软件拦截）。'
      + '请修复证书/代理，或改用可用的 git（设置项「git 路径」）。';
  } else if (dns) {
    hint = 'DNS 解析失败，请检查网络连接或代理配置。';
  } else if (refused) {
    hint = '网络连接被拒绝或中断，请检查网络、代理或防火墙。';
  } else {
    hint = '请检查网络连接、代理设置和系统时间。';
  }
  return new GithubError(
    'NETWORK',
    `无法连接 GitHub：${target}（${code || '网络错误'}）。${hint}`,
    { cause: error },
  );
}

/**
 * Send one HTTPS request and resolve with the status, headers and a decoded
 * body.
 *
 * The body is decoded as JSON when the content type says so and as text
 * otherwise; GitHub's device-flow endpoints answer `application/json` when
 * asked, but a text fallback keeps a proxy's HTML error page readable.
 *
 * @param {object} options
 * @param {'GET'|'POST'|'DELETE'|'PATCH'} options.method
 * @param {string} options.url absolute https URL.
 * @param {string} [options.token] bearer token.
 * @param {object} [options.body] JSON body.
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status: number, headers: object, json: any, text: string}>}
 */
function request(options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const headers = {
    'user-agent': USER_AGENT,
    accept: ACCEPT_JSON,
    'x-github-api-version': API_VERSION,
    ...(options.headers ?? {}),
  };
  if (typeof options.token === 'string' && options.token !== '') {
    headers.authorization = `Bearer ${options.token}`;
  }
  let payload;
  if (options.rawBody !== undefined) {
    // Release-asset uploads send the file bytes verbatim with their own content
    // type (set by the caller). Wrapping them in JSON would corrupt the upload,
    // which is why this branch exists separately from `body`.
    payload = Buffer.isBuffer(options.rawBody) ? options.rawBody : Buffer.from(options.rawBody);
    headers['content-length'] = String(payload.length);
  } else if (options.body !== undefined) {
    payload = Buffer.from(JSON.stringify(options.body), 'utf8');
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolvePromise, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    let req;
    try {
      // Pick the transport from the URL scheme. In production every URL is
      // https, so this is always `httpsRequest`; the http branch exists so a
      // test can run the REAL request path against a local plain-HTTP server
      // instead of stubbing the transport (see tests/verify-delete-semantics).
      const transport = String(options.url).startsWith('http://') ? httpRequest : httpsRequest;
      req = transport(options.url, { method: options.method, headers, signal: controller.signal }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const contentType = String(res.headers['content-type'] ?? '');
          let json;
          if (text !== '' && /json/i.test(contentType)) {
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
          }
          done(resolvePromise, {
            status: typeof res.statusCode === 'number' ? res.statusCode : 0,
            headers: res.headers,
            json,
            text,
          });
        });
        res.on('error', (error) => done(reject, networkError(error, options.url, timeoutMs)));
      });
    } catch (error) {
      clearTimeout(timer);
      reject(networkError(error, options.url, timeoutMs));
      return;
    }
    req.on('error', (error) => done(reject, networkError(error, options.url, timeoutMs)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Raise the contract-shaped error for one failed GitHub response.
 *
 * @param {{status: number, headers: object, json: any, text: string}} response
 * @param {string} action Chinese description of what was being attempted.
 * @returns {GithubError}
 */
function responseError(response, action) {
  const detail = typeof response.json?.message === 'string'
    ? response.json.message
    : response.text.slice(0, 300);
  const status = response.status;
  // GitHub signals throttling as 403 + `x-ratelimit-remaining: 0`, or 429.
  const remaining = response.headers['x-ratelimit-remaining'];
  if (status === 429 || (status === 403 && String(remaining) === '0')) {
    const reset = Number(response.headers['x-ratelimit-reset']);
    const when = Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000).toLocaleString('zh-CN')
      : '稍后';
    return new GithubError('RATE_LIMITED', `GitHub API 触发速率限制，请在 ${when} 之后重试。`, { status });
  }
  if (status === 401) {
    return new GithubError(
      'UNAUTHORIZED',
      `GitHub 令牌已失效或无权限（${action}）：${detail || '请重新登录该账号'}。`,
      { status },
    );
  }
  if (status === 404) {
    return new GithubError('NOT_FOUND', `GitHub 上找不到对应资源（${action}）：${detail || '仓库或分支可能已被删除'}。`, { status });
  }
  if (status === 403) {
    return new GithubError(
      'UNAUTHORIZED',
      `GitHub 拒绝了该操作（${action}）：${detail || '当前账号缺少所需权限范围（scope）'}。`,
      { status },
    );
  }
  if (status === 422) {
    return new GithubError('BAD_REQUEST', `GitHub 拒绝了该请求（${action}）：${detail || '参数不合法'}。`, { status });
  }
  if (status >= 400 && status < 500) {
    return new GithubError('BAD_REQUEST', `GitHub 请求失败（${action}，HTTP ${status}）：${detail}`, { status });
  }
  return new GithubError(
    'NETWORK',
    `GitHub 服务异常（HTTP ${status}，${action}）：${detail || '请稍后重试'}。`,
    { status },
  );
}

/**
 * One authenticated GitHub API call, with 401/403/429/5xx translated.
 *
 * @param {object} options see {@link request}; `action` names the operation in
 *   the Chinese error message.
 * @returns {Promise<{json: any, headers: object, status: number}>}
 */
async function api(options) {
  const response = await request(options);
  if (response.status < 200 || response.status >= 300) {
    throw responseError(response, options.action ?? '调用 GitHub API');
  }
  return { json: response.json, headers: response.headers, status: response.status };
}

/**
 * Read the scopes GitHub reports for the token in use.
 *
 * `x-oauth-scopes` is a comma-separated list; fine-grained tokens send no
 * header at all, which is why the contract allows an empty array.
 *
 * @param {object} headers
 * @returns {string[]}
 */
export function parseScopes(headers) {
  const raw = headers?.['x-oauth-scopes'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((scope) => scope.trim()).filter(Boolean);
}

/**
 * Validate a personal access token and return the account it belongs to.
 *
 * This is the ONLY place a token is proven good before it is stored, so the
 * `addedAt`/identity fields are read here rather than trusting client input.
 *
 * @param {string} token
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{login: string, name: string|null, avatarUrl: string|null,
 *   htmlUrl: string|null, scopes: string[], id: number|null}>}
 * @throws {GithubError} UNAUTHORIZED for a bad token, NETWORK for no network.
 */
export async function verifyToken(token, options = {}) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (value === '') throw new GithubError('BAD_REQUEST', '请输入 GitHub 令牌');
  const { json, headers } = await api({
    method: 'GET',
    url: `${API_BASE}/user`,
    token: value,
    timeoutMs: options.timeoutMs,
    action: '校验令牌',
  });
  if (!json || typeof json.login !== 'string') {
    throw new GithubError('UNAUTHORIZED', 'GitHub 未返回有效的用户信息，请确认令牌是否正确。');
  }
  return {
    login: json.login,
    name: typeof json.name === 'string' ? json.name : null,
    avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : null,
    htmlUrl: typeof json.html_url === 'string' ? json.html_url : null,
    scopes: parseScopes(headers),
    id: typeof json.id === 'number' ? json.id : null,
  };
}

/**
 * Map one GitHub repository payload onto the contract's `RemoteRepo`.
 * @param {any} raw
 * @returns {object}
 */
export function mapRepo(raw) {
  const repo = raw ?? {};
  const owner = repo.owner ?? {};
  return {
    id: String(repo.id ?? ''),
    owner: String(owner.login ?? ''),
    name: String(repo.name ?? ''),
    fullName: String(repo.full_name ?? ''),
    private: repo.private === true,
    fork: repo.fork === true,
    archived: repo.archived === true,
    defaultBranch: String(repo.default_branch ?? ''),
    description: typeof repo.description === 'string' ? repo.description : null,
    updatedAt: String(repo.updated_at ?? ''),
    pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
    htmlUrl: String(repo.html_url ?? ''),
    cloneUrl: String(repo.clone_url ?? ''),
    sshUrl: String(repo.ssh_url ?? ''),
    permissions: repo.permissions
      ? {
        admin: repo.permissions.admin === true,
        push: repo.permissions.push === true,
        pull: repo.permissions.pull === true,
      }
      : null,
    language: typeof repo.language === 'string' ? repo.language : null,
    stars: Number(repo.stargazers_count ?? 0),
    // Forks are shown beside stars on the cards and in the list; omitting the
    // field made every repository read as "0 forks".
    forks: Number(repo.forks_count ?? 0),
    openIssues: Number(repo.open_issues_count ?? 0),
    ownerAvatar: typeof owner.avatar_url === 'string' ? owner.avatar_url : null,
  };
}

/** The `per_page` the plugin asks for; the client pages by 30 to match. */
const PER_PAGE = 50;

/**
 * List the authenticated user's repositories (CONTRACT §2 `GET /repos`).
 *
 * `hasMore` is derived from GitHub's `Link` header when present and otherwise
 * from a full page — GitHub stops sending Link on the last page, so a short
 * page is the reliable "no more" signal.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {number} [options.page]
 * @param {string} [options.affiliation]
 * @param {string} [options.sort]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{items: object[], page: number, hasMore: boolean, total?: number}>}
 */
export async function listRepos(options) {
  const page = Number.isFinite(options.page) && options.page >= 1 ? Math.trunc(options.page) : 1;
  const affiliation = typeof options.affiliation === 'string' && options.affiliation !== ''
    ? options.affiliation
    : 'owner,collaborator,organization_member';
  const sort = typeof options.sort === 'string' && options.sort !== '' ? options.sort : 'updated';
  const { json, headers } = await api({
    method: 'GET',
    url: `${API_BASE}/user/repos?per_page=${PER_PAGE}&page=${page}`
      + `&affiliation=${encodeURIComponent(affiliation)}&sort=${encodeURIComponent(sort)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '读取仓库列表',
  });
  const items = Array.isArray(json) ? json.map(mapRepo) : [];
  const link = String(headers?.link ?? '');
  const hasMore = link !== '' ? /rel="next"/.test(link) : items.length >= PER_PAGE;
  return { items, page, hasMore };
}

/**
 * Search the authenticated user's repositories (CONTRACT §2: `q` non-empty).
 *
 * The query is narrowed with `user:<login>` and (for a multi-word query) the
 * words are ANDed, which is GitHub's own `in:name,description` behaviour once
 * the user qualifier is present.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.login the authenticated login (search qualifier).
 * @param {string} options.q
 * @param {number} [options.page]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{items: object[], page: number, hasMore: boolean, total?: number}>}
 */
export async function searchRepos(options) {
  const q = String(options.q ?? '').trim();
  if (q === '') return { items: [], page: 1, hasMore: false, total: 0 };
  const page = Number.isFinite(options.page) && options.page >= 1 ? Math.trunc(options.page) : 1;
  const query = `user:${options.login} ${q}`;
  const { json } = await api({
    method: 'GET',
    url: `${API_BASE}/search/repositories?q=${encodeURIComponent(query)}&per_page=${PER_PAGE}&page=${page}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '搜索仓库',
  });
  const items = Array.isArray(json?.items) ? json.items.map(mapRepo) : [];
  return {
    items,
    page,
    // Search caps at 1000 results; `total_count` is the honest number.
    hasMore: items.length >= PER_PAGE,
    total: Number(json?.total_count ?? items.length),
  };
}

/**
 * One repository plus its branches (CONTRACT §2 `GET /repos/detail`).
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.name
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{repo: object, branches: object[]}>}
 */
export async function repoDetail(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  if (owner === '' || name === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  const [repo, branches] = await Promise.all([
    api({
      method: 'GET',
      url: `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      token: options.token,
      timeoutMs: options.timeoutMs,
      action: '读取仓库详情',
    }),
    api({
      method: 'GET',
      url: `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100`,
      token: options.token,
      timeoutMs: options.timeoutMs,
      action: '读取分支列表',
    }),
  ]);
  const rows = Array.isArray(branches.json) ? branches.json : [];
  return {
    repo: mapRepo(repo.json),
    branches: rows.map((branch) => ({
      name: String(branch?.name ?? ''),
      sha: String(branch?.commit?.sha ?? ''),
      protected: branch?.protected === true,
    })),
  };
}

/**
 * Create a repository.
 *
 * `owner` selects the namespace: omitted (or the authenticated login) creates
 * under the user, anything else goes through the organization endpoint, which
 * is where the contract's optional `owner` field leads. A permission failure on
 * the org path is reported as-is — GitHub's message names the missing role.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.name
 * @param {string} [options.owner] organization login (or the user's own).
 * @param {string} [options.login] the authenticated login (for the comparison).
 * @param {boolean} [options.private]
 * @param {string} [options.description]
 * @param {boolean} [options.autoInit]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{repo: object}>}
 */
export async function createRepo(options) {
  const name = String(options.name ?? '').trim();
  if (name === '') throw new GithubError('BAD_REQUEST', '仓库名称不能为空');
  const owner = String(options.owner ?? '').trim();
  const login = String(options.login ?? '').trim();
  const underOrg = owner !== '' && (login === '' || owner.toLowerCase() !== login.toLowerCase());
  const { json } = await api({
    method: 'POST',
    url: underOrg ? `${API_BASE}/orgs/${encodeURIComponent(owner)}/repos` : `${API_BASE}/user/repos`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '新建仓库',
    body: {
      name,
      private: options.private !== false,
      description: typeof options.description === 'string' ? options.description : '',
      auto_init: options.autoInit === true,
    },
  });
  return { repo: mapRepo(json) };
}

/**
 * Delete a repository.
 *
 * GitHub requires the `delete_repo` scope, which PATs almost never carry — so
 * a 403 here is translated into the specific instruction instead of a bare
 * permission error.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.name
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{deleted: true}>}
 */
export async function deleteRepo(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  if (owner === '' || name === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  const response = await request({
    method: 'DELETE',
    url: `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  // 204 No Content is the only real success shape.
  if (response.status === 204 || response.status === 200) return { deleted: true };
  // A 404 is AMBIGUOUS and must not be reported as success on its own. GitHub
  // answers 404 both for "already gone" and for "you cannot see this repo at
  // all" (wrong owner, a token without `repo`, a typo, or a repo that never
  // existed). The old code returned `{deleted:true}` here, so deleting a
  // repository that did not exist — or one the token cannot reach — reported a
  // clean success and told the user their repository was gone. Ask instead
  // whether the repo is readable now: readable + 404 from DELETE means the
  // delete genuinely had nothing left to do; unreadable means it never
  // resolved, and the caller must see a real failure.
  if (response.status === 404) {
    const readable = await repoExists({
      token: options.token, owner, name, timeoutMs: options.timeoutMs,
    });
    if (readable) return { deleted: true };
    throw new GithubError(
      'NOT_FOUND',
      `找不到仓库 ${owner}/${name}：它可能从未存在、已被改名或转移，或当前令牌无权访问。`
      + '（读取需要 repo 权限范围，删除还需要 delete_repo。）',
      { status: 404 },
    );
  }
  if (response.status === 403 || response.status === 401) {
    throw new GithubError(
      'UNAUTHORIZED',
      '删除仓库需要令牌具备 delete_repo 权限范围（scope）。请重新生成带 delete_repo 的经典令牌，或直接在 GitHub 网页上删除。',
      { status: response.status },
    );
  }
  throw responseError(response, '删除仓库');
}

/**
 * Whether the authenticated token can currently see one repository.
 *
 * Used to disambiguate a 404 from a DELETE: GitHub hides inaccessible repos
 * behind the same status as absent ones. A network failure propagates (it is
 * evidence neither way); only a definite 200/404 decides. 403/401 means the
 * token cannot reach it, which is the same end state as "not visible".
 *
 * @param {{token: string, owner: string, name: string, timeoutMs?: number}} options
 * @returns {Promise<boolean>}
 */
async function repoExists(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  const response = await request({
    method: 'GET',
    url: `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  if (response.status === 403 || response.status === 401) return false;
  throw responseError(response, '检查仓库是否存在');
}

/**
 * List releases for one repository (newest first, as GitHub returns them).
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{items: object[]}>}
 */
export async function listReleases(options) {
  const owner = String(options.owner ?? '').trim();
  const repo = String(options.repo ?? '').trim();
  if (owner === '' || repo === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  const { json } = await api({
    method: 'GET',
    url: `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=50`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '读取 release 列表',
  });
  const rows = Array.isArray(json) ? json : [];
  return { items: rows.map(mapRelease) };
}

/**
 * Map one GitHub release payload onto the contract's `Release`.
 * @param {any} raw
 * @returns {object}
 */
export function mapRelease(raw) {
  const release = raw ?? {};
  return {
    id: String(release.id ?? ''),
    tagName: String(release.tag_name ?? ''),
    name: typeof release.name === 'string' ? release.name : null,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    createdAt: String(release.created_at ?? ''),
    htmlUrl: String(release.html_url ?? ''),
    // Assets ride along in the release payload. They are mapped here so the
    // panel can LIST what it uploaded and offer to remove it — without this
    // an upload was a one-way door.
    assets: Array.isArray(release.assets)
      ? release.assets.map((asset) => ({
        id: String(asset.id ?? ''),
        name: String(asset.name ?? ''),
        size: Number(asset.size ?? 0),
        downloadUrl: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      }))
      : [],
  };
}

/**
 * Create a release.
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.tagName
 * @param {string} [options.name]
 * @param {string} [options.body]
 * @param {string} [options.target] commitish for a not-yet-existing tag.
 * @param {boolean} [options.draft]
 * @param {boolean} [options.prerelease]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{release: object}>}
 */
export async function createRelease(options) {
  const owner = String(options.owner ?? '').trim();
  const repo = String(options.repo ?? '').trim();
  const tagName = String(options.tagName ?? '').trim();
  if (owner === '' || repo === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  if (tagName === '') throw new GithubError('BAD_REQUEST', '缺少标签名');
  const body = {
    tag_name: tagName,
    draft: options.draft === true,
    prerelease: options.prerelease === true,
  };
  if (typeof options.name === 'string' && options.name !== '') body.name = options.name;
  if (typeof options.body === 'string' && options.body !== '') body.body = options.body;
  if (typeof options.target === 'string' && options.target !== '') body.target_commitish = options.target;
  const { json } = await api({
    method: 'POST',
    url: `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '创建 release',
    body,
  });
  return { release: mapRelease(json) };
}

/* ------------------------------------------------------------------ */
/* Contribution calendar (GraphQL) + notifications (REST)             */
/* ------------------------------------------------------------------ */

/** The one GraphQL document this plugin needs (CONTRACT §2 `GET /contributions`). */
const CONTRIBUTIONS_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
      restrictedContributionsCount
    }
  }
}`;

/** Shown inline by the panel when the token simply cannot read contributions. */
const CONTRIBUTIONS_SCOPE_MESSAGE = '贡献图需要令牌具备 read:user 权限；当前令牌没有该权限。';

/** The `data` document for a token that is missing `read:user`. */
function scopeUnavailable() {
  return { unavailable: true, reason: 'SCOPE', message: CONTRIBUTIONS_SCOPE_MESSAGE };
}

/**
 * Flatten the calendar's `weeks[].contributionDays[]` into one array sorted by
 * date ascending (CONTRACT §2 `GET /contributions`).
 *
 * The client renders a seven-column grid from this array, so the ORDER is the
 * API: weeks arrive newest-last but a day grid needs plain chronological days,
 * and a malformed week must not poison the rest of the calendar.
 *
 * @param {any} weeks
 * @returns {{date: string, count: number, weekday: number}[]}
 */
export function flattenContributionDays(weeks) {
  const rows = Array.isArray(weeks) ? weeks : [];
  const days = [];
  for (const week of rows) {
    const list = Array.isArray(week?.contributionDays) ? week.contributionDays : [];
    for (const day of list) {
      const date = String(day?.date ?? '');
      if (date === '') continue;
      days.push({
        date,
        count: Number(day?.contributionCount ?? 0),
        weekday: Number(day?.weekday ?? 0),
      });
    }
  }
  days.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
  return days;
}

/** GraphQL `errors[]` → one readable Chinese-message fragment. */
function graphqlErrorText(errors) {
  const text = (Array.isArray(errors) ? errors : [])
    .map((error) => String(error?.message ?? '').trim())
    .filter(Boolean)
    .join('；');
  return text === '' ? '未知错误' : text;
}

/**
 * Does this failure mean "the token lacks the scope", rather than anything else?
 *
 * GraphQL answers a missing `read:user` either as HTTP 200 with `errors[]` or as
 * a bare 401/403. Both are recoverable from the panel's point of view (it shows
 * an inline notice), which is why they must be distinguishable from a genuine
 * network/rate-limit failure.
 *
 * @param {number} status
 * @param {any} errors
 * @param {string} message
 * @returns {boolean}
 */
function isScopeFailure(status, errors, message) {
  const types = (Array.isArray(errors) ? errors : []).map((error) => String(error?.type ?? ''));
  if (types.includes('INSUFFICIENT_SCOPES')) return true;
  const text = String(message ?? '');
  if (/resource not accessible by/i.test(text)) return true;
  if (/required scopes?/i.test(text)) return true;
  if (/not been granted/i.test(text)) return true;
  if (/insufficient (?:scope|permission)/i.test(text)) return true;
  // A 401/403 without a rate-limit header is GitHub refusing this token, and for
  // the GraphQL endpoint that is nearly always the missing-scope case.
  return status === 401 || status === 403;
}

/**
 * One authenticated GraphQL call, reusing {@link request}'s timeout/abort and
 * error machinery. Scope failures are TAGGED (`error.scope = true`) instead of
 * being turned into a different error class, so the caller decides whether they
 * become a hard failure or the panel's inline notice.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.query GraphQL document.
 * @param {Record<string, any>} [options.variables]
 * @param {string} [options.action] Chinese description for error messages.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{json: any, status: number, headers: object}>}
 */
async function githubGraphql(options) {
  const action = options.action ?? '调用 GitHub GraphQL API';
  const response = await request({
    method: 'POST',
    url: GRAPHQL_URL,
    token: options.token,
    timeoutMs: options.timeoutMs,
    body: { query: options.query, variables: options.variables ?? {} },
  });
  if (response.status < 200 || response.status >= 300) {
    const mapped = responseError(response, action);
    const detail = typeof response.json?.message === 'string'
      ? response.json.message
      : response.text.slice(0, 300);
    // A rate-limited 403 is not a scope problem: it must stay RATE_LIMITED so the
    // panel can say "wait until …" instead of "your token lacks read:user".
    if (mapped.code !== 'RATE_LIMITED' && isScopeFailure(response.status, response.json?.errors, detail)) {
      mapped.scope = true;
    }
    throw mapped;
  }
  const json = response.json;
  if (json === undefined || json === null || typeof json !== 'object') {
    throw new GithubError(
      'NETWORK',
      `GitHub GraphQL 返回了无法识别的响应（${action}）：${response.text.slice(0, 200) || '空响应'}。`,
      { status: response.status },
    );
  }
  const errors = Array.isArray(json.errors) ? json.errors : [];
  if (errors.length > 0) {
    const detail = graphqlErrorText(errors);
    if (isScopeFailure(response.status, errors, detail)) {
      const error = new GithubError(
        'UNAUTHORIZED',
        `GitHub 拒绝了 GraphQL 查询（${action}）：${detail}。`,
        { status: response.status },
      );
      error.scope = true;
      throw error;
    }
    const types = errors.map((error) => String(error?.type ?? ''));
    if (types.includes('NOT_FOUND')) {
      throw new GithubError('NOT_FOUND', `GitHub 上找不到对应资源（${action}）：${detail}。`, { status: response.status });
    }
    throw new GithubError('BAD_REQUEST', `GitHub GraphQL 查询失败（${action}）：${detail}。`, { status: response.status });
  }
  if (json.data === undefined || json.data === null) {
    throw new GithubError('NETWORK', `GitHub GraphQL 没有返回数据（${action}），请稍后重试。`, { status: response.status });
  }
  return { json: json.data, status: response.status, headers: response.headers };
}

/**
 * Read one user's contribution calendar (CONTRACT §2 `GET /contributions`).
 *
 * A token without `read:user` is NOT an error here: the panel is expected to
 * render an inline notice while the rest of the page keeps working, so the
 * resolved value says `unavailable: true` instead of throwing.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.login GitHub login (defaults handled by the caller).
 * @param {number} [options.days] window length in days, 1–365.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>}
 */
export async function contributions(options) {
  const login = String(options.login ?? '').trim();
  if (login === '') throw new GithubError('BAD_REQUEST', '缺少 GitHub 用户名');
  const windowDays = Number.isFinite(options.days) && options.days >= 1
    ? Math.min(365, Math.trunc(options.days))
    : 365;
  const toDate = new Date();
  // Both bounds are full timestamps, as the `DateTime!` variables require; the
  // calendar itself snaps to whole days.
  const from = new Date(toDate.getTime() - windowDays * 86_400_000).toISOString();
  const to = toDate.toISOString();

  let payload;
  try {
    const result = await githubGraphql({
      token: options.token,
      query: CONTRIBUTIONS_QUERY,
      variables: { login, from, to },
      timeoutMs: options.timeoutMs,
      action: '读取贡献图',
    });
    payload = result.json;
  } catch (error) {
    if (error?.scope === true) return scopeUnavailable();
    throw error;
  }

  const collection = payload?.user?.contributionsCollection;
  const calendar = collection?.contributionCalendar;
  if (!calendar) {
    throw new GithubError(
      'NOT_FOUND',
      `找不到 GitHub 用户 ${login} 的贡献数据，请确认用户名是否正确。`,
      { status: 200 },
    );
  }
  const weeks = Array.isArray(calendar.weeks) ? calendar.weeks : [];
  return {
    total: Number(calendar.totalContributions ?? 0),
    days: flattenContributionDays(weeks),
    weeks: weeks.length,
    restricted: Number(collection.restrictedContributionsCount ?? 0),
    login: String(payload?.user?.login ?? login),
    from,
    to,
  };
}

/** API resource segment → the web path that renders it. */
const NOTIFICATION_WEB_PATH = Object.freeze({
  pulls: '/pull',
  issues: '/issues',
  commits: '/commit',
  discussions: '/discussions',
});

/**
 * Convert a notification's API `subject.url` to the web URL the panel opens.
 *
 * The REST notification payload only carries the API URL
 * (`https://api.github.com/repos/{owner}/{repo}/{kind}/{id}`), and the mapping is
 * NOT a plain suffix swap: `pulls/{n}` becomes `/pull/{n}`, `commits/{sha}`
 * becomes `/commit/{sha}`, and a release has no per-id page at all.
 *
 * @param {string} subjectUrl
 * @param {string} [fallbackRepo] `owner/name`, used when the URL is unusable.
 * @returns {string}
 */
export function notificationHtmlUrl(subjectUrl, fallbackRepo = '') {
  let segments = [];
  try {
    segments = new URL(String(subjectUrl ?? '')).pathname.split('/').filter(Boolean);
  } catch {
    segments = [];
  }
  // /repos/{owner}/{repo}/{kind}/{id}
  if (segments.length >= 4 && segments[0] === 'repos') {
    const owner = segments[1];
    const repo = segments[2];
    const kind = segments[3];
    const id = segments[4];
    const base = `${WEB_ORIGIN}/${owner}/${repo}`;
    if (kind === 'releases') return `${base}/releases`;
    const suffix = NOTIFICATION_WEB_PATH[kind];
    if (suffix !== undefined && typeof id === 'string' && id !== '') return `${base}${suffix}/${id}`;
    return base;
  }
  const fallback = String(fallbackRepo ?? '').trim();
  return fallback === '' ? WEB_ORIGIN : `${WEB_ORIGIN}/${fallback}`;
}

/**
 * Map one GitHub notification payload onto the contract's notification object.
 *
 * GitHub puts the repository on the notification root; the CONTRACT §2 wording
 * names `subject.repository`, so both positions are accepted and the web URL
 * falls back to the repository when `subject.url` is unusable.
 *
 * @param {any} raw
 * @returns {object}
 */
export function mapNotification(raw) {
  const row = raw ?? {};
  const subject = row.subject ?? {};
  const repo = typeof subject.repository?.full_name === 'string'
    ? subject.repository.full_name
    : (typeof row.repository?.full_name === 'string' ? row.repository.full_name : '');
  return {
    id: String(row.id ?? ''),
    title: String(subject.title ?? ''),
    type: String(subject.type ?? ''),
    repo,
    reason: String(row.reason ?? ''),
    unread: row.unread === true,
    updatedAt: String(row.updated_at ?? ''),
    url: notificationHtmlUrl(subject.url, repo),
  };
}

/**
 * List notifications (CONTRACT §2 `GET /notifications`).
 *
 * GitHub caps `per_page` at 50; `unreadCount` is scoped to THIS page on purpose
 * (the panel shows "N unread in the list you are looking at", not a global
 * counter that a paged view could never reconcile).
 *
 * @param {object} options
 * @param {string} options.token
 * @param {boolean} [options.all] `true` includes already-read threads.
 * @param {number} [options.limit] 1–50, default 30.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{items: object[], unreadCount: number}>}
 */
export async function listNotifications(options) {
  const limit = Number.isFinite(options.limit)
    ? Math.min(50, Math.max(1, Math.trunc(options.limit)))
    : 30;
  const all = options.all === true;
  const { json } = await api({
    method: 'GET',
    url: `${API_BASE}/notifications?per_page=${limit}&all=${all ? 'true' : 'false'}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '读取通知列表',
  });
  const items = Array.isArray(json) ? json.map(mapNotification) : [];
  return { items, unreadCount: items.filter((item) => item.unread === true).length };
}

/**
 * Mark ONE notification thread read (CONTRACT §2 `POST /notifications/read`).
 *
 * GitHub answers PATCH with `205 Reset Content` and no body, so success is the
 * status range — there is nothing to parse and no envelope to unwrap.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.id notification thread id.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{read: true}>}
 */
export async function markNotificationRead(options) {
  const id = String(options.id ?? '').trim();
  if (id === '') throw new GithubError('BAD_REQUEST', '缺少通知 id');
  const response = await request({
    method: 'PATCH',
    url: `${API_BASE}/notifications/threads/${encodeURIComponent(id)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status >= 200 && response.status < 300) return { read: true };
  if (response.status === 404) {
    throw new GithubError('NOT_FOUND', `找不到这条通知（${id}），它可能已被删除。`, { status: 404 });
  }
  throw responseError(response, '标记通知已读');
}

/* ------------------------------------------------------------------ */
/* Device flow (OAuth app sign-in)                                     */
/* ------------------------------------------------------------------ */

/**
 * Start the OAuth device flow.
 *
 * Device flow is the only sign-in that works without a redirect URL, which is
 * what a desktop plugin needs: the user types a short code on github.com and
 * the Host polls for the token.
 *
 * @param {object} options
 * @param {string} options.clientId the OAuth app's client id (settings).
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{verificationUri: string, userCode: string,
 *   deviceCode: string, expiresIn: number, interval: number}>}
 */
export async function startDeviceFlow(options) {
  const clientId = String(options.clientId ?? '').trim();
  if (clientId === '') {
    throw new GithubError('BAD_REQUEST', '未配置 oauthClientId：请先在设置里填入 GitHub OAuth 应用的 Client ID，或改用个人访问令牌登录。');
  }
  const response = await request({
    method: 'POST',
    url: `${WEB_ORIGIN}/login/device/code`,
    timeoutMs: options.timeoutMs,
    // These two endpoints want plain JSON, not the API's versioned media type.
    headers: { accept: 'application/json' },
    body: { client_id: clientId, scope: 'repo read:user' },
  });
  if (response.status >= 400 || !response.json) {
    throw responseError(response, '发起设备码登录');
  }
  const json = response.json;
  if (typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
    throw new GithubError('INTERNAL', `GitHub 设备码接口返回了无法识别的响应：${response.text.slice(0, 200)}`);
  }
  return {
    verificationUri: String(json.verification_uri ?? json.verification_url ?? 'https://github.com/login/device'),
    userCode: json.user_code,
    deviceCode: json.device_code,
    expiresIn: Number(json.expires_in ?? 900),
    interval: Number(json.interval ?? 5),
  };
}

/**
 * Poll the device flow once.
 *
 * Polling is the CLIENT's job (it owns the countdown and the interval), so this
 * function performs exactly one poll and reports the state honestly:
 * `pending` and `slow_down` are normal outcomes, not errors.
 *
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.deviceCode
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status: 'pending'|'slow_down'|'done', token?: string}>}
 */
export async function pollDeviceFlow(options) {
  const clientId = String(options.clientId ?? '').trim();
  const deviceCode = String(options.deviceCode ?? '').trim();
  if (clientId === '') throw new GithubError('BAD_REQUEST', '未配置 oauthClientId');
  if (deviceCode === '') throw new GithubError('BAD_REQUEST', '缺少 deviceCode');
  const response = await request({
    method: 'POST',
    url: `${WEB_ORIGIN}/login/oauth/access_token`,
    timeoutMs: options.timeoutMs,
    headers: { accept: 'application/json' },
    body: {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
  });
  const json = response.json;
  if (!json) {
    throw new GithubError('INTERNAL', `GitHub 设备码接口返回了无法识别的响应：${response.text.slice(0, 200)}`);
  }
  if (typeof json.access_token === 'string' && json.access_token !== '') {
    return { status: 'done', token: json.access_token };
  }
  const error = String(json.error ?? '');
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down' };
  if (error === 'expired_token') {
    throw new GithubError('BAD_REQUEST', '设备码已过期，请重新发起登录。');
  }
  if (error === 'access_denied') {
    throw new GithubError('UNAUTHORIZED', '你已取消 GitHub 授权。');
  }
  if (error === 'incorrect_client_credentials') {
    throw new GithubError('BAD_REQUEST', 'oauthClientId 不正确：请核对 GitHub OAuth 应用的 Client ID。');
  }
  throw new GithubError('INTERNAL', `设备码轮询失败：${json.error_description ?? error ?? '未知错误'}`);
}

/**
 * The HTML URL of a repository, for "open in browser" actions.
 * @param {string} owner
 * @param {string} name
 * @returns {string}
 */
/**
 * Byte counts per language for one repository (CONTRACT 2, GET /repos/languages).
 *
 * GitHub returns a map of language to raw bytes, unordered. The panel draws a
 * proportion bar, so this normalizes to a sorted array with the percentage
 * already computed. Computing it here rather than in the client keeps two
 * surfaces from disagreeing.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.name
 * @returns {Promise<{items: {name: string, bytes: number, percent: number}[]}>}
 */
export async function repoLanguages(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  if (owner === '' || name === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  const response = await request({
    method: 'GET',
    url: API_BASE + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/languages',
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status !== 200) {
    if (response.status === 404) return { items: [] };
    throw responseError(response, '读取语言构成');
  }
  const raw = response.json && typeof response.json === 'object' ? response.json : {};
  const entries = Object.entries(raw)
    .map(([language, bytes]) => ({ name: language, bytes: Number(bytes) || 0 }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    items: entries.map((entry) => ({
      name: entry.name,
      bytes: entry.bytes,
      // One decimal is enough for a bar; the client renders the same number it
      // was given, so rounding here is the single source of truth.
      percent: total > 0 ? Math.round((entry.bytes / total) * 1000) / 10 : 0,
    })),
  };
}

/**
 * Upload one asset to an existing release (CONTRACT 2, POST /releases/asset).
 *
 * GitHub's upload endpoint is NOT on api.github.com: it is
 * uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets?name=... with the
 * bytes as the raw request body and an explicit content type. Sending it to the
 * API host silently 404s, which is the classic mistake here, so the URL is
 * derived from API_BASE rather than written out twice.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.name repository name.
 * @param {string|number} options.releaseId
 * @param {string} options.fileName
 * @param {Buffer} options.bytes
 * @param {string} [options.contentType]
 * @returns {Promise<{asset: object}>}
 */
export async function uploadReleaseAsset(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  const releaseId = String(options.releaseId ?? '').trim();
  const fileName = String(options.fileName ?? '').trim();
  if (owner === '' || name === '' || releaseId === '') {
    throw new GithubError('BAD_REQUEST', '缺少仓库或发布 id');
  }
  if (fileName === '') throw new GithubError('BAD_REQUEST', '缺少文件名');
  const bytes = options.bytes;
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) {
    throw new GithubError('BAD_REQUEST', '文件内容为空');
  }

  // Derive the uploads host structurally. A literal string replace on
  // API_BASE only works for the production spelling; if the base is overridden
  // (tests, enterprise) the upload would silently go to the API host and 404.
  const uploadBase = (() => {
    try {
      const url = new URL(API_BASE);
      // api.github.com -> uploads.github.com; anything else keeps its host but
      // is still reported clearly if GitHub ever rejects it.
      url.hostname = url.hostname.replace(/^api\./, 'uploads.');
      return url.origin;
    } catch {
      return API_BASE;
    }
  })();
  const url = uploadBase + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name)
    + '/releases/' + encodeURIComponent(releaseId) + '/assets?name=' + encodeURIComponent(fileName);

  const response = await request({
    method: 'POST',
    url,
    token: options.token,
    timeoutMs: options.timeoutMs ?? 120000,
    headers: {
      // The generic JSON accept is wrong for an upload; ask for JSON back but
      // send raw bytes with their own type.
      'content-type': options.contentType || 'application/octet-stream',
    },
    rawBody: bytes,
  });
  if (response.status !== 201 && response.status !== 200) {
    throw responseError(response, '上传发布附件');
  }
  const asset = response.json ?? {};
  return {
    asset: {
      id: String(asset.id ?? ''),
      name: String(asset.name ?? fileName),
      size: Number(asset.size ?? bytes.length),
      downloadUrl: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
    },
  };
}


export function repoHtmlUrl(owner, name) {
  return `${WEB_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/* ------------------------------------------------------------------ */
/* Repository management (CONTRACT §3c)                                */
/* ------------------------------------------------------------------ */

/** `{owner}/{name}` URL segment, encoded once. */
function repoPath(owner, name) {
  const safeOwner = String(owner ?? '').trim();
  const safeName = String(name ?? '').trim();
  if (safeOwner === '' || safeName === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  return `${API_BASE}/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeName)}`;
}

/**
 * Does this error mean "the token is missing a permission/scope"?
 *
 * TWO CASES MUST BE DISTINGUISHED for {@link managementFetch}: a 403/404 that
 * GitHub sends because the token cannot SEE a feature (webhooks without
 * `admin:repo_hook`, collaborators without push access) is expected and becomes
 * a warning; anything else (network, rate limit) is also a warning but needs a
 * different sentence. Fine-grained tokens report nothing in `x-oauth-scopes`,
 * so the HTTP status is the signal.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isScopeError(error) {
  if (error?.code !== 'UNAUTHORIZED' && error?.code !== 'FORBIDDEN' && error?.code !== 'NOT_FOUND') return false;
  return !/速率限制/.test(String(error?.message ?? ''));
}

/**
 * Map one `/branches` payload row onto CONTRACT §2/§3c `Branch`.
 * @param {any} raw
 * @returns {{name: string, sha: string, protected: boolean}}
 */
function mapBranch(raw) {
  const branch = raw ?? {};
  return {
    name: String(branch.name ?? ''),
    sha: String(branch.commit?.sha ?? ''),
    protected: branch.protected === true,
  };
}

/** Map one `/collaborators` row onto CONTRACT §3c's shape. */
function mapCollaborator(raw) {
  const user = raw ?? {};
  // Fine-grained permissions arrive as `{ pull, push, admin, … }`; classic ones
  // as a single `role_name`/`permission` string. The UI only needs a label.
  const permissions = user.permissions ?? {};
  let role = typeof user.role_name === 'string' && user.role_name !== '' ? user.role_name : '';
  if (role === '') {
    if (permissions.admin === true) role = 'admin';
    else if (permissions.maintain === true) role = 'maintain';
    else if (permissions.push === true) role = 'write';
    else if (permissions.triage === true) role = 'triage';
    else if (permissions.pull === true) role = 'read';
    else role = String(user.permission ?? 'read');
  }
  return {
    login: String(user.login ?? ''),
    avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
    role,
  };
}

/** Map one `/hooks` row onto CONTRACT §3c's shape. */
function mapWebhook(raw) {
  const hook = raw ?? {};
  const config = hook.config ?? {};
  return {
    id: String(hook.id ?? ''),
    url: String(config.url ?? ''),
    events: Array.isArray(hook.events) ? hook.events.filter((event) => typeof event === 'string') : [],
    active: hook.active === true,
  };
}

/**
 * Call one GitHub endpoint for the management aggregate.
 *
 * @param {{token: string, owner: string, name: string, path: string,
 *   action: string, timeoutMs?: number}} options
 * @returns {Promise<{json: any, headers: object}>}
 */
function manageRequest(options) {
  return api({
    method: 'GET',
    url: `${repoPath(options.owner, options.name)}${options.path}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: options.action,
  });
}

/**
 * Turn the six settled sub-requests into the CONTRACT §3c document.
 *
 * EXTRACTED AS A PURE FUNCTION so the interesting rule — "a rejected
 * sub-request becomes `null` plus a Chinese warning, never a failed call" — can
 * be verified without a live GitHub and without patching the network. `settled`
 * is exactly what {@link repoManage}'s `Promise.allSettled` produced.
 *
 * @param {PromiseSettledResult<{json: any}>[]} settled
 *   [repo, branches, releases, collaborators, webhooks, openPRs]
 * @returns {object} the contract document (throws only for a rejected repo).
 */
export function assembleRepoManage(settled) {
  const [repoResult] = settled;
  if (repoResult.status === 'rejected') {
    // A repository the token cannot read means there is nothing to manage; the
    // contract's "partial failure" rule is about SUB-resources, not this one.
    const error = repoResult.reason;
    if (isScopeError(error)) {
      throw new GithubError(
        'UNAUTHORIZED',
        '无法读取该仓库：当前账号没有访问权限（或令牌缺少 repo 权限范围）。',
        { status: error?.status },
      );
    }
    throw error;
  }

  const rawRepo = repoResult.value?.json ?? {};
  const repo = mapRepo(rawRepo);
  const warnings = [];
  /** The parsed payload of one fulfilled sub-result, else null. */
  const valueAt = (at) => (settled[at].status === 'fulfilled' ? settled[at].value?.json : null);
  /**
   * Turn one rejection into a warning.
   *
   * A missing scope is named AS a missing scope (`缺少 admin:repo_hook 权限…`)
   * because "forbidden" alone does not tell the user which token to mint.
   * Anything else reports GitHub's own (already Chinese-framed) message.
   */
  const warn = (at, scopeMessage, action) => {
    if (settled[at].status !== 'rejected') return;
    const reason = settled[at].reason;
    warnings.push(isScopeError(reason)
      ? scopeMessage
      : `${action}失败：${reason?.message ?? '未知原因'}`);
  };

  let branches = null;
  if (Array.isArray(valueAt(1))) branches = valueAt(1).map(mapBranch);
  else warn(1, '缺少读取分支的权限，无法显示分支列表（需要 repo 权限范围）', '读取分支列表');

  let releases = null;
  if (Array.isArray(valueAt(2))) releases = valueAt(2).map(mapRelease);
  else warn(2, '缺少读取发布的权限，无法显示发布列表（需要 repo 权限范围）', '读取发布列表');

  let collaborators = null;
  if (Array.isArray(valueAt(3))) collaborators = valueAt(3).map(mapCollaborator);
  else warn(3, '缺少读取协作者的权限，无法显示协作者列表（需要对仓库的管理权限）', '读取协作者列表');

  let webhooks = null;
  if (Array.isArray(valueAt(4))) webhooks = valueAt(4).map(mapWebhook);
  else warn(4, '缺少 admin:repo_hook 权限，无法读取 Webhook', '读取 Webhook 列表');

  let openPRs = 0;
  const searchJson = valueAt(5);
  if (settled[5].status === 'fulfilled' && Number.isFinite(Number(searchJson?.total_count))) {
    openPRs = Number(searchJson.total_count);
  } else if (settled[5].status === 'rejected') {
    // The count is a nicety, so a failure leaves a number the UI can render
    // instead of `null` in a numeric field.
    warn(5, '缺少搜索权限，无法统计开放的 Pull Request', '统计开放 PR');
  }

  // `topics` come from the repo payload; GitHub only includes them when the
  // Accept header is the versioned JSON one, which every request in this module
  // sends (`ACCEPT_JSON`). A repository created before topics existed simply
  // omits the array.
  const topics = Array.isArray(rawRepo.topics)
    ? rawRepo.topics.filter((topic) => typeof topic === 'string')
    : [];
  const license = rawRepo.license && typeof rawRepo.license === 'object'
    ? String(rawRepo.license.spdx_id ?? rawRepo.license.name ?? '') || null
    : null;
  const admin = rawRepo.permissions?.admin === true;
  const push = rawRepo.permissions?.push === true;

  return {
    repo,
    branches,
    topics,
    stats: {
      stars: Number(rawRepo.stargazers_count ?? 0),
      forks: Number(rawRepo.forks_count ?? 0),
      // `subscribers_count` is watchers; `watchers_count` is a legacy alias of
      // stars, so using it here would print the star count twice.
      watchers: Number(rawRepo.subscribers_count ?? rawRepo.watchers_count ?? 0),
      openIssues: Number(rawRepo.open_issues_count ?? 0),
      openPRs,
      sizeKb: Number(rawRepo.size ?? 0),
      language: typeof rawRepo.language === 'string' ? rawRepo.language : null,
      license,
      createdAt: String(rawRepo.created_at ?? ''),
      updatedAt: String(rawRepo.updated_at ?? ''),
      pushedAt: typeof rawRepo.pushed_at === 'string' ? rawRepo.pushed_at : null,
    },
    releases,
    collaborators,
    webhooks,
    warnings,
    can: {
      admin,
      push,
      // Deleting needs BOTH repository admin rights and a token that may delete
      // repos. For a classic PAT that is the `delete_repo` scope; for a
      // fine-grained token the scopes are invisible to us, so this is based on
      // `permissions.admin` and the UI text mentions the scope separately.
      delete: admin,
    },
  };
}

/**
 * Read the FULL management aggregate of CONTRACT §3c.
 *
 * EVERY sub-request is independent: the panel must still render stars,
 * branches and releases when the token cannot read webhooks, so a rejected
 * sub-request becomes `null` plus one Chinese warning instead of failing the
 * whole call. `Promise.allSettled` is what makes "all six in parallel, none
 * able to cancel another" true.
 *
 * OPEN PRs: counted through the SEARCH API (`/search/issues?q=repo:O/N+is:pr+
 * is:open`) rather than by parsing the `Link` header of a `per_page=1` pulls
 * page. Reason: `Link` only tells you "there is a next page", which cannot be
 * turned into a count on the last page, and GitHub's search response carries
 * `total_count` directly. A `per_page=100&state=open` pulls call would need
 * pagination of its own for a large repository.
 *
 * @param {{token: string, owner: string, name: string, timeoutMs?: number}} options
 * @returns {Promise<object>} the CONTRACT §3c document. Never rejects for a
 *   sub-request failure; DOES reject when the repository itself is unreadable.
 */
export async function repoManage(options) {
  const token = options.token;
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  if (owner === '' || name === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');

  const settled = await Promise.allSettled([
    manageRequest({ token, owner, name, path: '', action: '读取仓库详情', timeoutMs: options.timeoutMs }),
    manageRequest({ token, owner, name, path: '/branches?per_page=100', action: '读取分支列表', timeoutMs: options.timeoutMs }),
    manageRequest({ token, owner, name, path: '/releases?per_page=50', action: '读取 release 列表', timeoutMs: options.timeoutMs }),
    manageRequest({ token, owner, name, path: '/collaborators?per_page=100', action: '读取协作者列表', timeoutMs: options.timeoutMs }),
    manageRequest({ token, owner, name, path: '/hooks?per_page=100', action: '读取 Webhook 列表', timeoutMs: options.timeoutMs }),
    // Open PR count via search (`total_count`), see the doc comment above.
    api({
      method: 'GET',
      url: `${API_BASE}/search/issues?q=${encodeURIComponent(`repo:${owner}/${name} is:pr is:open`)}&per_page=1`,
      token,
      timeoutMs: options.timeoutMs,
      action: '统计开放的 Pull Request',
    }),
  ]);
  const document = assembleRepoManage(settled);
  // The repo name is only available inside the settled payload; the caller's
  // copy is already correct, so the permission message above stays generic.
  return document;
}

/**
 * `PATCH /repos/{owner}/{repo}` — update metadata (CONTRACT §3c `/repos/update`).
 *
 * Only the fields PRESENT in `patch` are sent: GitHub treats an omitted field
 * as "leave alone", and sending `description: null` for a field the user did
 * not edit would wipe it.
 *
 * @param {{token: string, owner: string, name: string, timeoutMs?: number,
 *   patch: {description?: string, homepage?: string, private?: boolean,
 *   archived?: boolean, topics?: string[], defaultBranch?: string}}} options
 * @returns {Promise<{repo: object, topics: string[]}>} `topics` is the raw
 *   payload's topic list, which the panel re-renders after an edit.
 */
export async function updateRepo(options) {
  const body = {};
  const patch = options.patch ?? {};
  if (typeof patch.description === 'string') body.description = patch.description;
  if (typeof patch.homepage === 'string') body.homepage = patch.homepage;
  if (typeof patch.private === 'boolean') body.private = patch.private;
  if (typeof patch.archived === 'boolean') body.archived = patch.archived;
  if (typeof patch.defaultBranch === 'string' && patch.defaultBranch !== '') {
    body.default_branch = patch.defaultBranch;
  }
  // Deliberately NOT added to `body`: a PATCH ignores topics entirely.
  // They are written through the dedicated endpoint below.
  const wantsTopics = Array.isArray(patch.topics);
  if (Object.keys(body).length === 0 && !wantsTopics) {
    throw new GithubError('BAD_REQUEST', '没有需要修改的字段');
  }
  // A topics-only update has an empty PATCH body; skip the request entirely
  // rather than send {} (which GitHub would reject as no-op).
  let json = null;
  if (Object.keys(body).length > 0) {
    const response = await api({
      method: 'PATCH',
      url: repoPath(options.owner, options.name),
      token: options.token,
      timeoutMs: options.timeoutMs,
      action: '修改仓库信息',
      body,
    });
    json = response.json;
  }

  // Topics are a separate resource; the PATCH above cannot carry them.
  let topics = Array.isArray(json?.topics)
    ? json.topics.filter((topic) => typeof topic === 'string')
    : [];
  if (wantsTopics) {
    const written = await setTopics({
      token: options.token,
      owner: options.owner,
      name: options.name,
      topics: patch.topics,
      timeoutMs: options.timeoutMs,
    });
    topics = written.topics;
  }

  // With no PATCH issued there is no repository payload; read the topics we
  // just wrote back and let the caller refetch the rest.
  return { repo: json ? mapRepo(json) : null, topics };
}

/**
 * Rename a branch (CONTRACT §3c `/repos/branch/rename`).
 * @param {{token: string, owner: string, name: string, from: string, to: string, timeoutMs?: number}} options
 * @returns {Promise<{renamed: true}>}
 */
export async function renameBranch(options) {
  const from = String(options.from ?? '').trim();
  const to = String(options.to ?? '').trim();
  if (from === '') throw new GithubError('BAD_REQUEST', '缺少原分支名');
  if (to === '') throw new GithubError('BAD_REQUEST', '缺少新分支名');
  await api({
    method: 'POST',
    url: `${repoPath(options.owner, options.name)}/branches/${encodeURIComponent(from)}/rename`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: `重命名分支 ${from}`,
    body: { new_name: to },
  });
  return { renamed: true };
}

/**
 * Delete a remote branch (CONTRACT §3c `/repos/branch/delete`).
 *
 * The REST API has no DELETE for branches; deleting the underlying git ref is
 * the documented way (`DELETE /git/refs/heads/{branch}`).
 *
 * @param {{token: string, owner: string, name: string, branch: string, timeoutMs?: number}} options
 * @returns {Promise<{deleted: true}>}
 */
export async function deleteBranchRemote(options) {
  const branch = String(options.branch ?? '').trim();
  if (branch === '') throw new GithubError('BAD_REQUEST', '缺少分支名');
  const response = await request({
    method: 'DELETE',
    url: `${repoPath(options.owner, options.name)}/git/refs/heads/${encodeURIComponent(branch)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status === 204 || response.status === 200) return { deleted: true };
  if (response.status === 404) {
    throw new GithubError('NOT_FOUND', `GitHub 上找不到分支 ${branch}（可能已被删除）。`, { status: 404 });
  }
  if (response.status === 403 || response.status === 422) {
    throw new GithubError(
      'UNAUTHORIZED',
      `删除分支 ${branch} 需要仓库的写入权限（且不能是默认分支或受保护分支）。`,
      { status: response.status },
    );
  }
  throw responseError(response, `删除分支 ${branch}`);
}

/**
 * Protect / unprotect a branch (CONTRACT §3c `/repos/branch/protect`).
 *
 * The PUT body is deliberately MINIMAL: requiring an exhaustive protection
 * object would let the panel's "protect" switch fail on every repository with
 * an unusual setting. GitHub fills the unspecified rules with its defaults.
 *
 * @param {{token: string, owner: string, name: string, branch: string,
 *   protected: boolean, timeoutMs?: number}} options
 * @returns {Promise<{protected: boolean}>}
 */
export async function protectBranch(options) {
  const branch = String(options.branch ?? '').trim();
  if (branch === '') throw new GithubError('BAD_REQUEST', '缺少分支名');
  const url = `${repoPath(options.owner, options.name)}/branches/${encodeURIComponent(branch)}/protection`;
  if (options.protected !== true) {
    const response = await request({ method: 'DELETE', url, token: options.token, timeoutMs: options.timeoutMs });
    if (response.status === 204 || response.status === 200) return { protected: false };
    if (response.status === 404) return { protected: false };
    if (response.status === 403) {
      throw new GithubError('UNAUTHORIZED', `取消保护分支 ${branch} 需要仓库管理员权限。`, { status: 403 });
    }
    throw responseError(response, `取消保护分支 ${branch}`);
  }
  await api({
    method: 'PUT',
    url,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: `保护分支 ${branch}`,
    body: {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    },
  });
  return { protected: true };
}

/**
 * Delete a release (CONTRACT §3c `/repos/release/delete`).
 * @param {{token: string, owner: string, name: string, id: string, timeoutMs?: number}} options
 * @returns {Promise<{deleted: true}>}
 */
/**
 * Remove one asset from a release (CONTRACT 2, POST /releases/asset/delete).
 *
 * Deleting the release itself would take its assets with it, but removing a
 * single mis-uploaded file is the common case and needs its own call.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.name
 * @param {string} options.assetId
 * @returns {Promise<{deleted: true}>}
 */
export async function deleteReleaseAsset(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  const assetId = String(options.assetId ?? '').trim();
  if (owner === '' || name === '' || assetId === '') {
    throw new GithubError('BAD_REQUEST', '缺少仓库或附件 id');
  }
  const response = await request({
    method: 'DELETE',
    url: API_BASE + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name)
      + '/releases/assets/' + encodeURIComponent(assetId),
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status === 204 || response.status === 200) return { deleted: true };
  if (response.status === 404) return { deleted: true };
  throw responseError(response, '删除发布附件');
}
export async function deleteRelease(options) {
  const id = String(options.id ?? '').trim();
  if (id === '') throw new GithubError('BAD_REQUEST', '缺少 release id');
  const response = await request({
    method: 'DELETE',
    url: `${repoPath(options.owner, options.name)}/releases/${encodeURIComponent(id)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status === 204 || response.status === 200) return { deleted: true };
  if (response.status === 404) return { deleted: true };
  throw responseError(response, '删除 release');
}

/**
 * Edit a release (CONTRACT §3c `/repos/release/update`).
 * @param {{token: string, owner: string, name: string, id: string,
 *   name?: string, body?: string, draft?: boolean, prerelease?: boolean,
 *   timeoutMs?: number}} options
 * @returns {Promise<{release: object}>}
 */
export async function updateRelease(options) {
  const id = String(options.id ?? '').trim();
  if (id === '') throw new GithubError('BAD_REQUEST', '缺少 release id');
  const patch = {};
  // `title` is the RELEASE title; `repo` is the repository. They were once both
  // `name`, and the service's spread silently put the title into the repo path.
  // `title` and `body` are nullable ON THE WIRE: an empty string here is the
  // user clearing the field, so it is sent rather than skipped.
  if (typeof options.title === 'string') patch.name = options.title;
  if (typeof options.body === 'string') patch.body = options.body;
  if (typeof options.draft === 'boolean') patch.draft = options.draft;
  if (typeof options.prerelease === 'boolean') patch.prerelease = options.prerelease;
  if (Object.keys(patch).length === 0) throw new GithubError('BAD_REQUEST', '没有需要修改的字段');
  const { json } = await api({
    method: 'PATCH',
    url: `${repoPath(options.owner, options.repo)}/releases/${encodeURIComponent(id)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '修改 release',
    body: patch,
  });
  return { release: mapRelease(json) };
}

/**
 * Add or update one collaborator (CONTRACT §3c `/repos/collaborator/add`).
 *
 * `permission` maps to GitHub's `permission` field; the classic `push`/`pull`
 * spellings are still accepted by the API and are passed through untouched so
 * the panel can offer either vocabulary.
 *
 * @param {{token: string, owner: string, name: string, user: string,
 *   permission?: string, timeoutMs?: number}} options
 * @returns {Promise<{added: true, invitation: boolean}>}
 */
export async function addCollaborator(options) {
  const user = String(options.user ?? '').trim();
  if (user === '') throw new GithubError('BAD_REQUEST', '缺少协作的 GitHub 用户名');
  const permission = typeof options.permission === 'string' && options.permission.trim() !== ''
    ? options.permission.trim()
    : 'push';
  const response = await request({
    method: 'PUT',
    url: `${repoPath(options.owner, options.name)}/collaborators/${encodeURIComponent(user)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    body: { permission },
  });
  // 201 = added outright, 204 = permission changed, 202 = invitation sent.
  if (response.status === 201 || response.status === 204) {
    return { added: true, invitation: false };
  }
  if (response.status === 202) return { added: true, invitation: true };
  throw responseError(response, `添加协作者 ${user}`);
}

/**
 * Remove one collaborator (CONTRACT §3c `/repos/collaborator/remove`).
 * @param {{token: string, owner: string, name: string, user: string, timeoutMs?: number}} options
 * @returns {Promise<{removed: true}>}
 */
export async function removeCollaborator(options) {
  const user = String(options.user ?? '').trim();
  if (user === '') throw new GithubError('BAD_REQUEST', '缺少要移除的 GitHub 用户名');
  const response = await request({
    method: 'DELETE',
    url: `${repoPath(options.owner, options.name)}/collaborators/${encodeURIComponent(user)}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status === 204 || response.status === 200) return { removed: true };
  if (response.status === 404) return { removed: true };
  if (response.status === 403) {
    throw new GithubError(
      'UNAUTHORIZED',
      `移除协作者 ${user} 需要仓库管理员权限。`,
      { status: 403 },
    );
  }
  throw responseError(response, `移除协作者 ${user}`);
}

/**
 * Replace the topic list of a repository.
 *
 * Topics are NOT part of the repository PATCH: GitHub exposes them on
 * `PUT /repos/{owner}/{repo}/topics` with a `{ names: [...] }` body, and
 * silently ignores `topics` in a PATCH. Sending them with the PATCH looked
 * like it worked (200 OK) and changed nothing.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.name
 * @param {string[]} options.topics
 * @returns {Promise<{topics: string[]}>}
 */
export async function setTopics(options) {
  const owner = String(options.owner ?? '').trim();
  const name = String(options.name ?? '').trim();
  if (owner === '' || name === '') throw new GithubError('BAD_REQUEST', '缺少仓库的 owner 或名称');
  const names = Array.isArray(options.topics)
    ? options.topics
      .map((topic) => String(topic).trim().toLowerCase())
      .filter((topic) => topic !== '')
    : [];
  const { json } = await api({
    method: 'PUT',
    url: repoPath(owner, name) + '/topics',
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '设置 topics',
    body: { names },
  });
  return {
    topics: Array.isArray(json?.names)
      ? json.names.filter((topic) => typeof topic === 'string')
      : names,
  };
}

/**
 * Rename a repository (CONTRACT §3c `/repos/rename`, requires `confirm`).
 *
 * GitHub answers 202 while it rewrites redirects in the background; that is a
 * success for the panel, so the response body (which may be empty) is only
 * used when it parses.
 *
 * @param {{token: string, owner: string, name: string, newName: string, timeoutMs?: number}} options
 * @returns {Promise<{repo: object|null, name: string}>}
 */
export async function renameRepo(options) {
  const newName = String(options.newName ?? '').trim();
  if (newName === '') throw new GithubError('BAD_REQUEST', '缺少新的仓库名称');
  const response = await request({
    method: 'PATCH',
    url: repoPath(options.owner, options.name),
    token: options.token,
    timeoutMs: options.timeoutMs,
    body: { name: newName },
  });
  if (response.status < 200 || response.status >= 300) {
    throw responseError(response, '重命名仓库');
  }
  return {
    repo: response.json && typeof response.json === 'object' ? mapRepo(response.json) : null,
    name: newName,
  };
}

/**
 * Transfer a repository to another owner (CONTRACT §3c `/repos/transfer`,
 * requires `confirm`).
 *
 * @param {{token: string, owner: string, name: string, newOwner: string, timeoutMs?: number}} options
 * @returns {Promise<{transferred: true, newOwner: string}>}
 */
export async function transferRepo(options) {
  const newOwner = String(options.newOwner ?? '').trim();
  if (newOwner === '') throw new GithubError('BAD_REQUEST', '缺少新的仓库所有者');
  const { json } = await api({
    method: 'POST',
    url: `${repoPath(options.owner, options.name)}/transfer`,
    token: options.token,
    timeoutMs: options.timeoutMs,
    action: '转移仓库',
    body: { new_owner: newOwner },
  });
  // The transfer endpoint returns 202 with a `message` document (not the repo).
  return {
    transferred: true,
    newOwner,
    message: typeof json?.message === 'string' ? json.message : undefined,
  };
}
