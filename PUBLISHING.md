# 发布指南

本文记录本插件**如何发一个版本**，以及 npm 与插件市场当前的实际情况。

---

## 0. 当前发布状态

| 渠道 | 状态 | 说明 |
|---|---|---|
| GitHub 仓库 | ✅ 已发布 | <https://github.com/QingJing5906/dsh-push>（公开） |
| GitHub Release `v1.0.0` | ✅ 已发布 | 含 `dsh-harness-push-1.0.0.tgz` 附件 |
| npm | ⬜ 待发布 | 需要 npm 账号；包名已定为 `dsh-harness-push` |
| DSH 插件市场 | ⬜ 待接入 | 本机 DSH 未配置任何市场索引；索引由用户自行添加 |

### 为什么包名不叫 `dsh-push`

npm 上的 `dsh-push` 已被另一个用途无关的插件占用：

- 维护者 `yp_wong`
- 版本 `0.1.1`（2026-08-13 发布）
- 用途：「Push DeepSeek Harness agent lifecycle notifications to configurable channels」

因此**发布包名**取 `dsh-harness-push`，**GitHub 仓库名**仍是 `dsh-push`。
插件内部标识（工具名 `github_link`、路由 `/api/push/*`、cordis 挂载行、界面入口）不受影响，已有安装继续可用。

---

## 1. 发布到 npm

### 前置：一次性的账号准备

```powershell
# 1. 注册（浏览器）： https://www.npmjs.com/signup
# 2. 登录（会写 ~/.npmrc）
npm login
# 3. 确认身份
npm whoami
```

### 每次发版

```powershell
cd dsh-push

# 1. 确认工作区干净、测试全过
git status --short          # 应为空
npm test                    # 11 组测试 + 可达性审计

# 2. 升版本号（遵循语义化版本）
npm version patch           # 修 bug：1.0.0 -> 1.0.1
# npm version minor         # 加功能：1.0.0 -> 1.1.0
# npm version major         # 破坏性变更：1.0.0 -> 2.0.0

# 3. 先看会打包进什么（不发布）
npm pack --dry-run

# 4. 发布（prepublishOnly 会自动再跑一遍测试）
npm publish

# 5. 把 tag 推上去
git push --follow-tags
```

发布后验证：

```powershell
npm view dsh-harness-push version
npm view dsh-harness-push dist.tarball
```

> `prepublishOnly` 已配置为 `npm test`，所以测试不过就发不出去。

---

## 2. 发 GitHub Release

仓库已配置好，用插件本身或命令都可以。

**用插件界面**：左侧栏 **Push** → 打开仓库管理 → **发布** → 新建发布
（填标签名、标题、说明，可上传附件）。

**用命令**：

```powershell
cd dsh-push
git tag -a v1.0.1 -m "dsh-harness-push 1.0.1"
git push origin v1.0.1
npm pack                       # 生成 dsh-harness-push-1.0.1.tgz
# 然后在 GitHub 上创建 release 并上传该 tgz
```

Release 说明建议包含：亮点、安装方式、权限要求、附件说明、`Full Changelog` 链接。

---

## 3. 接入 DSH 插件市场

### 现状

本机 `plugin_market list_indexes` 返回空数组，即**没有配置任何市场索引**。
市场索引的增删只有用户能做，插件无法自行注册。

### 市场通常怎么消费一个插件

DSH 的插件市场索引指向 npm 包。因此顺序是：

1. 先把包发布到 npm（见第 1 节）
2. 再让市场索引收录 `dsh-harness-push`

### 如果市场要求提交信息

准备这些字段（都已在 `package.json` 里）：

| 字段 | 值 |
|---|---|
| `name` | `dsh-harness-push` |
| `description` | DeepSeek Harness 的 GitHub 与 Git 管理插件：多账号登录切换、仓库浏览与管理、工作区版本树、一键推送、推送前 Agent 审查。 |
| `keywords` | `dsh`, `dsh-plugin`, `deepseek-harness`, `github`, `git`, `push`, `version-control`, `code-review`, `agent`, `release` |
| `repository` | https://github.com/QingJing5906/dsh-push |
| `license` | MIT |

仓库的 topics 已设置为：
`dsh` · `dsh-plugin` · `deepseek-harness` · `github` · `git` · `push` · `code-review` · `agent` · `release` · `version-control`

### 本机添加一个市场索引

在 DSH 的插件市场设置里添加索引地址即可（只有用户能改）。添加后：

```powershell
# 列出已配置的索引
# （在 DSH 界面操作，或由宿主提供市场设置项）
```

---

## 4. 安装方式（面向使用者）

```powershell
# 从 npm（发布之后）
dsh plugin --profile desktop add dsh-harness-push

# 从本地目录
dsh plugin --profile desktop add "<插件目录>\dsh-push"

# 从 Release 附件
#   下载 dsh-harness-push-1.0.0.tgz 后
npm install -g ./dsh-harness-push-1.0.0.tgz
```

安装后：设置面板新增 **Push** 一页，左侧栏新增 **Push** 图标，右侧栏 `+` 菜单新增 **Push** 标签页，智能体获得 `github_link` 工具。

---

## 5. 发版检查清单

- [ ] `git status --short` 为空
- [ ] `npm test` 全绿（11 组测试 + 可达性审计）
- [ ] `npm pack --dry-run` 里没有 `tests/`、没有 `.tgz`、没有 `state.json`
- [ ] `CHANGELOG.md` 加了对应版本小节
- [ ] `package.json` 的 `version` 与 `CHANGELOG` 一致
- [ ] 推送前跑一次 **Agent 审查**
- [ ] Release 说明里的安装命令与实际包名一致
- [ ] `npm view dsh-harness-push version` 返回新版本
