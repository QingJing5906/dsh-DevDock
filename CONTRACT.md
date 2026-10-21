# dsh-push 内部契约（Host ⇄ Client）

本文件是 Host 与 Client 两半共享的唯一契约。任何一方改动都必须先改这里。

## 0. 通用约定

- HTTP 前缀：`/api/push`
- 所有响应为 JSON，统一信封：
  - 成功：`{ "ok": true, "data": <payload> }`
  - 失败：`{ "ok": false, "error": { "code": "<CODE>", "message": "<人类可读中文>" , "status"?: <github http status> } }`
- 非 GET 请求必须带请求头 `x-dsh-plugin: push`（CSRF 约定），缺失返回 403 `FORBIDDEN`。
- 客户端只通过 `fetch` 调这些路由，`credentials: 'same-origin'`，不要另起 RPC。
- 所有时间戳为 ISO 8601 字符串；所有 id 为字符串。
- 错误码常量（Host 与 Client 都要用）：`FORBIDDEN`、`BAD_REQUEST`、`NOT_FOUND`、`NO_ACCOUNT`、`UNAUTHORIZED`(token 失效)、`RATE_LIMITED`、`NETWORK`、`GIT_MISSING`、`GIT_FAILED`、`NOT_A_REPO`、`CONFLICT`、`INTERNAL`。

## 1. 账号（多账号登录/切换）

账号对象 `Account`：
```ts
{
  id: string,            // 本地稳定 id（login 的小写）
  login: string,
  name: string | null,
  avatarUrl: string | null,
  htmlUrl: string | null,
  tokenKind: 'pat' | 'oauth',   // 录入方式
  scopes: string[],             // 来自 x-oauth-scopes 响应头（无则 []）
  addedAt: string,
  lastUsedAt: string | null
}
```

`GET /state` →
```ts
{
  accounts: Account[],
  activeAccountId: string | null,
  settings: {
    oauthClientId: string,     // 空串表示未配置设备码登录
    defaultRemote: string,     // 默认 'origin'
    showPrivate: boolean,
    gitPath: string            // 空串表示用 PATH 里的 git
  },
  gitAvailable: boolean,
  gitVersion: string | null
}
```

- `POST /accounts/token` body `{ token: string, label?: string }` → `{ accounts, activeAccountId }`
  - Host 用该 token 调 `GET /user` 校验；失败返回 `UNAUTHORIZED`。
  - 同一 login 再次提交 = 覆盖 token（不新建）。
- `POST /accounts/device/start` body `{}` →
  `{ verificationUri: string, userCode: string, deviceCode: string, expiresIn: number, interval: number }`
  - 未配置 `oauthClientId` 时返回 `BAD_REQUEST`。
- `POST /accounts/device/poll` body `{ deviceCode: string }` →
  `{ status: 'pending' | 'slow_down' | 'done', accounts?, activeAccountId? }`
- `POST /accounts/activate` body `{ accountId: string }` → `{ activeAccountId }`
- `POST /accounts/remove` body `{ accountId: string }` → `{ accounts, activeAccountId }`
- `POST /settings` body `Partial<settings>` → `{ settings }`

## 2. 仓库（远端）

远端仓库对象 `RemoteRepo`：
```ts
{
  id: string, owner: string, name: string, fullName: string,
  private: boolean, fork: boolean, archived: boolean,
  defaultBranch: string, description: string | null,
  updatedAt: string, pushedAt: string | null,
  htmlUrl: string, cloneUrl: string, sshUrl: string,
  permissions: { admin: boolean, push: boolean, pull: boolean } | null,
  language: string | null, stars: number, openIssues: number,
  ownerAvatar: string | null
}
```

- `GET /repos?page=1&q=&affiliation=owner,collaborator,organization_member&sort=updated` →
  `{ items: RemoteRepo[], page: number, hasMore: boolean, total?: number }`
  - `q` 非空时走 `GET /search/repositories?q=<q>`（`user:<login>` 前缀 + 关键词），结果同样映射为 `RemoteRepo`。
- `GET /repos/detail?owner=&name=` → `{ repo: RemoteRepo, branches: Branch[] }`
  其中 `Branch = { name: string, sha: string, protected: boolean }`
- `POST /repos/create` body `{ name, private=true, description='', autoInit=false }` → `{ repo: RemoteRepo }`
- `POST /repos/delete` body `{ owner, name }` → `{ deleted: true }`（需 `delete_repo` scope，否则 `UNAUTHORIZED` 并给中文提示）
- `GET /releases?owner=&repo=` → `{ items: Release[] }`
- `POST /releases` body `{ owner, repo, tagName, name?, body?, target?, draft=false, prerelease=false }` → `{ release: Release }`

`Release = { id: string, tagName: string, name: string | null, draft: boolean, prerelease: boolean, createdAt: string, htmlUrl: string }`

只读的账号活动（`login` 省略时用当前账号）：

- `GET /contributions?login=&days=365` → 贡献日历（走 GraphQL `contributionsCollection`）
```ts
{
  total: number, days: { date: 'YYYY-MM-DD', count: number, weekday: 0-6 }[],  // 按 date 升序，Client 直接画格子
  weeks: number, restricted: number, login: string, from: string, to: string
}
```
  - 令牌缺 `read:user` 时**不报错**，返回 `{ unavailable: true, reason: 'SCOPE', message: '贡献图需要令牌具备 read:user 权限；当前令牌没有该权限。' }` 且 `ok:true`，面板渲染行内提示即可。真正的网络失败仍是 `NETWORK`。
- `GET /notifications?all=false&limit=30` → `{ items: Notification[], unreadCount: number }`（`unreadCount` 为当前页未读数）
```ts
Notification = {
  id: string, title: string, type: string,   // 'Issue' | 'PullRequest' | 'Release' | 'Discussion' | 'Commit' | ...
  repo: string,                              // 'owner/name'
  reason: string,                            // 'review_requested' | 'mention' | 'subscribed' | ...
  unread: boolean, updatedAt: string,
  url: string                                // 网页地址，由 subject.url 的 API 地址换算
}
```
  - `url` 换算：`pulls/{n}`→`/pull/{n}`、`issues/{n}`→`/issues/{n}`、`commits/{sha}`→`/commit/{sha}`、`discussions/{n}`→`/discussions/{n}`、`releases/{n}`→`/releases`，其它一律 `https://github.com/{repo}`。
- `POST /notifications/read` body `{ id }` → `{ read: true }`（`PATCH /notifications/threads/{id}`；205 无响应体也算成功）

## 3. 本地仓库（Git）

- `GET /local/status?path=<绝对路径>` →
```ts
{
  isRepo: boolean,
  root: string | null,             // rev-parse --show-toplevel
  gitDir: string | null,
  branch: string | null,           // 分离 HEAD 时为 null
  detachedHead: boolean,
  upstream: string | null,         // 如 'origin/main'
  ahead: number, behind: number,
  remotes: { name: string, url: string }[],
  githubRemote: { name: string, owner: string, repo: string, url: string } | null,
  head: { sha: string, shortSha: string, subject: string, author: string, date: string } | null,
  dirty: { changed: number, staged: number, untracked: number, conflicted: number },
  files: { path: string, index: string, worktree: string, staged: boolean, untracked: boolean, conflicted: boolean }[],
  tags: string[],
  branches: string[],
  stashes: { index: number, message: string }[]
}
```
- `GET /local/log?path=&limit=60&ref=` →
  `{ commits: Commit[], hasMore: boolean }`
```ts
Commit = {
  sha: string, shortSha: string, parents: string[], author: string, authorEmail: string,
  date: string, subject: string, refs: string[],   // 装饰引用，如 ['HEAD -> main','origin/main','tag: v1']
  lane: number                                     // Host 计算好的图列（0..N），Client 直接画
}
```
- `GET /local/diff?path=&file=&staged=true|false` → `{ file: string, patch: string }`（`git diff` 原文，可能很长；Host 截断到 200_000 字符并给 `truncated: true`）
- `GET /local/commit?path=&sha=` → `{ sha, subject, body, author, date, files: { path, additions, deletions }[] , patch: string }`
- `GET /local/remotes?path=` → `{ remotes }`

写操作（全部 POST，body 都带 `path`）：

| 路由 | body | 说明 |
|---|---|---|
| `/local/init` | `{ path, name?, owner?, private?, remoteName='origin', createRemote=false }` | `git init` + 可选在 GitHub 建仓 + `remote add` + 首次 `git add -A`（不自动提交） |
| `/local/remote` | `{ path, name='origin', url }` | 增改远端；url 为 GitHub 时顺便解析 owner/repo |
| `/local/fetch` | `{ path, remote='origin', prune=false }` | |
| `/local/pull` | `{ path, remote='origin', branch?, rebase=false }` | |
| `/local/push` | `{ path, remote='origin', branch?, force=false, setUpstream=true, tags=false }` | 一键推送 |
| `/local/commit` | `{ path, message, all=true, files?: string[] }` | `all` 时 `git add -A` 后提交 |
| `/local/checkout` | `{ path, ref, create=false }` | ref 可为分支/sha/tag |
| `/local/branch` | `{ path, name, from?, checkout=true }` | 新建分支 |
| `/local/branch/delete` | `{ path, name, force=false }` | |
| `/local/merge` | `{ path, ref }` | |
| `/local/reset` | `{ path, ref='HEAD', mode='mixed' }` | 撤回：soft/mixed/hard |
| `/local/revert` | `{ path, sha }` | |
| `/local/revert-commit` | `{ path, sha }` | `git revert --no-edit <sha>` |
| `/local/tag` | `{ path, name, ref='HEAD', push=false, remote='origin' }` | |
| `/local/stash` | `{ path, message?, includeUntracked=true }` | |
| `/local/stash/pop` | `{ path, index=0 }` | |
| `/local/restore` | `{ path, files: string[], staged=false }` | 丢弃工作区改动 |
| `/local/discard-all` | `{ path }` | 危险操作，`git reset --hard` + 清 untracked |

所有写操作返回 `{ ok:true, data: { output: string } }`，`output` 为 git 的 stdout+stderr 合并（截断 20_000 字符）。失败返回 `GIT_FAILED` 并带原始输出。

## 3b. 推送目标（远端仓库选择 + 按分支记忆）

推送目标不再依赖全局 `defaultRemote`。分三层：

1. **远端（git remote）**：本地已有的 remote name，例如 `origin`、`fork`。
2. **目标 GitHub 仓库**：一个远端可以指向任意仓库；用户想推到「另一个 GitHub 仓库」时，本地可能还没有对应 remote。
3. **记忆**：`(仓库根, 分支)` → 上次成功推送的目标，下次默认选中。

- `GET /push/targets?path=` → 选择器用的候选集合
```ts
{
  remotes: { name: string, url: string, owner: string | null, repo: string | null }[],
  memory: { remote: string, owner: string, repo: string, ref: string, at: string } | null,  // 当前分支的记忆
  branch: string | null,
  repoRoot: string | null
}
```
  - `memory` 是**当前分支**上次成功推送的目标；没有则 `null`。

- `GET /push/remotes?q=&page=1` → 在已登录账号的 GitHub 仓库中检索（供「下拉选择」与「键入搜索」两种 UI）
```ts
{
  items: { fullName: string, owner: string, name: string, private: boolean,
           defaultBranch: string, cloneUrl: string, sshUrl: string, htmlUrl: string }[],
  page: number, hasMore: boolean
}
```
  - `q` 为空时按最近更新列出；非空时匹配 `owner/name` 与描述。

- `POST /local/push` **新增可选字段**：
```ts
{
  path, branch?, force?, setUpstream?, tags?,
  remote?: string,                            // 已有 remote 名（二选一）
  target?: { owner: string, repo: string },   // 直接指定 GitHub 仓库（二选一）
  remember?: boolean                          // 默认 true；成功后写入记忆
}
```
  - 传 `target` 且本地没有对应 remote 时，**不得污染用户 .git/config**：若已有 remote 指向同一仓库则复用；否则以远端 URL 形式推送（`git push <url> <ref>`），令牌沿用现有 `http.extraheader` 机制，绝不落盘。
  - 成功后按 `(repoRoot, branch)` 记录 `{ remote, owner, repo, ref, at }`；`branch` 省略时取当前分支。

- `GET /push/memory?path=` → `{ entries: { branch, remote, owner, repo, ref, at }[] }`（全部分支，调试用）

记忆持久化：状态文档新增 `pushMemory` 表，键 `<repoRoot>|<branch>`。路径需规范化（统一分隔符、盘符小写），避免同一仓库因写法不同丢记忆。

### `/local/push` 的版本来源

`POST /local/push` 的 body 除 `branch` / `force` / `remote` / `target` 外，还接受：

```ts
{
  source?: string   // 要推送的 ref：分支名、标签名或 40 位 sha
}
```

- 省略时等于 `branch`（推当前分支）
- 指定 sha 或标签时，Host 构造 `<source>:refs/heads/<branch>` 形式的 refspec，
  因此「推送某个指定版本」不会悄悄退化成推送当前分支
- 目标分支缺失时先返回 `BAD_REQUEST`，不会发起任何网络请求


## 3c. 仓库管理（弹窗所需的聚合能力）

`GET /repos/manage?owner=&name=` →
```ts
{
  repo: RemoteRepo,
  branches: { name: string, sha: string, protected: boolean }[],
  topics: string[],
  stats: { stars: number, forks: number, watchers: number, openIssues: number, openPRs: number,
           sizeKb: number, language: string | null, license: string | null,
           createdAt: string, updatedAt: string, pushedAt: string | null },
  releases: Release[],
  collaborators: { login: string, avatarUrl: string | null, role: string }[] | null,
  webhooks: { id: string, url: string, events: string[], active: boolean }[] | null,
  warnings: string[],
  can: { admin: boolean, push: boolean, delete: boolean }
}
```
  - 任一子项失败**不得**让整体失败：该字段返回 `null`，并在 `warnings` 写中文原因（如缺 `admin:repo_hook` 读不到 webhook）。

写操作（全部 POST，失败给中文原因）：

| 路由 | body | 说明 |
|---|---|---|
| `/repos/update` | `{ owner, name, description?, homepage?, private?, archived?, topics?, defaultBranch? }` | 改元信息 |
| `/repos/branch/rename` | `{ owner, name, from, to }` | 重命名分支 |
| `/repos/branch/delete` | `{ owner, name, branch }` | 删除远端分支 |
| `/repos/branch/protect` | `{ owner, name, branch, protected }` | 保护/取消保护（需 admin） |
| `/repos/release/delete` | `{ owner, name, id }` | 删除发布 |
| `/repos/release/update` | `{ owner, name, id, name?, body?, draft?, prerelease? }` | 编辑发布 |
| `/repos/collaborator/add` | `{ owner, name, user, permission }` | 添加协作者（需 admin） |
| `/repos/collaborator/remove` | `{ owner, name, user }` | 移除协作者 |
| `/repos/rename` | `{ owner, name, newName }` | 重命名仓库（危险，需 `confirm: true`） |
| `/repos/transfer` | `{ owner, name, newOwner }` | 转移仓库（危险，需 `confirm: true`） |

`/repos/rename`、`/repos/transfer` 与既有 `/repos/delete` 一律要求 `confirm: true`，否则返回 `CONFLICT` 并附中文说明。

## 3d. 推送前审查（Agent Review）

在推送前让模型检查「这次要推的内容」，把风险在离开本机之前拦下来。审查复用宿主已注册的
`llm` 服务，不自行发起 HTTP，因此走同一个 provider、同一套凭据与重试策略。

### 预设与自定义提示词

- `GET /review/presets` →
```ts
{
  builtin: ReviewPreset[],   // Host 内置，只读
  custom: ReviewPreset[],    // 用户存档
  categories: { id: string, label: string }[]
}
```
```ts
ReviewPreset = {
  id: string,
  category: string,          // 'secrets' | 'privacy' | 'integrity' | 'quality' | 'custom'
  title: string,
  description: string,       // 一句话说明它查什么
  prompt: string,            // 发给模型的指令
  builtin: boolean,
  createdAt?: string,
  updatedAt?: string
}
```
  内置分类至少包含：**敏感信息**（令牌、私钥、密码、身份证/手机号/邮箱、内网地址、
  设备与用户名痕迹）、**隐私**（个人姓名、绝对路径中的用户名、机器名）、
  **完整性**（空实现、调试残留、被删除的测试、冲突标记、未跟踪依赖）、
  **质量**（明显 bug、错误处理缺失、硬编码配置）。

- `POST /review/presets` body `{ title, description?, prompt, category? }` → `{ preset: ReviewPreset }`
  存档一条自定义提示词；`title` 与 `prompt` 必填且非空。
- `POST /review/presets/delete` body `{ id }` → `{ deleted: true }`
  只能删自定义预设；删内置返回 `CONFLICT`。

### 审查执行

- `POST /review/run` body：
```ts
{
  path: string,                       // 仓库绝对路径
  presetIds?: string[],               // 选中的内置/自定义预设
  customPrompt?: string,              // 本次临时输入的额外指令（可空）
  provider?: string, model?: string,  // 省略时用宿主默认模型
  reasoningEffort?: string,           // 省略时用该模型默认档
  staged?: boolean,                   // true 只审已暂存；false 审全部未推送改动
  includeFiles?: string[],            // 限定文件；省略=按下面规则自动选
  maxFiles?: number                   // 默认 60
}
```
  → `{ reviewId, model, effort, files, findings, summary, usage }`

```ts
{
  reviewId: string,
  model: { provider: string, model: string, label: string } | null,
  effort: string | null,
  scope: 'working' | 'outgoing',   // 审的是工作区改动还是待推送提交
  outgoingCommits: number,         // scope=outgoing 时的提交数，否则 0
  truncated: boolean,              // 改动过多、有内容未送审
  degraded: boolean,               // 模型未参与、只跑了规则扫描
  files: { path: string, additions: number, deletions: number, skipped?: string }[],
  findings: {
    severity: 'blocker' | 'high' | 'medium' | 'low' | 'info',
    category: string,
    title: string,
    detail: string,
    file?: string,
    line?: number,
    suggestion?: string
  }[],
  summary: string,
  usage?: { inputTokens: number, outputTokens: number }
}
```

规则：

1. **只审将要推送的差异**。默认取 `HEAD` 与工作区的差异（含未跟踪文件，逐个读取内容）；
   `staged: true` 时只取 `--cached`。单文件内容超过 200 KB 或二进制时标记 `skipped`。
2. **工作区没有改动时，改审待推送提交**。推送前的常态是工作区干净、提交已就绪，
   此时若只读工作区就会返回「无改动」并零发现——对安全功能而言这是最糟的静默漏报。
   回退规则：有 upstream 时以 `merge-base(upstream, HEAD)` 为基准；无 upstream 时以
   `refs/remotes/origin/<branch>` 为基准；两者都不存在（分支首次推送）时以空树
   `4b825dc642cb6eb9a060e54bf8d69288fbee4904` 为基准。结果中的 `scope` 字段标明
   本次审查的是哪一类（`working` / `outgoing`），`outgoingCommits` 给出待推送提交数。
3. **模式规则先行**（不花钱）：Host 先用正则扫一遍已知密钥形态
   （`ghp_[A-Za-z0-9]{36}`、`github_pat_`、`sk-`、`AKIA[0-9A-Z]{16}`、私钥块、
   `xox[baprs]-`、Bearer 长串、以及 `password` / `token` / `api_key` 等键名后跟长字面量的硬编码密码），命中即产出 `blocker` 级 finding。
   这样即使模型不可用，最危险的一类问题也有答案。
4. **模型审查**：把选中预设的 prompt + 自定义提示词拼成一次 `llm` 调用，
   要求模型只输出 JSON（`{findings:[],summary:""}`）。解析失败时降级：
   把模型原文放进 `summary` 且 `findings` 为模式规则的结果，不报错。
6. **模型不可用**（未注册 provider、鉴权失败、网络错误）：返回
   `{ ok:true, data:{ ..., model: null, findings: <模式规则结果>, summary: '<中文说明>' } }`，
   并在 `degraded: true` 标注；绝不因审查失败阻塞推送。
5. 令牌等秘密**永不写进 findings**：命中时只保留位置与类型（如 `ghp_…（已隐藏）`）。

### 模型与强度候选

- `GET /review/models` → `{ providers: { id, name, models: { id, name, efforts: { id, name }[], defaultEffort }[] }[], default: { provider, model } | null }`
  由 Host 侧 `llm` 服务枚举；宿主没有 `llm` 时返回空数组与 `default: null`，
  界面据此显示「宿主未提供模型配置」。

## 3e. 仓库信息与发布附件

客户端用到的、与仓库展示和发布相关的能力。

### 语言构成

- `GET /repos/languages?owner=&name=`
  → `{ items: { name: string, bytes: number, percent: number }[], warning?: string }`
  - 按字节降序；`percent` 保留一位小数，由 Host 计算，客户端只渲染
  - 仓库不可见或无语言数据时返回 `{ items: [] }`，**不报错**（卡片只是不画条形图）

### 发布附件

- `POST /releases/asset` body：
```ts
{
  owner: string, name: string, releaseId: string,
  fileName: string,
  contentType?: string,
  base64: string        // 文件内容；上限 200 MB，超出返回 BAD_REQUEST
}
```
  → `{ asset: { id, name, size, downloadUrl } }`
  - 附件上传走 `uploads.github.com`（不是 `api.github.com`），URL 由 `API_BASE` 推导

- `POST /releases/asset/delete` body：`{ owner, name, assetId }` → `{ deleted: true }`
  - 404 也视为已删除（幂等）

### 发布对象

`Release` 额外携带附件列表，供界面展示与删除：
```ts
assets: { id: string, name: string, size: number, downloadUrl: string }[]
```

### 仓库字段补充

`RemoteRepo` 除 `fork: boolean` 外还带计数 `forks: number`（列表与卡片展示用）。

### 推送记忆

- `POST /local/push/target/forget` body：`{ path, branch? }` → `{ forgotten: true }`
  - 清除该分支（或全部）的推送目标记忆

### 诊断

- `GET /diagnostics` → `{ toolsService, tool: { name, attempted, registered, visible, inSchemas, error } }`
  - 回答「智能体为什么看不到 `github_link`」。注册失败会被记录下来而不是只写日志。


## 4. Agent 工具（可选但要对齐）

Host 另注册一个工具 `github_link`，`action` 参数取值与上表一致（`status`、`log`、`push`、`pull`、`commit`、`repos`、`accounts`）。它调用同一份 Host 服务方法，不另写逻辑。

## 5. 客户端职责

- `settings.section`：`{ name:'settings.section', id:'push', order:22, label:()=>'GitHub' }`
  页面内容：
  1. 账号列表（头像、login、当前标记、切换、移除）+ 添加账号（PAT 输入 / 设备码流程）
  2. 连接设置（oauthClientId、gitPath、defaultRemote、showPrivate）
  3. 仓库列表（搜索、私有过滤、分页"加载更多"、点进详情看分支）
- `sidebar.panellist`：`{ name:'sidebar.panellist', id:'push', order:2, label:()=>'GitHub' }` + `main` key `push` 的整页：仓库浏览 + 新建仓库 + 删除。
- `ctx.betterSidebar?.registerTab(...)`：id `push`，标题「GitHub 链接」，单实例，组件按当前会话 `scope.cwd` 显示该工作区的本地版本状态、分支、ahead/behind、文件改动、Git 图（最近 60 条，带 lane 连线）、以及提交/推送/拉取/撤回/切分支/打标签/暂存等操作。**这是"工作区侧边栏入口"。**
- 所有可见文案中文；颜色只用 `--dsw-alias-*` 主题 token；不要渐变、不要 emoji 图标，用内联 SVG。

## 6. 文件归属（避免写冲突）

- `dsh-push/index.js`、`dsh-push/src/host/**` → host-dev
- `dsh-push/client.js`、`dsh-push/client.css` → client-dev
- `dsh-push/package.json`、`cordis.patch.yml`、`locale/**`、`icon.svg`、`README.md` → lead

### 动作清单

```text
status · log · push · pull · commit · repos · accounts
create_repo · release · review
```

- `push` / `release` 都接受 `owner` + `repo` 指定目标仓库，因此智能体无需预先配置远端
- `review` 与弹窗走同一个 `reviewRun` 服务方法，返回 `scope` 与 `findings`
- 工具结果必须是**无损 JSON**：findings 的缺失字段一律投影为 `null`，不能留 `undefined`
- schema 只能用宿主支持的子集（`type` / `oneOf` / `properties` / `required` /
  `additionalProperties` / `items` / `enum` / `const`）；`type: [...]` 与 `anyOf`
  会让整个注册失败，工具从此对模型不可见
