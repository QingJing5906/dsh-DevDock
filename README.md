# Push · dsh-push

> 在 DeepSeek Harness 里直接登录 GitHub、管理仓库，并驱动当前工作区的 Git 版本树——不用切浏览器，不用记命令。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-plugin-4c6ef5.svg)](https://github.com/deepseek-ai)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

---

## 项目简介

`dsh-push` 是 DeepSeek Harness 的 GitHub / Git 管理插件。它把「看仓库、切账号、提交、推送、撤回」这些每天都要做的事收进 Harness 一个面板里，并把**推送前审查**交给模型——让即将离开本机的内容先被检查一遍。

它由两半组成：Host 侧提供一套完整的 GitHub REST 与 Git 命令封装（含令牌安全注入），Client 侧提供设置页、左侧仓库面板和工作区侧边栏。两侧共享同一套服务方法，所以**你在界面上做的操作，和智能体通过工具做的操作，行为完全一致**。

**设计取向**：界面克制、信息密度高、贴近原生宿主风格。没有渐变、没有大圆角卡片流、没有装饰性动效。

---

## 亮点

| 亮点 | 说明 |
|---|---|
| **多账号 + 即时切换** | 账号卡片展示头像、昵称、权限范围，下拉即切；切换后所有面板立刻跟随，无需重启 |
| **令牌永不落地到 git 配置** | 推送时通过一次性 `http.extraheader` 注入，`.git/config` 里不含任何凭据 |
| **推送前 Agent 审查** | 规则扫描（免费、必跑）+ 模型审查（可选模型与思考强度）；有阻断项时警告但不阻拦 |
| **推送记忆** | 每条分支记住上次推送到哪个仓库、哪个 ref；下次回到该分支自动带出 |
| **版本树可视化** | 提交图带 lane 连线与 ref 标签，任意节点可检出、反向提交、打标签 |
| **智能体同源** | 插件把能力同时暴露为模型工具 `github_link`，人和 AI 走同一套代码路径 |
| **仓库卡片视图** | 列表 / 卡片双视图，卡片带语言占比条形图、star / fork / issue 指标与简介滚动区 |

---

## 功能

### 设置 › Push（独立一页）

- **账号卡片**：头像、昵称、`@login`、权限范围；右侧箭头展开下拉，可切换、移除账号；下拉箭头左侧一键跳转该账号的 GitHub 主页
- **两种录入方式**：Personal Access Token（推荐，可细粒度授权）或 Device Flow 设备码登录
- **账号概览**：最近一年贡献热力图、未读通知列表（可单条标记已读并跳转）
- **仓库管理**（居中弹窗，对齐 GitHub 原站）：概览指标、分支管理、仓库设置（简介/主页/可见性/归档/默认分支）、发布、协作者、Webhook、危险操作区（重命名 / 转移 / 删除）

### 左侧栏 Push（全局面板）

- 当前账号下全部仓库：搜索、私有/公开分段、分页加载
- **列表 / 卡片双视图**，卡片分大、小两档，选择会记住
  - 卡片直接展示列表要展开才看到的内容：简介、默认分支、更新时间、跳转与管理按钮
  - 底部语言占比条形图（按 GitHub 真实字节占比；超过 6 种语言折叠为「其他」）
  - star / fork / issue 指标横排展示
- 新建仓库、删除仓库（删除需 `delete_repo`，且需二次确认）

### 工作区侧边栏 Push（跟随当前会话目录）

- **版本状态**：当前分支、`owner/repo`、ahead/behind、已暂存 / 未暂存 / 未跟踪 / 冲突计数
- **一键提交、推送、拉取、抓取**
- **推送目标选择**：可搜索 GitHub 仓库或使用本地远端；每条分支独立记忆上次目标
- **撤回**：soft / mixed / hard 三种模式，hard 需输入确认
- **分支**：新建、切换、删除（未合并时二次确认）、合并
- **标签**：打标签并可同时推送
- **暂存**：stash / stash pop，可选包含未跟踪文件
- **改动列表**：按分组展示，可单文件暂存 / 还原，点开看 diff
- **提交图**：最近 60 条提交，带 lane 连线、ref 标签、作者与时间；任意节点可检出、反向提交、复制 sha、打标签、在此撤回
- 目录还不是 Git 仓库时，显示醒目的「创建 Git 仓库」按钮，可同时创建 GitHub 远端

### 推送前审查（Agent 审查）

点「Agent 审查」后是一个两步弹窗：

1. **配置**——选择模型与思考强度（宿主提供几档就用几档，≥3 档渲染为滑条）；审查项以卡片呈现，按**敏感信息 / 隐私 / 完整性 / 质量 / 自定义**分组，可多选，只有卡片区域滚动；底部自定义提示词可一键「存档为预设」，下次直接勾选
2. **确认**——列出将使用的模型、思考强度（可再改）、涉及文件（默认折叠）、将执行的审查项；可返回修改
3. **结果**——按严重度排序，标注文件与行号并给出修复建议

两道关卡：

- **规则扫描**（不花钱、必定执行）：识别 `ghp_` / `github_pat_` / `sk-` / `AKIA` / `xox` / 私钥块 / Bearer 长串 / 硬编码密码。命中即报 `blocker`，且**密钥原文永不出现在界面、日志或工具结果里**；`REPLACE_ME`、`<your-token>` 这类占位符不会误报
- **模型审查**：把选中的审查项与自定义提示词合成一次请求；模型不可用或失败时自动降级为只跑规则扫描并在结果中注明，**绝不阻塞推送**

### 模型工具 `github_link`

同一套能力同时暴露给智能体：

```text
status · log · push · pull · commit · repos · accounts
create_repo · release · review
```

`push` 和 `release` 都可用 `owner` + `repo` 指定目标，因此智能体可以直接「建仓库 → 推送 → 打标签发布」而无需人工配置远端。

---

## 安装

### 从 npm 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-push
```

### 从本地目录安装

```powershell
dsh plugin --profile desktop add "<插件目录>\dsh-push"
```

也可以在 DSH 的插件管理器里选择 **local directory** 指向该目录。

### 从源码构建

```powershell
git clone https://github.com/QingJing5906/dsh-push.git
cd dsh-push
npm install          # 仅测试需要，插件本身零运行时依赖
npm test             # 11 组测试 + 可达性审计
```

安装完成后：

- 设置面板新增 **Push** 一页
- 左侧栏新增 **Push** 图标
- 右侧栏 `+` 菜单新增 **Push** 标签页
- 智能体获得 `github_link` 工具

---

## 快速开始

1. 打开 **设置 › Push**，点「+ 添加新账号」，粘贴一个 GitHub Personal Access Token
2. 用 `dsh` 在任意 Git 仓库目录里开会话，右侧栏打开 **Push**
3. 改几个文件 → 展开「改动」勾选要提交的内容 → 写提交信息 → **提交并推送**
4. 推送前想检查一遍，先点 **Agent 审查**，看完结果再推

---

## 权限（GitHub token scopes）

| 用途 | 需要的 scope |
|---|---|
| 读取仓库、分支、发布，推送 / 拉取 | `repo`（私有仓库必需）或 `public_repo` |
| 创建仓库 | `repo` |
| 删除仓库 | `delete_repo` |
| 贡献热力图 | `read:user`（缺失时该卡片显示提示，不影响其他功能） |
| 未读通知 | `notifications`（缺失时列表为空） |
| 发布与附件 | `repo` |

推荐一键勾选：`repo`、`delete_repo`、`read:user`、`notifications`。

---

## 安全

- Token 只保存在 `%DSH_HOME%\push\state.json`（Windows 下为 `C:\Users\<你>\.dsh\push\state.json`），文件权限 `0600`
- Token **永不**出现在 HTTP 响应、日志、git 命令回显或工具结果中
- 推送通过一次性 `http.extraheader` 注入，**不写入** `.git/config`；每此调用都是独立注入，不依赖全局凭据助手
- 所有错误信息在返回前都会经过脱敏（任意认证方案、`ghp_` / `github_pat_` 形态、私钥块）
- 破坏性操作（删除仓库、hard 撤回、清空工作区、删除发布）要求显式确认；删除仓库还需 `delete_repo` scope

---

## 架构

```
dsh-push/
├── index.js            # Loader 入口（字节稳定 + 内容哈希缓存破坏）
├── cordis.patch.yml    # 插件行声明
├── client.js           # 浏览器侧：设置页 / 仓库面板 / 工作区标签页
├── src/host/
│   ├── index.js        # 服务与路由表（~60 条）/ 模型工具
│   ├── git.js          # GitRunner：异步 git 封装 + 认证注入 + 脱敏
│   ├── github.js       # GitHub REST 客户端（node:https，零依赖）
│   ├── review.js       # 规则扫描 + 模型审查
│   └── store.js        # 单文档原子状态（账号、设置、推送记忆、审查预设）
├── locale/             # zh / en
├── tests/              # 11 组测试 + 可达性审计
└── CONTRACT.md         # Host↔Client 接口契约
```

- **Host ↔ Client** 通过 `webServer` 注册的 `/api/push/*` 路由通信，统一 JSON 信封 `{ok, data}` / `{ok: false, error}`
- 非 GET 请求要求 `x-dsh-plugin: push` 头，防跨站触发
- 所有主题颜色走宿主 CSS 变量，自动跟随明暗主题

---

## 开发

```powershell
npm test              # 11 组测试 + 可达性审计
npm run test:refspec  # 推送 refspec 行为（需要 git 可执行）
```

测试覆盖：客户端源断言、仓库卡片、工具契约、错误映射、推送记忆、删除语义、审查规则、审查预设持久化、路由可达性。

`CONTRACT.md` 是 Host↔Client 的接口契约，任何路由或字段变更都应同步更新。

---

## 已知限制

- 只支持 HTTPS 远端推送；SSH 远端需要自行配置好 `ssh-agent`
- 设备码登录需要填一个 GitHub OAuth App 的 Client ID（GitHub 不允许无 Client ID 的设备码流程）
- 网络无法访问 `api.github.com` 或 `github.com:443` 时，插件会把原始错误如实显示（含脱敏），不会静默失败
- 仓库卡片高度固定以保证网格整齐；简介超出部分在卡片内滚动查看

---

## 许可

[MIT](./LICENSE)
