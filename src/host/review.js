/**
 * dsh-push — the pre-push review engine (CONTRACT §3d).
 *
 * Two independent passes, deliberately in this order:
 *
 *  1. **Rule pass** — cheap, deterministic, and runs even when no model is
 *     reachable. It catches the class of mistake that matters most (a live
 *     token, a private key) without spending a token on it. This is also the
 *     floor the feature degrades to when the host has no `llm` service.
 *  2. **Model pass** — the selected preset prompts plus the user's own words
 *     are sent to the host's model, which returns JSON findings.
 *
 * Neither pass may ever put a secret into a response. The rule pass records
 * positions and a redacted placeholder; the model prompt has already been
 * built from already-collected (and redacted) diff text.
 */

/** Severity order, most severe first; used for sorting and for the UI chips. */
export const SEVERITY_ORDER = ['blocker', 'high', 'medium', 'low', 'info'];

/**
 * Built-in review presets.
 *
 * These are code, not stored data: they are the product's opinion about what a
 * pre-push review should look at, and they must survive a user wiping their
 * saved presets. Titles and prompts are Chinese because every visible string in
 * this plugin is.
 */
export const BUILTIN_PRESETS = Object.freeze([
  {
    id: 'builtin_secrets_token',
    category: 'secrets',
    title: '令牌与密钥泄漏',
    description: '查找提交内容里露出的访问令牌、API Key、私钥块',
    prompt: [
      '检查以下代码差异，找出任何被写入源码或配置的凭据：GitHub/PAT 令牌、云厂商 API Key、',
      '数据库密码、SSH 或 TLS 私钥、OAuth client secret、webhook 签名密钥。',
      '特别注意：常量字符串、默认配置、注释、示例文件、测试夹具中被硬编码的密钥。',
      '对每处命中给出文件、大致行号和它属于哪一类凭据。不要复述密钥本身。',
    ].join('\n'),
  },
  {
    id: 'builtin_secrets_env',
    category: 'secrets',
    title: '凭据读取方式不当',
    description: '密钥被打印、写进日志，或被当成普通字符串拼接',
    prompt: [
      '检查差异中是否存在让凭据泄漏的使用方式：把 token/password 打进日志或异常消息、',
      '拼接进 URL 后输出、写进 localStorage 或明文文件、在错误提示里回显。',
      '指出具体位置，并给出更安全的写法建议。',
    ].join('\n'),
  },
  {
    id: 'builtin_privacy_pii',
    category: 'privacy',
    title: '个人信息与联系方式',
    description: '真实姓名、手机号、邮箱、身份证号、住址等个人数据',
    prompt: [
      '检查差异中是否包含真实的个人数据：姓名、手机号、邮箱地址、身份证/护照号、',
      '住址、银行卡号、人脸或证件照片引用。测试数据里也应使用明显的占位值而不是真人信息。',
      '对每处命中说明它是真实数据还是占位符。',
    ].join('\n'),
  },
  {
    id: 'builtin_privacy_local',
    category: 'privacy',
    title: '本机与设备信息',
    description: '绝对路径里的用户名、机器名、内网 IP、临时目录',
    prompt: [
      '检查差异中是否泄漏了本机环境信息：包含用户名的绝对路径（如 C:/Users/<姓名>/）、',
      '计算机名、内网 IP、代理地址、公司内部域名、仅在作者机器上存在的临时目录。',
      '这些会让代码在别人机器上失效，也可能暴露内部环境。给出位置与替换建议。',
    ].join('\n'),
  },
  {
    id: 'builtin_integrity_markers',
    category: 'integrity',
    title: '冲突标记与调试残留',
    description: '未解决的合并冲突、console.log、debugger、注释掉的代码',
    prompt: [
      '检查差异中是否残留：未解决的合并冲突标记（<<<<<<< / ======= / >>>>>>>）、',
      '调试语句（console.log、debugger、print、fmt.Println）、被大段注释掉却没有说明的代码、',
      '临时的 TODO/FIXME/XXX 标记。区分「有意保留」和「忘记删除」。',
    ].join('\n'),
  },
  {
    id: 'builtin_integrity_tests',
    category: 'integrity',
    title: '测试与实现不一致',
    description: '测试被删除或跳过、空实现、缺少对新增分支的覆盖',
    prompt: [
      '检查差异中新增或修改的逻辑是否有对应测试：是否有测试被删除、被 skip/xfail、',
      '断言被削弱，是否有新函数只有空实现或直接 return 占位，是否有明显未被覆盖的新分支。',
      '指出具体缺口，而不是泛泛要求「补充测试」。',
    ].join('\n'),
  },
  {
    id: 'builtin_quality_bugs',
    category: 'quality',
    title: '明显逻辑缺陷',
    description: '空值未处理、边界错误、异步未等待、资源未释放',
    prompt: [
      '检查差异中可能导致运行时错误的问题：未处理的 null/undefined、数组越界、',
      'await 遗漏导致拿到 Promise、异常吞掉后继续执行、文件或连接未关闭、',
      '竞态条件、无限循环风险。对每个问题给出触发条件。',
    ].join('\n'),
  },
  {
    id: 'builtin_quality_config',
    category: 'quality',
    title: '硬编码与配置耦合',
    description: '写死的地址、端口、密钥路径、环境假设',
    prompt: [
      '检查差异中是否把本应可配置的值写死：服务器地址、端口、超时时间、',
      '仅适用于某台机器的路径、只在开发环境成立的假设。给出应改为配置项的位置。',
    ].join('\n'),
  },
]);

/** The categories the UI groups cards by, in display order. */
export const REVIEW_CATEGORIES = Object.freeze([
  { id: 'secrets', label: '敏感信息' },
  { id: 'privacy', label: '隐私' },
  { id: 'integrity', label: '完整性' },
  { id: 'quality', label: '质量' },
  { id: 'custom', label: '自定义' },
]);

/* ------------------------------------------------------------------ */
/*  Rule pass                                                          */
/* ------------------------------------------------------------------ */

/**
 * Known credential shapes.
 *
 * Ordered most-specific first so a GitHub token is not also reported as a
 * generic "high entropy string". `secretKind` is what the finding shows the
 * user; the matched text itself is NEVER returned.
 */
const SECRET_PATTERNS = [
  { id: 'github-pat-classic', label: 'GitHub 经典令牌', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { id: 'github-pat-fine', label: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'github-oauth', label: 'GitHub OAuth 令牌', re: /\bgh[osur]_[A-Za-z0-9]{36}\b/g },
  { id: 'openai-key', label: 'OpenAI API Key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-access-key', label: 'AWS Access Key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack-token', label: 'Slack 令牌', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', label: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', label: 'Stripe 密钥', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  {
    id: 'private-key',
    label: '私钥块',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'bearer-token',
    label: 'Authorization 头中的令牌',
    re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  },
  {
    id: 'assigned-secret',
    label: '硬编码的密码 / 密钥',
    re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/gi,
  },
];

/** Values that are obviously placeholders, so an assignment is not a finding. */
const PLACEHOLDER_RE = /^(?:x{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|change[-_]?me|your[-_]|example|placeholder|dummy|test|todo|redacted|\*+)$/i;

/**
 * Scan one text block for credential shapes.
 *
 * Returns findings with a `line` (1-based within the block) and a short,
 * REDACTED excerpt: only the label and enough context to locate the line. The
 * matched secret never leaves this function.
 *
 * @param {string} text
 * @param {{file?: string, lineOffset?: number}} [where]
 * @returns {object[]} findings.
 */
export function scanSecrets(text, where = {}) {
  const findings = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0;
      const match = pattern.re.exec(line);
      if (!match) continue;
      const matched = match[0];
      // An assignment whose value is an obvious placeholder is not a leak.
      if (pattern.id === 'assigned-secret') {
        const value = /['"]([^'"]+)['"]/.exec(matched);
        if (value && PLACEHOLDER_RE.test(value[1].trim())) continue;
      }
      // Skip matches that are themselves already redacted.
      if (/(?:\*{3,}|…|\.\.\.)/.test(matched)) continue;
      findings.push({
        severity: 'blocker',
        category: 'secrets',
        title: `疑似${pattern.label}`,
        detail: `第 ${(where.lineOffset ?? 0) + i + 1} 行出现${pattern.label}形态的字符串，`
          + '其内容已被隐藏。若确实需要提交，请改从环境变量或密钥管理服务读取。',
        file: where.file,
        line: (where.lineOffset ?? 0) + i + 1,
        suggestion: '从代码中移除该值，改从环境变量或 secrets 管理读取，并立即吊销已泄漏的凭据。',
      });
      // One finding per line is enough; a line rarely holds two different kinds
      // and repeating it would bury the useful ones.
      break;
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/*  Diff collection                                                    */
/* ------------------------------------------------------------------ */

/** Files larger than this are summarized instead of being read. */
export const MAX_FILE_BYTES = 200 * 1024;

/** Guard against a runaway diff taking the whole request budget. */
const MAX_PATCH_CHARS = 400_000;


/**
 * The base a push would start from: the merge-base with the branch's upstream.
 *
 * @param {import('./git.js').GitRunner} runner
 * @param {string} path
 * @param {string} branch
 * @param {Iterable<string>} [secrets]
 * @returns {Promise<{base: string, count: number}|null>} null when nothing is outgoing.
 */
async function outgoingRange(runner, path, branch, secrets) {
  if (!branch) return null;
  // Does the branch track an upstream, and does that ref exist locally?
  const upstream = await runner.run(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd: path, allowFailure: true, secrets },
  );
  const upstreamRef = String(upstream.stdout || '').trim();
  let base = '';
  if (upstream.code === 0 && upstreamRef !== '') {
    const resolved = await runner.run(['rev-parse', upstreamRef], {
      cwd: path, allowFailure: true, secrets,
    });
    if (resolved.code === 0) base = String(resolved.stdout || '').trim();
  } else {
    // No upstream: fall back to the matching origin/ ref, which is what the
    // plugin's own push would update.
    const remoteRef = 'refs/remotes/origin/' + branch;
    const resolved = await runner.run(['rev-parse', '--verify', '--quiet', remoteRef], {
      cwd: path, allowFailure: true, secrets,
    });
    if (resolved.code === 0) base = String(resolved.stdout || '').trim();
  }

  // No base at all means this is the FIRST push of a branch: every commit in
  // the history is outgoing, so diff against the empty tree.
  const from = base !== '' ? base : EMPTY_TREE;
  const count = await runner.run(['rev-list', '--count', from + '..HEAD'], {
    cwd: path, allowFailure: true, secrets,
  });
  const n = Number(String(count.stdout || '0').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return { base: from, count: n };
}

/** The git empty-tree object, used as the base of a branch's first push. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Collect the changes that a push would send, for review.
 *
 * Same return shape as collectReviewChanges so callers (and the prompt
 * builder) do not care where the text came from.
 *
 * @param {import('./git.js').GitRunner} runner
 * @param {string} path
 * @param {object} options
 * @returns {Promise<object|null>}
 */
async function collectOutgoingChanges(runner, path, options = {}) {
  const branch = await runner.currentBranch(path).catch(() => null);
  const range = await outgoingRange(runner, path, branch, options.secrets);
  if (!range) return null;

  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(1, Math.trunc(options.maxFiles)) : 60;
  const numstat = await runner.run(
    ['diff', '--numstat', range.base, 'HEAD'],
    { cwd: path, allowFailure: true, secrets: options.secrets },
  );
  const rows = String(numstat.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [add, del, ...rest] = line.split('\t');
      return {
        path: rest.join('\t'),
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
        binary: add === '-' || del === '-',
      };
    });

  const files = [];
  const chunks = [];
  const patchParts = [];
  let budget = MAX_PATCH_CHARS;
  let truncated = false;

  for (const row of rows) {
    if (files.length >= maxFiles || budget <= 0) { truncated = true; break; }
    if (row.binary) {
      files.push({ path: row.path, additions: 0, deletions: 0, skipped: '二进制文件，未送审' });
      continue;
    }
    // A rename shows the full path pair; git accepts either side.
    const patch = await runner.run(
      ['diff', '--no-color', '--unified=3', range.base, 'HEAD', '--', row.path],
      { cwd: path, allowFailure: true, secrets: options.secrets },
    );
    const text = String(patch.stdout || '');
    if (text === '') continue;
    const clipped = text.length > budget ? text.slice(0, budget) : text;
    if (clipped.length < text.length) truncated = true;
    budget -= clipped.length;
    files.push({ path: row.path, additions: row.additions, deletions: row.deletions });
    chunks.push({ path: row.path, text: clipped });
    patchParts.push(clipped);
  }

  if (files.length === 0) return null;
  return {
    files,
    chunks,
    patch: patchParts.join('\n'),
    truncated,
    // Lets the UI and the tool say what was actually examined.
    scope: 'outgoing',
    range,
  };
}

/**
 * Build a unified, human-readable representation of the changes to review.
 *
 * @param {import('./git.js').GitRunner} runner
 * @param {string} path repository path.
 * @param {object} options
 * @param {boolean} [options.staged] only the index.
 * @param {string[]} [options.includeFiles]
 * @param {number} [options.maxFiles]
 * @param {Iterable<string>} [options.secrets] for redaction.
 * @returns {Promise<{files: object[], chunks: {path: string, text: string}[], patch: string, truncated: boolean}>}
 */
export async function collectReviewChanges(runner, path, options = {}) {
  const status = await runner.status(path, { secrets: options.secrets });
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(1, Math.trunc(options.maxFiles)) : 60;
  const wanted = Array.isArray(options.includeFiles) && options.includeFiles.length > 0
    ? new Set(options.includeFiles)
    : null;

  const files = [];
  const chunks = [];
  let budget = MAX_PATCH_CHARS;
  let truncated = false;

  /** Read the exact diff text for one path. */
  const diffFor = async (file, staged) => {
    try {
      const out = await runner.diff(path, {
        file,
        staged: Boolean(staged),
        secrets: options.secrets,
      });
      return String(out && out.patch ? out.patch : '');
    } catch {
      return '';
    }
  };

  for (const entry of status.files) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    if (wanted && !wanted.has(entry.path)) continue;
    if (entry.conflicted) {
      files.push({ path: entry.path, additions: 0, deletions: 0, skipped: '存在合并冲突，未送审' });
      continue;
    }

    let text = await diffFor(entry.path, entry.staged || options.staged);
    // An untracked file has no diff at all — its whole content IS the change,
    // so it must be read explicitly or the review would silently ignore the
    // most common kind of new secret (a file written and not yet added).
    // `readWorkingFile` already returns a `--no-index` unified diff against
    // /dev/null, so its text can be appended as-is; wrapping it again would
    // double the '+' prefixes and produce nonsense line counts.
    if (text.trim() === '' && entry.untracked) {
      try {
        const body = await runner.readWorkingFile(path, entry.path, MAX_FILE_BYTES, {
          secrets: options.secrets,
        });
        if (body && body.binary) {
          files.push({ path: entry.path, additions: 0, deletions: 0, skipped: '二进制文件，未送审' });
          continue;
        }
        text = String((body && body.text) || '');
        if (text.trim() === '') {
          // Nothing readable: either the file is empty or git declined. Either
          // way there is no content to review, so it is not a failure.
          continue;
        }
        if (text.length >= MAX_FILE_BYTES * 2) {
          files.push({ path: entry.path, additions: 0, deletions: 0, skipped: `超过 ${MAX_FILE_BYTES / 1024} KB，未送审` });
          continue;
        }
      } catch {
        files.push({ path: entry.path, additions: 0, deletions: 0, skipped: '无法读取内容' });
        continue;
      }
    }
    if (text.trim() === '') continue;

    const plus = (text.match(/^\+(?!\+\+)/gm) || []).length;
    const minus = (text.match(/^-(?!--)/gm) || []).length;
    files.push({ path: entry.path, additions: plus, deletions: minus });

    if (budget <= 0) {
      truncated = true;
      continue;
    }
    const slice = text.length <= budget ? text : text.slice(0, budget);
    if (slice.length < text.length) truncated = true;
    budget -= slice.length;
    chunks.push({ path: entry.path, text: slice });
  }

  // Nothing in the working tree, but there may still be commits waiting to go
  // out. Reviewing "what a push would send" is the whole point of the feature,
  // so falling back here is what makes the clean-tree case safe instead of a
  // false all-clear.
  if (files.length === 0 && options.includeOutgoing !== false) {
    const outgoing = await collectOutgoingChanges(runner, path, options);
    if (outgoing) return outgoing;
  }

  return {
    files,
    chunks,
    patch: chunks.map((c) => c.text).join('\n'),
    truncated,
    scope: 'working',
  };
}

/* ------------------------------------------------------------------ */
/*  Model pass                                                         */
/* ------------------------------------------------------------------ */

/** The instruction that shapes the model's reply into parseable JSON. */
const SYSTEM_PROMPT = [
  '你是一名代码审查员，负责在代码被推送到远端之前做最后一道检查。',
  '你只会收到一次变更的差异文本，没有工具可用，也不能假设自己能看到仓库的其他部分。',
  '',
  '严格按以下要求输出：',
  '1. 只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释性前后缀。',
  '2. 结构为 {"findings":[{...}],"summary":"..."}。',
  '3. 每个 finding 的字段：',
  '   severity: blocker | high | medium | low | info',
  '   category: secrets | privacy | integrity | quality',
  '   title: 一句话说清问题',
  '   detail: 为什么这是问题，以及触发条件',
  '   file: 相关文件路径（必须来自输入的差异）',
  '   line: 大致行号（数字，可省略）',
  '   suggestion: 可执行的修复建议',
  '4. summary 用一两句话总结这次变更的整体风险。',
  '5. 不要报告「看起来没问题」之类的空结论；没有问题就返回空 findings 数组。',
  '6. 绝不要把你看到的密钥、密码或令牌原文写进输出，只用「已隐藏」代替。',
].join('\n');

/**
 * Ask the host's model to review one change set.
 *
 * @param {object} llm the host `llm` service (may be undefined).
 * @param {object} request
 * @returns {Promise<{findings: object[], summary: string, usage?: object, model: object|null}>}
 */
export async function runModelReview(llm, request) {
  const { provider, model, reasoningEffort, prompt, signal } = request;
  if (!llm || typeof llm.stream !== 'function' || !provider || !model) {
    return { findings: [], summary: '', model: null };
  }

  const options = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    system: SYSTEM_PROMPT,
    signal,
  };
  if (reasoningEffort) options.reasoningEffort = reasoningEffort;

  let text = '';
  let usage;
  for await (const chunk of llm.stream(options)) {
    if (!chunk) continue;
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      throw new Error(chunk.reason.failure?.message ?? '模型返回错误');
    }
  }

  const parsed = parseModelJson(text);
  return {
    findings: parsed.findings,
    summary: parsed.summary,
    usage,
    model: { provider, model },
  };
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Models wrap JSON in code fences and occasionally add a sentence before or
 * after it, so the extraction is permissive; when nothing parses, the whole
 * reply becomes the summary rather than an error — a review that returned prose
 * is still useful, and failing the request would lose it.
 *
 * @param {string} text
 * @returns {{findings: object[], summary: string}}
 */
export function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { findings: [], summary: '' };
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1));
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.filter((f) => f && typeof f === 'object').map(normalizeFinding)
        : [];
      return {
        findings,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      };
    } catch {
      // fall through to the prose fallback
    }
  }
  return { findings: [], summary: unfenced };
}

/**
 * Coerce one model-produced finding into the wire shape.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeFinding(raw) {
  const severity = SEVERITY_ORDER.includes(raw.severity) ? raw.severity : 'medium';
  const category = typeof raw.category === 'string' && raw.category !== '' ? raw.category : 'quality';
  const line = Number.isFinite(raw.line) ? Math.trunc(raw.line) : undefined;
  return {
    severity,
    category,
    title: String(raw.title ?? '').slice(0, 200) || '未命名问题',
    detail: String(raw.detail ?? '').slice(0, 4000),
    file: typeof raw.file === 'string' ? raw.file : undefined,
    line,
    suggestion: typeof raw.suggestion === 'string' ? raw.suggestion.slice(0, 2000) : undefined,
  };
}

/**
 * Sort findings most-severe first, then by file so the panel reads top-down.
 * @param {object[]} findings
 * @returns {object[]}
 */
export function sortFindings(findings) {
  const rank = (s) => {
    const i = SEVERITY_ORDER.indexOf(s);
    return i < 0 ? SEVERITY_ORDER.length : i;
  };
  return [...findings].sort((a, b) => {
    const bySeverity = rank(a.severity) - rank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return String(a.file ?? '').localeCompare(String(b.file ?? ''));
  });
}
