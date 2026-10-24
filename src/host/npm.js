/**
 * npm registry 客户端（DevDock 套件的 npm 模块 · Host 半边）。
 *
 * 只做**只读**的事：认账号、列包、看版本与 dist-tags、查废弃状态。
 * 刻意不做发布：npm 的发布强制 2FA，非交互场景拿不到 OTP，硬做只会做出
 * 一个"点了没反应"的按钮。发布请用 `npm publish`。
 *
 * 错误类型复用 `GithubError`：它是这套插件共享的错误载体（名字是历史遗留），
 * 已有 code → HTTP 状态的映射，另起一个类只会多一套映射。
 */
import http from 'node:http';
import https from 'node:https';
import { GithubError } from './github.js';

/** 默认 registry；可用环境变量指向镜像或测试服务器。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

const USER_AGENT = 'dsh-devdock (+https://github.com/QingJing5906/dsh-DevDock)';

/**
 * 当前 registry 基地址。
 *
 * 每次调用时读取而不是模块加载时固化：测试要能在同一进程里指向本地假
 * registry，固化会让它读到旧值。
 * @returns {string}
 */
function registryBase() {
  const raw = process.env.DSH_PUSH_NPM_REGISTRY;
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_REGISTRY;
  return value.replace(/\/+$/, '');
}

/**
 * 发一个 registry 请求。
 *
 * @param {object} options
 * @param {string} [options.method]
 * @param {string} options.path 相对 registry 基地址的路径，可含查询串。
 * @param {string} [options.token] npm granular access token。
 * @param {number} [options.timeoutMs]
 * @param {object} [options.body]
 * @returns {Promise<{status: number, headers: object, json: any, text: string}>}
 */
function request(options) {
  const base = registryBase();
  const url = `${base}${options.path}`;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000;
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/json',
  };
  if (typeof options.token === 'string' && options.token !== '') {
    headers.authorization = `Bearer ${options.token}`;
  }
  let payload;
  if (options.body !== undefined) {
    payload = Buffer.from(JSON.stringify(options.body), 'utf8');
    headers['content-type'] = 'application/json';
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
      const transport = url.startsWith('http://') ? http.request : https.request;
      req = transport(url, { method: options.method ?? 'GET', headers, signal: controller.signal });
    } catch (error) {
      done(reject, new GithubError('NETWORK', `无法连接 npm registry：${error.message}`, { cause: error }));
      return;
    }

    req.on('error', (error) => {
      const reason = error && error.name === 'AbortError'
        ? `请求超时（${timeoutMs} ms）`
        : (error && error.message) || '未知错误';
      done(reject, new GithubError('NETWORK', `无法连接 npm registry：${reason}`, { cause: error }));
    });

    req.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text === '' ? null : JSON.parse(text);
        } catch {
          json = null;
        }
        done(resolvePromise, {
          status: response.statusCode ?? 0,
          headers: response.headers,
          json,
          text,
        });
      });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 把 registry 的响应翻译成插件统一的错误。
 *
 * @param {{status: number, json: any, text: string}} response
 * @param {string} action 中文动作名，用于组织提示。
 * @returns {GithubError}
 */
function registryError(response, action) {
  const status = response.status;
  const detail = response.json && typeof response.json === 'object'
    ? String(response.json.error ?? response.json.reason ?? '')
    : '';
  const suffix = detail === '' ? '' : `：${detail}`;
  if (status === 401 || status === 403) {
    return new GithubError(
      'UNAUTHORIZED',
      `${action}被 npm 拒绝（${status}）${suffix}。请确认令牌有效，且类型为 Granular Access Token（只读即可）。`,
      { status },
    );
  }
  if (status === 404) {
    return new GithubError('NOT_FOUND', `${action}：npm 上找不到对应资源（404）${suffix}`, { status });
  }
  if (status === 429) {
    return new GithubError('RATE_LIMITED', `${action}过于频繁（429），请稍后再试${suffix}`, { status });
  }
  return new GithubError(
    'INTERNAL',
    `${action}失败（${status || '无响应'}）${suffix || `：${String(response.text || '').slice(0, 200)}`}`,
    { status },
  );
}

/**
 * 用一个令牌确认身份。
 *
 * `/-/whoami` 是唯一一个"只验令牌、不要包名"的端点；它对 granular 令牌同样
 * 有效，且不会像 `/-/user/org.couchdb.user:<name>` 那样在账号名上出歧义。
 *
 * @param {{token: string, timeoutMs?: number}} options
 * @returns {Promise<{login: string}>}
 */
export async function npmWhoami(options) {
  const token = String(options.token ?? '');
  if (token === '') throw new GithubError('BAD_REQUEST', '缺少 npm 令牌');
  const response = await request({ path: '/-/whoami', token, timeoutMs: options.timeoutMs });
  if (response.status !== 200) throw registryError(response, '校验 npm 令牌');
  const login = response.json && typeof response.json.username === 'string'
    ? response.json.username
    : '';
  if (login === '') throw new GithubError('UNAUTHORIZED', 'npm 没有返回用户名，令牌可能无效');
  return { login };
}

/**
 * 搜索某用户维护的包。
 *
 * registry 的搜索接口支持 `maintainer:` 限定符，这是唯一不依赖"先知道包名"
 * 的枚举方式；结果会再按维护者过滤一遍，因为限定符对 scope 包有时不精确。
 *
 * @param {{token?: string, login: string, size?: number, from?: number, timeoutMs?: number}} options
 * @returns {Promise<{items: object[], total: number}>}
 */
export async function npmSearchByMaintainer(options) {
  const login = String(options.login ?? '').trim();
  if (login === '') throw new GithubError('BAD_REQUEST', '缺少 npm 用户名');
  const size = Number.isFinite(options.size) ? Math.min(250, Math.max(1, Math.trunc(options.size))) : 20;
  const from = Number.isFinite(options.from) ? Math.max(0, Math.trunc(options.from)) : 0;
  const query = new URLSearchParams({
    text: `maintainer:${login}`,
    size: String(size),
    from: String(from),
  });
  const response = await request({
    path: `/-/v1/search?${query.toString()}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status !== 200) throw registryError(response, '搜索 npm 包');
  const objects = response.json && Array.isArray(response.json.objects) ? response.json.objects : [];
  const total = response.json && Number.isFinite(response.json.total) ? response.json.total : objects.length;
  return {
    items: objects.map((entry) => mapSearchItem(entry, login)),
    total,
  };
}

/**
 * 搜索结果的精简投影。
 *
 * 只保留界面要显示的字段：原始条目有三层嵌套，直接透传会让客户端契约
 * 随着 registry 的字段增删而漂移。
 *
 * @param {object} entry
 * @param {string} [login] 用于判断是否本人维护。
 * @returns {object}
 */
export function mapSearchItem(entry, login) {
  const pkg = (entry && entry.package) || {};
  const score = (entry && entry.score) || {};
  const maintainers = Array.isArray(pkg.maintainers)
    ? pkg.maintainers.map((m) => (typeof m === 'string' ? m : m && m.username)).filter(Boolean)
    : [];
  return {
    name: typeof pkg.name === 'string' ? pkg.name : '',
    version: typeof pkg.version === 'string' ? pkg.version : '',
    description: typeof pkg.description === 'string' ? pkg.description : '',
    date: typeof pkg.date === 'string' ? pkg.date : '',
    links: pkg.links && typeof pkg.links === 'object' ? pkg.links : {},
    maintainers,
    owned: typeof login === 'string' && login !== ''
      ? maintainers.some((name) => name === login)
      : null,
    score: Number.isFinite(score.final) ? Math.round(score.final * 1000) / 1000 : null,
  };
}

/**
 * 取一个包的 packument（全部版本信息）。
 *
 * registry 对单个包返回整份文档，可能很大（几十上百个版本）。这里把它投影成
 * 界面需要的最小结构，并按发布时间倒序，避免客户端自己排序时出错。
 *
 * @param {{name: string, token?: string, timeoutMs?: number}} options
 * @returns {Promise<object>}
 */
export async function npmPackument(options) {
  const name = String(options.name ?? '').trim();
  if (name === '') throw new GithubError('BAD_REQUEST', '缺少包名');
  const response = await request({
    path: `/${encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')}`,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  if (response.status !== 200) throw registryError(response, `读取包 ${name}`);
  return { pkg: mapPackument(response.json, name) };
}

/**
 * packument → 精简结构。
 *
 * @param {object} raw
 * @param {string} [fallbackName]
 * @returns {object}
 */
export function mapPackument(raw, fallbackName = '') {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const versions = doc.versions && typeof doc.versions === 'object' ? doc.versions : {};
  const times = doc.time && typeof doc.time === 'object' ? doc.time : {};
  const distTags = doc['dist-tags'] && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : {};
  const latestVersion = typeof distTags.latest === 'string' ? distTags.latest : '';

  const rows = Object.keys(versions).map((version) => {
    const entry = versions[version] || {};
    const deprecated = typeof entry.deprecated === 'string' ? entry.deprecated : '';
    return {
      version,
      publishedAt: typeof times[version] === 'string' ? times[version] : '',
      deprecated,
      // 一个版本是否被 superceded 由 dist-tags 决定，客户端不该自己算
      isLatest: version === latestVersion,
      license: typeof entry.license === 'string' ? entry.license : '',
    };
  }).sort((a, b) => {
    // 发布时间倒序；没有时间戳的排最后
    const ta = a.publishedAt === '' ? 0 : Date.parse(a.publishedAt);
    const tb = b.publishedAt === '' ? 0 : Date.parse(b.publishedAt);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const latestEntry = latestVersion !== '' ? (versions[latestVersion] || {}) : {};
  // 发布目标的体积与文件数在 dist 上，是"这个包有多大"唯一可靠的来源。
  const latestDist = (latestEntry.dist && typeof latestEntry.dist === 'object') ? latestEntry.dist : {};
  const repository = latestEntry.repository;
  const repositoryUrl = typeof repository === 'string'
    ? repository
    : (repository && typeof repository.url === 'string' ? repository.url : '');

  return {
    name: typeof doc.name === 'string' ? doc.name : fallbackName,
    description: typeof doc.description === 'string' ? doc.description : '',
    distTags: Object.fromEntries(
      Object.entries(distTags).filter(([, value]) => typeof value === 'string'),
    ),
    latestVersion,
    latestPublishedAt: latestVersion !== '' && typeof times[latestVersion] === 'string'
      ? times[latestVersion]
      : '',
    created: typeof times.created === 'string' ? times.created : '',
    modified: typeof times.modified === 'string' ? times.modified : '',
    license: typeof latestEntry.license === 'string' ? latestEntry.license : '',
    homepage: typeof latestEntry.homepage === 'string' ? latestEntry.homepage : '',
    repository: repositoryUrl,
    keywords: Array.isArray(latestEntry.keywords)
      ? latestEntry.keywords.filter((k) => typeof k === 'string').slice(0, 12)
      : [],
    maintainers: Array.isArray(doc.maintainers)
      ? doc.maintainers
        .map((m) => (typeof m === 'string' ? m : m && m.username))
        .filter((m) => typeof m === 'string')
      : [],
    versions: rows,
    versionCount: rows.length,
    deprecatedVersions: rows.filter((row) => row.deprecated !== '').length,
    // 下面这些让包详情在本地就能看全，不必跳去 npmjs.com。
    dependencies: latestEntry.dependencies && typeof latestEntry.dependencies === 'object'
      ? latestEntry.dependencies : {},
    peerDependencies: latestEntry.peerDependencies && typeof latestEntry.peerDependencies === 'object'
      ? latestEntry.peerDependencies : {},
    engines: latestEntry.engines && typeof latestEntry.engines === 'object'
      ? latestEntry.engines : {},
    unpackedSize: Number.isFinite(latestDist.unpackedSize) ? latestDist.unpackedSize : null,
    fileCount: Number.isFinite(latestDist.fileCount) ? latestDist.fileCount : null,
    tarball: typeof latestDist.tarball === 'string' ? latestDist.tarball : '',
    integrity: typeof latestDist.integrity === 'string' ? latestDist.integrity : '',
    htmlUrl: `https://www.npmjs.com/package/${encodeURIComponent(
      typeof doc.name === 'string' ? doc.name : fallbackName,
    )}`,
  };
}

/**
 * 只取一个包的最新版本号。
 *
 * `/-/package/<name>/dist-tags` 返回的是一个极小的对象，比整份 packument
 * 小两个数量级——检查一个项目的全部依赖时，这个差别决定了能不能秒回。
 *
 * @param {{name: string, token?: string, timeoutMs?: number}} options
 * @returns {Promise<{name: string, latest: string|null, error?: string}>}
 */
export async function npmLatestVersion(options) {
  const name = String(options.name ?? '').trim();
  if (name === '') return { name, latest: null, error: 'BAD_NAME' };
  try {
    const path = `/-/package/${encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')}/dist-tags`;
    const response = await request({ path, token: options.token, timeoutMs: options.timeoutMs ?? 12_000 });
    if (response.status !== 200) {
      return { name, latest: null, error: response.status === 404 ? 'NOT_FOUND' : 'HTTP_' + response.status };
    }
    const latest = response.json && typeof response.json.latest === 'string' ? response.json.latest : null;
    return { name, latest };
  } catch (error) {
    return { name, latest: null, error: error && error.code ? error.code : 'NETWORK' };
  }
}

/** 包在 npmjs.com 上的页面地址。 *//** 包在 npmjs.com 上的页面地址。 */
export function packageHtmlUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(String(name ?? ''))}`;
}
