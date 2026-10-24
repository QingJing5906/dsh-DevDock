/**
 * npm CLI 执行器（DevDock 的 npm 模块 · 打包/发布）。
 *
 * 这里只做一件 registry API 做不到的事：真正运行 npm 自己的命令。
 * `npm pack` 的文件筛选规则（files 字段、.npmignore、默认忽略项）复杂到
 * 不值得重写一遍——由 npm 自己算，结果才和用户之后手动执行一致。
 *
 * 令牌只通过**环境变量**传入（`npm_config_//registry.npmjs.org/:_authToken`），
 * 不出现在 argv 里：argv 在进程列表、错误日志、崩溃转储里都可能被看到。
 *
 * 与 GitRunner 相同的两段式捕获：正常走管道；受限宿主上管道会 EPERM，
 * 那时改用临时文件重定向——否则打包/发布在这个宿主上根本用不了。
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** npm 可执行文件。Windows 上是 npm.cmd，否则 spawn 找不到。 */
export function resolveNpmBinary() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * 把令牌折成 npm 能读的环境变量。
 *
 * npm 的配置项都可以用 `npm_config_<key>` 覆盖，带斜杠的嵌套键同样成立。
 *
 * @param {string} token
 * @param {string} [registry]
 * @returns {Record<string, string>}
 */
export function npmAuthEnv(token, registry = 'https://registry.npmjs.org') {
  const env = {};
  if (typeof token === 'string' && token !== '') {
    const host = registry.replace(/^https?:/, '').replace(/\/+$/, '');
    env[`npm_config_${host}/:_authToken`] = token;
  }
  env.npm_config_registry = registry;
  // 没有终端：任何交互式提示都必须立刻失败而不是挂住。
  env.npm_config_yes = 'true';
  env.npm_config_progress = 'false';
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  env.npm_config_color = 'false';
  return env;
}

/** 一次 npm 调用的错误。 */
export class NpmError extends Error {
  /**
   * @param {string} code TIMEOUT|EPERM|FAILED
   * @param {string} message 中文可读信息
   * @param {{stdout?: string, stderr?: string, exitCode?: number}} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NpmError';
    this.code = code;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
    this.exitCode = details.exitCode ?? null;
  }
}

export class NpmRunner {
  /** @param {{binary?: string, timeoutMs?: number}} [options] */
  constructor(options = {}) {
    this.#binary = options.binary || resolveNpmBinary();
    this.#timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180_000;
  }

  #binary;
  #timeoutMs;

  /**
   * 运行一条 npm 子命令。
   *
   * @param {string[]} args
   * @param {object} [options]
   * @param {string} [options.cwd]
   * @param {Record<string,string>} [options.env]
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.allowFailure] 非零退出也 resolve，由调用方看 code
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async run(args, options = {}) {
    let result;
    try {
      result = await this.#runPiped(args, options);
    } catch (error) {
      const denied = error?.code === 'EPERM'
        || error?.cause?.code === 'EPERM'
        || /EPERM/.test(String(error?.message ?? ''));
      if (!denied) throw error;
      result = await this.#runToFiles(args, options);
    }

    if (result.code !== 0 && !options.allowFailure) {
      const firstLine = (result.stderr || result.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' / ');
      throw new NpmError('FAILED', `npm 执行失败（退出码 ${result.code}）：${firstLine}`, result);
    }
    return result;
  }

  /** spawn 时共用的选项。 */
  #spawnOptions(options, stdio) {
    return {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      // Windows 上 npm 是 .cmd，必须经 shell 才能执行。
      shell: process.platform === 'win32',
      stdio,
    };
  }

  /** 正常路径：管道捕获。 */
  #runPiped(args, options) {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.#binary, args, this.#spawnOptions(options, ['ignore', 'pipe', 'pipe']));
      } catch (error) {
        reject(new NpmError('FAILED', `无法启动 npm：${error.message}`));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        finish(reject, new NpmError('TIMEOUT', `npm 执行超时（${Math.round(timeoutMs / 1000)} 秒）`, { stdout, stderr }));
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        finish(reject, new NpmError('EPERM', `npm 启动失败：${error.message}`, { stdout, stderr }));
      });
      child.on('close', (code) => finish(resolve, { stdout, stderr, code: code ?? 0 }));
    });
  }

  /**
   * 受限宿主路径：两个流都重定向到临时文件。
   *
   * 文件用 0o600 创建并在 finally 里删除——npm 的输出可能包含包内路径，
   * 不该留在临时目录里。
   */
  async #runToFiles(args, options) {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const token = randomBytes(8).toString('hex');
    const outPath = path.join(tmpdir(), `dsh-npm-${token}.out`);
    const errPath = path.join(tmpdir(), `dsh-npm-${token}.err`);
    let outFd;
    let errFd;
    try {
      outFd = openSync(outPath, 'w', 0o600);
      errFd = openSync(errPath, 'w', 0o600);
    } catch (error) {
      if (outFd !== undefined) closeSync(outFd);
      throw new NpmError('FAILED', `无法创建 npm 输出临时文件：${error.message}`);
    }

    try {
      const code = await new Promise((resolvePromise, reject) => {
        let child;
        try {
          child = spawn(this.#binary, args, this.#spawnOptions(options, ['ignore', outFd, errFd]));
        } catch (error) {
          reject(new NpmError('FAILED', `无法启动 npm：${error.message}`));
          return;
        }
        let settled = false;
        let timer = null;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          fn(value);
        };
        timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
          finish(reject, new NpmError('TIMEOUT', `npm 执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
        }, timeoutMs);
        child.on('error', (error) => {
          finish(reject, new NpmError('FAILED', `npm 启动失败：${error.message}`));
        });
        child.on('close', (exitCode) => {
          finish(resolvePromise, typeof exitCode === 'number' ? exitCode : 1);
        });
      });

      const stdout = readFileSync(outPath, 'utf8');
      const stderr = readFileSync(errPath, 'utf8');
      return { stdout, stderr, code };
    } finally {
      try { closeSync(outFd); } catch { /* 已关闭 */ }
      try { closeSync(errFd); } catch { /* 已关闭 */ }
      try { unlinkSync(outPath); } catch { /* 已删除 */ }
      try { unlinkSync(errPath); } catch { /* 已删除 */ }
    }
  }
}

/**
 * 解析 `npm pack --json` 的输出。
 *
 * 有些版本的 npm 会在 JSON 之前混入 prepare 脚本的日志，所以从第一个 `[`
 * 或 `{` 开始截取。
 *
 * @param {string} stdout
 * @returns {object|null}
 */
export function parsePackJson(stdout) {
  const text = String(stdout ?? '');
  const bracket = text.indexOf('[');
  const brace = text.indexOf('{');
  let start;
  if (bracket >= 0 && (brace < 0 || bracket < brace)) start = bracket;
  else if (brace >= 0) start = brace;
  else return null;
  try {
    const parsed = JSON.parse(text.slice(start));
    return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
  } catch {
    return null;
  }
}

/**
 * 把 npm pack 的 JSON 投影成界面要的形状，文件按体积倒序。
 *
 * @param {object|null} raw
 * @returns {object}
 */
export function mapPackResult(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const files = Array.isArray(entry.files) ? entry.files : [];
  return {
    filename: typeof entry.filename === 'string' ? entry.filename : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    version: typeof entry.version === 'string' ? entry.version : '',
    size: Number.isFinite(entry.size) ? entry.size : null,
    unpackedSize: Number.isFinite(entry.unpackedSize) ? entry.unpackedSize : null,
    totalFiles: Number.isFinite(entry.totalFiles) ? entry.totalFiles : files.length,
    files: files
      .map((row) => ({
        path: typeof row.path === 'string' ? row.path : '',
        size: Number.isFinite(row.size) ? row.size : 0,
      }))
      .filter((row) => row.path !== '')
      .sort((a, b) => b.size - a.size),
  };
}
