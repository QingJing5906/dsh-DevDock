window.__ModuleLoader__.load({
  // Must equal package.json `name`: the loader keys client modules by package
  // name, so a mismatch registers the module under an id nobody resolves and
  // every surface vanishes while the Host half still reports active.
  id: 'dsh-harness-push',
  factory: (require) => {
    'use strict';
    /**
     * Browser half of dsh-push.
     *
     * Three surfaces, all fed by CONTRACT.md over `/api/push`:
     *   A. `settings.section` id `push` — accounts card + contribution graph +
     *      notifications + repository management + connection settings.
     *   B. `sidebar.panellist` icon + `main` page key `push` — remote repos.
     *   C. `ctx.get('betterSidebar').registerTab(...)` — the workspace Git tab.
     *
     * The stylesheet is emitted inline (one <style> element in document.head)
     * because this deliverable owns no Host route to serve a client.css from.
     */
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const { useState, useEffect, useRef, useCallback } = React;
    const h = React.createElement;

    /** HTTP prefix every request goes through (CONTRACT §0). */
    const API = '/api/push';
    /** Value of the CSRF convention header on non-GET requests (CONTRACT §0). */
    const PLUGIN_ID = 'push';

    /** `/local/status` poll cadence while the sidebar tab is visible. */
    const STATUS_POLL_MS = 20000;
    /** Inline status line lifetime. */
    const TOAST_MS = 4000;
    /** Git graph geometry (one row per commit, one column per lane). */
    const ROW_H = 22;
    const LANE_W = 12;
    /**
     * A patch is capped at 200_000 chars by the host. Rendering that as React
     * elements would cost tens of thousands of spans, so the viewer stops at
     * this many lines and says so — the tail of a huge diff is never silently
     * dropped as if it were the whole change.
     */
    const DIFF_LINE_LIMIT = 4000;

    /** Contribution heatmap: 53 week columns over the trailing year. */
    const CONTRIB_WEEKS = 53;
    const CONTRIB_SKELETON = [0, 1, 2, 3, 4, 5, 6];
    /** GitHub's token page, linked when the calendar needs a wider scope. */
    const TOKEN_URL = 'https://github.com/settings/tokens';
    /** Rows shown in the settings-side repository manager. */
    const SIDE_REPO_LIMIT = 8;

    const STYLE_ID = 'dsh-push-style';

    /* ────────────────────────────── copy ────────────────────────────────── */

    const MESSAGES = {
      zh: {
        /* generic */
        cancel: '取消',
        confirm: '确认',
        close: '关闭',
        refresh: '刷新',
        loading: '加载中…',
        busy: '处理中…',
        unknownError: '未知错误',

        /* settings — accounts */
        accountSection: '账号',
        current: '当前',
        remove: '移除',
        confirmRemove: '确认移除',
        confirmRemoveInline: '再点一次移除',
        addAccountNew: '添加新账号',
        addAccountHint: '支持 Personal Access Token，或设备码登录',
        tokenPlaceholder: 'ghp_... 或 github_pat_...',
        tokenAdd: '添加',
        tokenHint: '该令牌需要 repo 权限；同一账号再次添加会覆盖旧令牌',
        scopeUnknown: '权限未知',
        deviceLogin: '使用设备码登录',
        deviceHint: '需要先在下方填写 OAuth Client ID',
        deviceOpenHint: '在浏览器打开以下地址，并输入设备码：',
        deviceWaiting: '正在等待浏览器授权…',
        deviceExpired: '设备码已过期，请重新发起',
        deviceDone: '设备码登录成功',
        cancelDevice: '停止等待',
        copyCode: '复制设备码',
        copied: '已复制',
        copyFailed: '复制失败',

        /* settings — contributions */
        contribTitle: '贡献图',
        contribTotal: '最近一年 {n} 次贡献',
        contribCell: '{n} 次提交',
        contribToken: '去生成带 read:user 权限的令牌',

        /* settings — notifications */
        notifTitle: '最近消息',
        notifEmpty: '暂无未读消息',
        notifRead: '标记已读',
        noteIssue: 'Issue',
        notePr: 'PR',
        noteDiscussion: '讨论',
        noteRelease: '发布',
        noteCommit: '提交',
        noteComment: '评论',
        noteOther: '通知',

        /* settings — repositories */
        sideRepos: '仓库管理',
        openAll: '查看全部',
        sideReposTruncated: '仅显示最近 {n} 个仓库',

        /* settings — connection */
        connSection: '连接',
        oauthClientId: 'OAuth Client ID',
        oauthClientIdHint: '留空则无法使用设备码登录',
        gitPath: 'Git 路径',
        gitPathPlaceholder: '留空则使用系统 git',
        defaultRemote: '默认远端',
        defaultRemotePlaceholder: 'origin',
        showPrivate: '显示私有仓库',
        save: '保存',
        saved: '已保存',
        gitVersion: 'git 版本',
        gitMissing: '未检测到 git',

        /* repos page */
        pageTitle: 'GitHub 仓库',
        pageSearchPlaceholder: '搜索仓库…',
        filterAll: '全部',
        filterPrivate: '私有',
        repoNew: '新建仓库',
        repoName: '仓库名',
        repoPrivate: '私有仓库',
      repoPublic: '公开仓库',
      repoNonePrivate: '该账号下没有私有仓库',
      repoNonePublic: '该账号下没有公开仓库',
        repoDesc: '描述（可选）',
        repoCreate: '创建',
        repoLoadMore: '加载更多',
        repoOpen: '在浏览器打开',
        repoClone: '复制 clone 地址',
        repoBranches: '分支',
        repoNoAccount: '先到 设置 › GitHub 添加账号',
        repoDelete: '删除',
        repoDeleteConfirm: '确认删除',
        repoDeleteWarn: '删除会永久移除 GitHub 上的该仓库，无法撤销。需要令牌具备 delete_repo 权限。',
        repoEmpty: '没有匹配的仓库',
        repoNoRepos: '该账号下没有仓库',
        repoPrivateBadge: '私有',
        repoDefaultBranch: '默认分支',
        repoUpdated: '更新于',
        repoNoDetail: '未取到分支信息',
        repoSwitchLabel: '切换账号',
        repoNoLogin: '未登录',

        /* repository management dialog (§3c) */
        manageTitle: '仓库管理',
        manageOpen: '管理仓库',
        manageLoading: '正在读取仓库信息…',
        manageRefresh: '重新读取',
        tabOverview: '概览',
        tabBranches: '分支',
        tabSettings: '设置',
        tabReleases: '发布',
        tabCollaborators: '协作者',
        tabWebhooks: 'Webhook',
        statStars: '星标',
        statForks: '复刻',
        statWatchers: '关注',
        statIssues: '开放 issue',
        statPRs: '开放 PR',
        statSize: '体积',
        statLanguage: '语言',
        statLicense: '许可证',
        statCreated: '创建于',
        statUpdated: '更新于',
        statPushed: '最后推送',
        sizeKb: '{n} KB',
        sizeMb: '{n} MB',
        manageNoValue: '—',
        manageTopics: 'Topics',
        manageTopicsEmpty: '还没有 topics',
        topicPlaceholder: '添加 topic 后回车',
        topicAdd: '添加',
        topicRemove: '移除该 topic',
        manageHomepage: '主页',
        manageNoHomepage: '未设置主页',
        manageWarnings: '以下信息未能完整读取：',
        manageBranchesEmpty: '该仓库没有分支',
        branchDefault: '默认',
        branchProtected: '受保护',
        branchSetDefault: '设为默认',
        branchProtect: '保护',
        branchUnprotect: '取消保护',
        branchRename: '重命名',
        branchRenameApply: '确定',
        branchDelete: '删除',
        branchDeleteConfirm: '确认删除分支',
        branchDeleteWarn: '删除远端分支无法撤销，本地分支不受影响。',
        branchNameRequired: '分支名不能为空',
        branchDefaultProtected: '默认分支不能删除',
        manageSettingsSaved: '仓库设置已保存',
        fieldRequired: '请填写必填字段',
        fieldDescription: '描述',
        fieldHomepage: '主页地址',
        fieldPrivate: '私有仓库',
        fieldPrivateHint: '切换可见性会改变仓库地址的访问权限',
        fieldArchived: '已归档',
        fieldArchivedHint: '归档后仓库变为只读，不能推送',
        fieldDefaultBranch: '默认分支',
        saveSettings: '保存设置',
        dangerZone: '危险操作',
        dangerRename: '重命名仓库',
        dangerRenameHint: '旧链接会被 GitHub 重定向，但本地远端需要手动更新。',
        dangerRenameField: '新名称',
        dangerTransfer: '转移仓库',
        dangerTransferHint: '原所有者将失去管理权限，Webhook、协作者与 Actions 配置可能失效。',
        dangerTransferField: '新所有者',
        dangerDelete: '删除仓库',
        dangerDeleteHint: '永久移除 GitHub 上的该仓库，无法撤销。需要 delete_repo 权限。',
        confirmTypeName: '输入 {name} 以确认',
        confirmNameMismatch: '名称不匹配，请输入完整仓库名 {name}',
        releaseNew: '新建发布',
        releaseTag: '标签',
        releaseName: '发布标题',
        releaseBody: '发布说明',
        releaseDraft: '草稿',
        releasePrerelease: '预发布',
        releaseCreate: '创建',
        releaseEdit: '编辑',
        releaseSave: '保存',
        releaseDelete: '删除',
        releaseDeleteConfirm: '确认删除发布',
        releaseEmpty: '还没有发布',
        releaseTagRequired: '请填写标签名',
        releaseDraftBadge: '草稿',
        releasePreBadge: '预发布',
        releaseCreatedAt: '发布于',
        collaboratorsEmpty: '没有协作者',
        collaboratorsAdd: '添加协作者',
        collaboratorsUser: 'GitHub 用户名',
        collaboratorsPermission: '权限',
        collaboratorsRemove: '移除',
        collaboratorsRemoveConfirm: '确认移除',
        collaboratorsRoleAdmin: '管理员',
        collaboratorsRoleWrite: '写入',
        collaboratorsRoleRead: '只读',
        webhooksEmpty: '没有 Webhook',
        webhookActive: '启用',
        webhookInactive: '停用',
        webhookEvents: '{n} 个事件',
        fieldNullWarning: '该项当前不可用',
        manageClosed: '仓库已删除，弹窗已关闭',

        /* push target picker (§3b) */
        pickerLocalGroup: '本地远端',
        pickerGithubGroup: 'GitHub 仓库',
        pickerPlaceholder: '搜索或选择推送目标…',
        pickerSearching: '搜索中…',
        pickerSearchPlaceholder: '键入以搜索 GitHub 仓库',
        pickerNoMatch: '没有匹配的仓库',
        pickerNoLocal: '本地没有远端',
        pickerNoGithub: '该账号下没有仓库',
        pickerClear: '清除选择',
        pickerPrivate: '私有',
        pickerPublic: '公开',
        pickerSelectedLocal: '本地远端',
        pickerSelectedGithub: 'GitHub 仓库',
        pickerTarget: '推送目标',
        pickerMemory: '上次推送到 {name}',
        pickerNoTarget: '未选择推送目标，将使用默认远端',

        /* workspace tab */
        tabTitle: 'Push',
      viewList: "列表",
      viewCard: "卡片",
      viewSizeSmall: "小",
      viewSizeLarge: "大",
      repoPublicBadge: "公开",
      repoNoDescription: "暂无简介",
      langTitle: "语言构成",
      langEmpty: "暂无语言数据",
      accountOpenProfile: "打开 GitHub 主页",
      assetTitle: "发布附件",
      assetUpload: "上传文件",
      assetDrop: "选择或拖入文件",
      assetUploading: "上传中…",
      assetUploaded: "已上传",
      assetEmpty: "还没有附件",
      assetTooLarge: "文件超过 200 MB，无法上传",
      assetHint: "附件会附加到这条发布上，例如构建产物、安装包",
      releaseTarget: "目标提交",
      releaseTargetHint: "留空则使用默认分支的最新提交",
      releaseBranchPick: "选择分支或标签",
      assetDelete: "删除附件",
      assetDeleteConfirm: "确认删除",
      assetSizeKb: "{n} KB",
      releaseFrom: "发版自",
      releaseFromHint: "选一个分支、标签或填写提交 SHA；留空则用默认分支最新提交",
      tabPickInclude: "包含",
      tabPickExclude: "排除",
      tabPickHint: "是否包含在本次提交中",
      rvAgentAsked: "Agent 请求",
      rvAgentAskedHint: "这次审查由智能体发起，需要你确认审查项后才会执行",
      densityTitle: "信息密度",
      densityHint: "调整字号与间距，四个界面同时生效；拖动滑杆可无级调节。",
      density_small: "小",
      density_medium: "中",
      density_large: "大",
      rvTitle: "推送前审查",
      rvClose: "关闭",
      rvSettings: "设置",
      rvModel: "模型配置",
      rvNoModels: "宿主未提供模型配置",
      rvEffort: "思考强度",
      rvEffortDefault: "默认",
      rvPresets: "审查项",
      rvCustom: "自定义",
      rvCustomPrompt: "自定义提示词",
      rvCustomPlaceholder: "补充你想让审查额外注意的内容…",
      rvSavePreset: "存档为预设",
      rvSavePresetTitle: "给这条提示词起个名字",
      rvSave: "保存",
      rvClear: "清空",
      rvCancel: "取消",
      rvNext: "下一步",
      rvSelected: "已选 {n} 项审查",
      rvSelectionEmpty: "尚未选择审查项",
      rvConfirmTitle: "确认审查",
      rvConfirmModel: "模型",
      rvConfirmEffort: "思考强度",
      rvConfirmFiles: "本次审查涉及 {n} 个文件",
      rvConfirmFilesHint: "点击展开",
      rvConfirmFeatures: "将使用的审查项",
      rvConfirmCustomChip: "自定义提示词",
      rvBack: "返回配置",
      rvStart: "开始审查",
      rvRunning: "审查中…",
      rvRunningWith: "正在使用 {model} 审查",
      rvResult: "审查结果",
      rvRerun: "重新审查",
      rvDone: "关闭",
      rvNoFindings: "未发现问题",
      rvDegraded: "本次只执行了规则检查，未调用模型。",
      rvTruncated: "改动较多，超出部分未送审。",
      rvStagedOnly: "只审查已暂存内容",
      rvMaxFiles: "最大文件数",
      rvIncludeUntracked: "包含未跟踪文件",
      rvApproxFiles: "约 {n} 个文件",
      rvAgentReview: "Agent 审查",
      rvBlockedBadge: "审查发现阻断级问题",
      rvFileSkipped: "未送审",
      rvSeverityBlocker: "阻断",
      rvSeverityHigh: "高",
      rvSeverityMedium: "中",
      rvSeverityLow: "低",
      rvSeverityInfo: "提示",
      rvPresetSaved: "已存档",
      rvDeletePreset: "删除这条预设",
        tabDesc: '当前工作区的版本状态、Git 树与推送',
        tabNoRemote: '未关联远端',
        tabDetached: '分离 HEAD',
        tabChanges: '改动',
        tabStaged: '已暂存',
        tabUnstaged: '未暂存',
        tabUntracked: '未跟踪',
        tabConflicted: '冲突',
        tabGraph: 'Git 图',
        tabEmptyLog: '还没有提交记录',
        tabNoFiles: '没有文件改动',
        tabCommit: '提交',
        tabPush: '推送',
        tabPull: '拉取',
        tabFetch: '抓取',
        tabReset: '撤回',
        tabBranch: '分支',
        tabTag: '标签',
        tabCommitMessage: '提交信息',
        tabCommitMessagePlaceholder: '这次改了什么',
        tabIncludeFiles: '包含在本次提交中',
        tabStage: '暂存',
        tabUnstage: '取消暂存',
        tabStageHint: '决定提交时是否包含该文件（Host 的提交接口按文件暂存）',
        tabCommitAndPush: '提交并推送',
        tabCommitOnly: '仅提交',
        tabRemote: '远端',
        tabBranchName: '分支名',
        tabForce: '强制推送',
        tabForceWarn: '强制推送会用本地历史覆盖远端，可能丢弃他人的提交。',
        tabRebase: '以 rebase 方式合并',
        tabPrune: '清理远端已删除的分支',
        tabResetMode: '撤回方式',
        tabModeSoft: 'soft — 仅移动 HEAD，改动保留在暂存区',
        tabModeMixed: 'mixed — 移动 HEAD 并重置暂存区，工作区保留',
        tabModeHard: 'hard — 丢弃全部未提交改动（不可恢复）',
        tabTargetRef: '目标 ref',
        tabHardWarn: 'hard 会丢弃工作区改动且不可恢复，请输入「确认」继续。',
        tabConfirmWord: '确认',
        tabNewBranch: '新建分支',
        tabFrom: '起点（留空则用当前 HEAD）',
        tabCheckout: '检出',
        tabTagName: '标签名',
        tabTagRef: '目标 ref',
        tabPushTag: '同时推送标签',
        tabRestore: '还原',
        tabRestoreConfirm: '确认还原',
        tabRestoreHint: '再次点击即丢弃该文件的工作区改动',
        tabInitTitle: '初始化仓库',
        tabInitName: '仓库名',
        tabInitPrivate: '私有仓库',
        tabInitPrivateHint: '私有',
        tabInitRemote: '同时创建 GitHub 远端',
        tabInitRemoteName: '远端名',
        tabCreateRepo: '创建 Git 仓库',
        tabInitSubmit: '创建仓库',
        tabNoCwd: '无法确定当前工作区路径',
        tabNotRepo: '当前目录还不是 Git 仓库',
        tabCheckoutAction: '检出',
        tabRevert: '反向提交',
        tabCopySha: '复制 sha',
        tabTagHere: '打标签',
        tabResetHere: '在此撤回',
        tabDone: '{label}完成',
        tabOutput: '输出',
        tabDiffTruncated: 'diff 过长，仅显示前 {n} 行',
        tabDiffFolded: 'diff 已折叠其余行',
        tabPickAtLeastOne: '请至少选择一个文件',
        tabMessageRequired: '请填写提交信息',
        tabBranchRequired: '请填写分支名',
        tabTagRequired: '请填写标签名',
        tabInitNameRequired: '请填写仓库名',
        tabNotGitReady: '未找到 git，请先在 设置 › GitHub 配置 git 路径',
        tabTagList: '已有标签',
        tabBranchList: '本地分支',
        tabNoTags: '没有标签',

        /* workspace tab — 关联远端 (POST /local/remote, GET /local/remotes) */
        remoteLinkCta: '关联远端',
        remoteChangeCta: '更换远端',
        remoteUnlinked: '未关联远端',
        remoteUnlinkedHint: '这个仓库还没有远端，推送前先关联一个。',
        remoteLinkedHint: '当前远端 {name} → {url}',
        remoteName: '远端名',
        remoteUrl: '远端地址',
        remoteUrlPlaceholder: 'https://github.com/owner/repo.git 或 git@github.com:owner/repo.git',
        remotePickGithub: 'GitHub 仓库选择',
        remotePickGithubHint: '选中后会填入该仓库的 https 地址',
        remoteManual: '手动粘贴地址',
        remoteNameRequired: '请填写远端名',
        remoteUrlRequired: '请填写远端地址',
        remoteSaveAction: '保存远端',
        remoteListTitle: '已有远端',

        /* workspace tab — 推送指定版本号 */
        pushVersionSource: '版本来源',
        pushVersionBranch: '当前分支',
        pushVersionCommit: '指定提交',
        pushVersionTag: '指定标签',
        pushCommitSearch: '搜索或输入提交 sha',
        pushCommitEmpty: '没有匹配的提交',
        pushSourceRequired: '请选择或填写要推送的提交 / 标签',
        pushTagPick: '选择标签',
        pushTargetBranchRequired: '推送指定版本时必须填写目标分支（git 不能把提交推到隐式目标）',
        pushRefspec: '将推送',
        pushRefspecHint: '{source} → {remote}/{branch}',
        pushRefspecNoBranch: '{source} → {remote}（远端默认分支）',
        pushThisVersion: '推送此版本',
        pushForgetMemory: '忘记记忆',
        pushForgetMemoryHint: '清除当前分支记住的推送目标',
        pushMemoryForgotten: '已清除推送目标记忆',

        /* workspace tab — 暂存 */
        stashTitle: '暂存',
        stashHint: '把工作区改动收进 stash，之后可恢复',
        stashMessage: '暂存说明（可选）',
        stashIncludeUntracked: '包含未跟踪文件',
        stashCreate: '暂存',
        stashList: '暂存列表',
        stashEmpty: '没有暂存记录',
        stashPop: '恢复',
        stashPopHint: '恢复该暂存并从列表中移除',

        /* workspace tab — 合并 */
        mergeTitle: '合并',
        mergeHint: '把某个分支、标签或提交合并进当前分支',
        mergeRef: '要合并的分支 / 标签 / 提交',
        mergeRun: '合并',
        mergeConflicts: '合并产生冲突，解决后请重新提交',

        /* workspace tab — 删除分支 */
        branchDeleteAction: '删除',
        branchDeleteConfirmAction: '确认删除',
        branchDeleteForce: '强制删除',
        branchDeleteForceConfirm: '确认强制删除',
        branchDeleteNotMerged: '该分支还没有完全合并；确认后可强制删除，会丢弃它的提交。',

        /* workspace tab — 更多操作 / 危险操作 */
        tabMore: '更多操作',
        moreDangerZone: '危险操作',
        discardAllTitle: '清空工作区',
        discardAllHint: '丢弃全部未提交改动（含未跟踪文件），不可恢复。',
        discardAllArm: '清空工作区',
        discardAllConfirm: '输入「确认」后才可执行',
        discardAllTypeWord: '请输入「{word}」后继续',

        /* relative time */
        relJustNow: '刚刚',
        relMinutes: '{n} 分钟前',
        relHours: '{n} 小时前',
        relYesterday: '昨天',
        relDays: '{n} 天前',

        /* contract error codes */
        errForbidden: '请求被拒绝（缺少插件校验头）',
        errBadRequest: '请求参数不正确',
        errNotFound: '未找到目标',
        errNoAccount: '尚未添加 GitHub 账号',
        errUnauthorized: '账号凭据失效或权限不足，请重新登录',
        errRateLimited: '触发 GitHub 频率限制，请稍后再试',
        errNetwork: '网络请求失败，请检查网络连接',
        errGitMissing: '未找到 git 可执行文件，请在设置中填写 git 路径',
        errGitFailed: 'Git 命令执行失败',
        errNotARepo: '当前目录不是 Git 仓库',
        errConflict: '存在待解决的冲突',
        errInternal: '插件内部错误',
      },
      en: {
        cancel: 'Cancel',
        confirm: 'Confirm',
        close: 'Close',
        refresh: 'Refresh',
        loading: 'Loading…',
        busy: 'Working…',
        unknownError: 'Unknown error',

        accountSection: 'Accounts',
        current: 'Current',
        remove: 'Remove',
        confirmRemove: 'Confirm remove',
        confirmRemoveInline: 'Click again to remove',
        addAccountNew: 'Add an account',
        addAccountHint: 'Use a personal access token, or sign in with a device code',
        tokenPlaceholder: 'ghp_... or github_pat_...',
        tokenAdd: 'Add',
        tokenHint: 'The token needs repo scope; adding the same account again replaces its token',
        scopeUnknown: 'Scopes unknown',
        deviceLogin: 'Sign in with device code',
        deviceHint: 'Requires an OAuth Client ID below',
        deviceOpenHint: 'Open this address in a browser and enter the code:',
        deviceWaiting: 'Waiting for browser authorisation…',
        deviceExpired: 'The device code expired — start again',
        deviceDone: 'Device sign-in succeeded',
        cancelDevice: 'Stop waiting',
        copyCode: 'Copy code',
        copied: 'Copied',
        copyFailed: 'Copy failed',

        contribTitle: 'Contributions',
        contribTotal: '{n} contributions in the last year',
        contribCell: '{n} commits',
        contribToken: 'Create a token with read:user scope',

        notifTitle: 'Recent notifications',
        notifEmpty: 'No unread notifications',
        notifRead: 'Mark as read',
        noteIssue: 'Issue',
        notePr: 'PR',
        noteDiscussion: 'Discussion',
        noteRelease: 'Release',
        noteCommit: 'Commit',
        noteComment: 'Comment',
        noteOther: 'Notification',

        sideRepos: 'Repositories',
        openAll: 'View all',
        sideReposTruncated: 'Showing the {n} most recent repositories',

        connSection: 'Connection',
        oauthClientId: 'OAuth Client ID',
        oauthClientIdHint: 'Leave empty to disable device sign-in',
        gitPath: 'Git path',
        gitPathPlaceholder: 'Empty uses git from PATH',
        defaultRemote: 'Default remote',
        defaultRemotePlaceholder: 'origin',
        showPrivate: 'Show private repositories',
        save: 'Save',
        saved: 'Saved',
        gitVersion: 'git version',
        gitMissing: 'git not found',

        pageTitle: 'GitHub repositories',
        pageSearchPlaceholder: 'Search repositories…',
        filterAll: 'All',
        filterPrivate: 'Private',
        repoNew: 'New repository',
        repoName: 'Name',
        repoPrivate: 'Private',
      repoPublic: 'Public',
      repoNonePrivate: 'No private repositories for this account',
      repoNonePublic: 'No public repositories for this account',
        repoDesc: 'Description (optional)',
        repoCreate: 'Create',
        repoLoadMore: 'Load more',
        repoOpen: 'Open in browser',
        repoClone: 'Copy clone URL',
        repoBranches: 'Branches',
        repoNoAccount: 'Add an account under Settings › GitHub first',
        repoDelete: 'Delete',
        repoDeleteConfirm: 'Confirm delete',
        repoDeleteWarn: 'This permanently removes the repository on GitHub and cannot be undone. The token needs delete_repo scope.',
        repoEmpty: 'No matching repositories',
        repoNoRepos: 'This account has no repositories',
        repoPrivateBadge: 'Private',
        repoDefaultBranch: 'Default branch',
        repoUpdated: 'Updated',
        repoNoDetail: 'No branch information',
        repoSwitchLabel: 'Switch account',
        repoNoLogin: 'Not signed in',

        manageTitle: 'Manage repository',
        manageOpen: 'Manage repository',
        manageLoading: 'Reading repository…',
        manageRefresh: 'Reload',
        tabOverview: 'Overview',
        tabBranches: 'Branches',
        tabSettings: 'Settings',
        tabReleases: 'Releases',
        tabCollaborators: 'Collaborators',
        tabWebhooks: 'Webhooks',
        statStars: 'Stars',
        statForks: 'Forks',
        statWatchers: 'Watchers',
        statIssues: 'Open issues',
        statPRs: 'Open PRs',
        statSize: 'Size',
        statLanguage: 'Language',
        statLicense: 'License',
        statCreated: 'Created',
        statUpdated: 'Updated',
        statPushed: 'Last push',
        sizeKb: '{n} KB',
        sizeMb: '{n} MB',
        manageNoValue: '—',
        manageTopics: 'Topics',
        manageTopicsEmpty: 'No topics yet',
        topicPlaceholder: 'Type a topic and press Enter',
        topicAdd: 'Add',
        topicRemove: 'Remove this topic',
        manageHomepage: 'Homepage',
        manageNoHomepage: 'No homepage set',
        manageWarnings: 'Some information could not be read:',
        manageBranchesEmpty: 'This repository has no branches',
        branchDefault: 'Default',
        branchProtected: 'Protected',
        branchSetDefault: 'Set as default',
        branchProtect: 'Protect',
        branchUnprotect: 'Unprotect',
        branchRename: 'Rename',
        branchRenameApply: 'Apply',
        branchDelete: 'Delete',
        branchDeleteConfirm: 'Confirm delete',
        branchDeleteWarn: 'Deleting a remote branch cannot be undone; local branches are unaffected.',
        branchNameRequired: 'A branch name is required',
        branchDefaultProtected: 'The default branch cannot be deleted',
        manageSettingsSaved: 'Repository settings saved',
        fieldRequired: 'This field is required',
        fieldDescription: 'Description',
        fieldHomepage: 'Homepage',
        fieldPrivate: 'Private',
        fieldPrivateHint: 'Changing visibility changes who can reach the repository',
        fieldArchived: 'Archived',
        fieldArchivedHint: 'An archived repository is read-only and cannot be pushed to',
        fieldDefaultBranch: 'Default branch',
        saveSettings: 'Save settings',
        dangerZone: 'Danger zone',
        dangerRename: 'Rename repository',
        dangerRenameHint: 'Old links are redirected by GitHub, but local remotes must be updated by hand.',
        dangerRenameField: 'New name',
        dangerTransfer: 'Transfer repository',
        dangerTransferHint: 'The current owner loses admin rights; webhooks, collaborators and Actions may break.',
        dangerTransferField: 'New owner',
        dangerDelete: 'Delete repository',
        dangerDeleteHint: 'Permanently removes the repository on GitHub. Needs delete_repo scope.',
        confirmTypeName: 'Type {name} to confirm',
        confirmNameMismatch: 'Name does not match — type the full repository name {name}',
        releaseNew: 'New release',
        releaseTag: 'Tag',
        releaseName: 'Release title',
        releaseBody: 'Release notes',
        releaseDraft: 'Draft',
        releasePrerelease: 'Pre-release',
        releaseCreate: 'Create',
        releaseEdit: 'Edit',
        releaseSave: 'Save',
        releaseDelete: 'Delete',
        releaseDeleteConfirm: 'Confirm delete',
        releaseEmpty: 'No releases yet',
        releaseTagRequired: 'A tag name is required',
        releaseDraftBadge: 'Draft',
        releasePreBadge: 'Pre-release',
        releaseCreatedAt: 'Released',
        collaboratorsEmpty: 'No collaborators',
        collaboratorsAdd: 'Add collaborator',
        collaboratorsUser: 'GitHub username',
        collaboratorsPermission: 'Permission',
        collaboratorsRemove: 'Remove',
        collaboratorsRemoveConfirm: 'Confirm remove',
        collaboratorsRoleAdmin: 'Admin',
        collaboratorsRoleWrite: 'Write',
        collaboratorsRoleRead: 'Read',
        webhooksEmpty: 'No webhooks',
        webhookActive: 'Active',
        webhookInactive: 'Disabled',
        webhookEvents: '{n} events',
        fieldNullWarning: 'This section is currently unavailable',
        manageClosed: 'Repository deleted — the dialog was closed',

        pickerLocalGroup: 'Local remotes',
        pickerGithubGroup: 'GitHub repositories',
        pickerPlaceholder: 'Search or pick a push target…',
        pickerSearching: 'Searching…',
        pickerSearchPlaceholder: 'Type to search GitHub repositories',
        pickerNoMatch: 'No matching repository',
        pickerNoLocal: 'No local remotes',
        pickerNoGithub: 'This account has no repositories',
        pickerClear: 'Clear selection',
        pickerPrivate: 'Private',
        pickerPublic: 'Public',
        pickerSelectedLocal: 'Local remote',
        pickerSelectedGithub: 'GitHub repo',
        pickerTarget: 'Push target',
        pickerMemory: 'Last pushed to {name}',
        pickerNoTarget: 'No target picked — the default remote will be used',

        tabTitle: 'Push',
      viewList: "List",
      viewCard: "Cards",
      viewSizeSmall: "Small",
      viewSizeLarge: "Large",
      repoPublicBadge: "Public",
      repoNoDescription: "No description",
      langTitle: "Languages",
      langEmpty: "No language data",
      accountOpenProfile: "Open GitHub profile",
      assetTitle: "Release assets",
      assetUpload: "Upload file",
      assetDrop: "Choose or drop a file",
      assetUploading: "Uploading…",
      assetUploaded: "Uploaded",
      assetEmpty: "No assets yet",
      assetTooLarge: "The file exceeds 200 MB",
      assetHint: "Assets are attached to this release, e.g. build output or installers",
      releaseTarget: "Target commit",
      releaseTargetHint: "Leave blank to use the default branch tip",
      releaseBranchPick: "Pick a branch or tag",
      assetDelete: "Delete",
      assetDeleteConfirm: "Confirm",
      assetSizeKb: "{n} KB",
      releaseFrom: "Release from",
      releaseFromHint: "A branch, tag, or commit SHA; blank uses the default branch tip",
      tabPickInclude: "Include",
      tabPickExclude: "Exclude",
      tabPickHint: "Include this file in the next commit",
      rvAgentAsked: "Agent request",
      rvAgentAskedHint: "The agent asked for this review; nothing runs until you confirm the items",
      densityTitle: "Information density",
      densityHint: "Scales text and spacing across all four surfaces; drag for continuous adjustment.",
      density_small: "Small",
      density_medium: "Medium",
      density_large: "Large",
      rvTitle: "Pre-push review",
      rvClose: "Close",
      rvSettings: "Settings",
      rvModel: "Model",
      rvNoModels: "The host provides no model configuration",
      rvEffort: "Reasoning effort",
      rvEffortDefault: "Default",
      rvPresets: "Review checks",
      rvCustom: "Custom",
      rvCustomPrompt: "Custom prompt",
      rvCustomPlaceholder: "Anything else the review should watch for…",
      rvSavePreset: "Save as preset",
      rvSavePresetTitle: "Name this prompt",
      rvSave: "Save",
      rvClear: "Clear",
      rvCancel: "Cancel",
      rvNext: "Next",
      rvSelected: "{n} checks selected",
      rvSelectionEmpty: "No checks selected",
      rvConfirmTitle: "Confirm review",
      rvConfirmModel: "Model",
      rvConfirmEffort: "Reasoning effort",
      rvConfirmFiles: "Reviewing {n} files",
      rvConfirmFilesHint: "Click to expand",
      rvConfirmFeatures: "Checks that will run",
      rvConfirmCustomChip: "Custom prompt",
      rvBack: "Back",
      rvStart: "Start review",
      rvRunning: "Reviewing…",
      rvRunningWith: "Reviewing with {model}",
      rvResult: "Review result",
      rvRerun: "Review again",
      rvDone: "Close",
      rvNoFindings: "No problems found",
      rvDegraded: "Only the rule-based pass ran; no model was called.",
      rvTruncated: "The diff was large; the remainder was not reviewed.",
      rvStagedOnly: "Only staged changes",
      rvMaxFiles: "Max files",
      rvIncludeUntracked: "Include untracked files",
      rvApproxFiles: "about {n} files",
      rvAgentReview: "Agent review",
      rvBlockedBadge: "The review found blocking issues",
      rvFileSkipped: "skipped",
      rvSeverityBlocker: "Blocker",
      rvSeverityHigh: "High",
      rvSeverityMedium: "Medium",
      rvSeverityLow: "Low",
      rvSeverityInfo: "Info",
      rvPresetSaved: "Saved",
      rvDeletePreset: "Delete this preset",
        tabDesc: 'Version state, Git tree and push for the current workspace',
        tabNoRemote: 'No remote linked',
        tabDetached: 'Detached HEAD',
        tabChanges: 'Changes',
        tabStaged: 'Staged',
        tabUnstaged: 'Unstaged',
        tabUntracked: 'Untracked',
        tabConflicted: 'Conflicted',
        tabGraph: 'Git graph',
        tabEmptyLog: 'No commits yet',
        tabNoFiles: 'No changed files',
        tabCommit: 'Commit',
        tabPush: 'Push',
        tabPull: 'Pull',
        tabFetch: 'Fetch',
        tabReset: 'Reset',
        tabBranch: 'Branch',
        tabTag: 'Tag',
        tabCommitMessage: 'Commit message',
        tabCommitMessagePlaceholder: 'What changed',
        tabIncludeFiles: 'Include in this commit',
        tabStage: 'Stage',
        tabUnstage: 'Unstage',
        tabStageHint: 'Whether the commit includes this file (the host stages per file on commit)',
        tabCommitAndPush: 'Commit and push',
        tabCommitOnly: 'Commit only',
        tabRemote: 'Remote',
        tabBranchName: 'Branch',
        tabForce: 'Force push',
        tabForceWarn: 'A force push overwrites remote history and can discard other people’s commits.',
        tabRebase: 'Rebase when pulling',
        tabPrune: 'Prune deleted remote branches',
        tabResetMode: 'Reset mode',
        tabModeSoft: 'soft — move HEAD only, keep changes staged',
        tabModeMixed: 'mixed — move HEAD and reset the index, keep the worktree',
        tabModeHard: 'hard — discard every uncommitted change (irreversible)',
        tabTargetRef: 'Target ref',
        tabHardWarn: 'hard discards worktree changes irreversibly. Type the confirmation word to continue.',
        tabConfirmWord: 'CONFIRM',
        tabNewBranch: 'Create branch',
        tabFrom: 'Start point (empty uses HEAD)',
        tabCheckout: 'Check out',
        tabTagName: 'Tag name',
        tabTagRef: 'Target ref',
        tabPushTag: 'Also push the tag',
        tabRestore: 'Discard',
        tabRestoreConfirm: 'Confirm discard',
        tabRestoreHint: 'Click again to discard this file’s worktree changes',
        tabInitTitle: 'Initialise repository',
        tabInitName: 'Repository name',
        tabInitPrivate: 'Private',
        tabInitPrivateHint: 'Private',
        tabInitRemote: 'Also create the GitHub remote',
        tabInitRemoteName: 'Remote name',
        tabCreateRepo: 'Create Git repository',
        tabInitSubmit: 'Create repository',
        tabNoCwd: 'Cannot determine the workspace path',
        tabNotRepo: 'This directory is not a Git repository yet',
        tabCheckoutAction: 'Check out',
        tabRevert: 'Revert',
        tabCopySha: 'Copy sha',
        tabTagHere: 'Tag here',
        tabResetHere: 'Reset here',
        tabDone: '{label} done',
        tabOutput: 'Output',
        tabDiffTruncated: 'Diff too long — showing the first {n} lines',
        tabDiffFolded: 'Diff folded',
        tabPickAtLeastOne: 'Pick at least one file',
        tabMessageRequired: 'Enter a commit message',
        tabBranchRequired: 'Enter a branch name',
        tabTagRequired: 'Enter a tag name',
        tabInitNameRequired: 'Enter a repository name',
        tabNotGitReady: 'git was not found — set its path under Settings › GitHub',
        tabTagList: 'Tags',
        tabBranchList: 'Local branches',
        tabNoTags: 'No tags',

        remoteLinkCta: 'Link a remote',
        remoteChangeCta: 'Change remote',
        remoteUnlinked: 'No remote linked',
        remoteUnlinkedHint: 'This repository has no remote yet — link one before pushing.',
        remoteLinkedHint: 'Remote {name} → {url}',
        remoteName: 'Remote name',
        remoteUrl: 'Remote URL',
        remoteUrlPlaceholder: 'https://github.com/owner/repo.git or git@github.com:owner/repo.git',
        remotePickGithub: 'Pick a GitHub repository',
        remotePickGithubHint: 'Selecting one fills in that repository’s https URL',
        remoteManual: 'Paste a URL manually',
        remoteNameRequired: 'Enter a remote name',
        remoteUrlRequired: 'Enter a remote URL',
        remoteSaveAction: 'Save remote',
        remoteListTitle: 'Existing remotes',

        pushVersionSource: 'Version to push',
        pushVersionBranch: 'Current branch',
        pushVersionCommit: 'Specific commit',
        pushVersionTag: 'Specific tag',
        pushCommitSearch: 'Search or type a commit sha',
        pushCommitEmpty: 'No matching commit',
        pushSourceRequired: 'Pick or type the commit / tag to push',
        pushTagPick: 'Pick a tag',
        pushTargetBranchRequired: 'A target branch is required to push a specific version (git cannot push a commit to an implicit destination)',
        pushRefspec: 'Will push',
        pushRefspecHint: '{source} → {remote}/{branch}',
        pushRefspecNoBranch: '{source} → {remote} (remote default branch)',
        pushThisVersion: 'Push this version',
        pushForgetMemory: 'Forget memory',
        pushForgetMemoryHint: 'Clear the push target remembered for this branch',
        pushMemoryForgotten: 'Remembered push target cleared',

        stashTitle: 'Stash',
        stashHint: 'Park working-tree changes in a stash and restore them later',
        stashMessage: 'Stash message (optional)',
        stashIncludeUntracked: 'Include untracked files',
        stashCreate: 'Stash',
        stashList: 'Stashes',
        stashEmpty: 'No stashes',
        stashPop: 'Restore',
        stashPopHint: 'Restore this stash and drop it from the list',

        mergeTitle: 'Merge',
        mergeHint: 'Merge a branch, tag or commit into the current branch',
        mergeRef: 'Branch / tag / commit to merge',
        mergeRun: 'Merge',
        mergeConflicts: 'The merge produced conflicts — resolve them and commit again',

        branchDeleteAction: 'Delete',
        branchDeleteConfirmAction: 'Confirm delete',
        branchDeleteForce: 'Force delete',
        branchDeleteForceConfirm: 'Confirm force delete',
        branchDeleteNotMerged: 'This branch is not fully merged; a forced delete discards its commits.',

        tabMore: 'More',
        moreDangerZone: 'Danger zone',
        discardAllTitle: 'Clear the working tree',
        discardAllHint: 'Discards every uncommitted change, untracked files included. Irreversible.',
        discardAllArm: 'Clear working tree',
        discardAllConfirm: 'Type the word before this can run',
        discardAllTypeWord: 'Type "{word}" to continue',

        relJustNow: 'just now',
        relMinutes: '{n} min ago',
        relHours: '{n} h ago',
        relYesterday: 'yesterday',
        relDays: '{n} d ago',

        errForbidden: 'Request rejected (missing plugin header)',
        errBadRequest: 'Invalid request parameters',
        errNotFound: 'Not found',
        errNoAccount: 'No GitHub account added yet',
        errUnauthorized: 'Credentials expired or lack permission — sign in again',
        errRateLimited: 'GitHub rate limit reached — try again later',
        errNetwork: 'Network request failed — check the connection',
        errGitMissing: 'git not found — set its path in the settings',
        errGitFailed: 'Git command failed',
        errNotARepo: 'This directory is not a Git repository',
        errConflict: 'There are unresolved conflicts',
        errInternal: 'Plugin internal error',
      },
    };

    /**
     * Host locale service is optional and version-dependent: it is probed via
     * ctx.get (never injected, because a missing injection parks the whole
     * fiber INACTIVE). Absent or unrecognised → Chinese, the plugin's default.
     */
    let hostLocale = null;

    function attachHostLocale(ctx) {
      try {
        hostLocale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
      } catch (err) {
        hostLocale = null;
      }
    }

    function activeLang() {
      let active;
      try {
        active = hostLocale && typeof hostLocale.getLocale === 'function'
          ? hostLocale.getLocale().active
          : undefined;
      } catch (err) {
        active = undefined;
      }
      if (!active) {
        try {
          active = hostLocale && typeof hostLocale.getSnapshot === 'function'
            ? hostLocale.getSnapshot().active
            : undefined;
        } catch (err) {
          active = undefined;
        }
      }
      const raw = String(active || (typeof navigator !== 'undefined' && navigator.language) || '');
      return /^en/i.test(raw) ? 'en' : 'zh';
    }

    function t(key, params) {
      const table = MESSAGES[activeLang()] || MESSAGES.zh;
      let text = table[key];
      if (text === undefined) text = MESSAGES.zh[key];
      if (text === undefined) return key;
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, (m, name) => (
        params[name] === undefined || params[name] === null ? '' : String(params[name])
      ));
    }

    /* ──────────────────────────── HTTP helper ───────────────────────────── */

    /** CONTRACT §0 error codes → copy keys. */
    const ERROR_KEYS = {
      FORBIDDEN: 'errForbidden',
      BAD_REQUEST: 'errBadRequest',
      NOT_FOUND: 'errNotFound',
      NO_ACCOUNT: 'errNoAccount',
      UNAUTHORIZED: 'errUnauthorized',
      RATE_LIMITED: 'errRateLimited',
      NETWORK: 'errNetwork',
      GIT_MISSING: 'errGitMissing',
      GIT_FAILED: 'errGitFailed',
      NOT_A_REPO: 'errNotARepo',
      CONFLICT: 'errConflict',
      INTERNAL: 'errInternal',
    };

    /**
     * The single fetch seam: adds the CSRF header on non-GET, always sends
     * `content-type: application/json`, unwraps the `{ok,data|error}` envelope
     * and throws a Chinese Error on failure. Callers only see payload data.
     */
    async function api(ctx, path, options) {
      const opts = options || {};
      const method = opts.method || 'GET';
      const headers = { 'content-type': 'application/json' };
      if (method !== 'GET') headers['x-dsh-plugin'] = PLUGIN_ID;

      let response;
      try {
        response = await fetch(path, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          credentials: 'same-origin',
        });
      } catch (err) {
        // A rejected fetch means the request never reached the Host at all
        // (server down, offline, DNS). The Host's own NETWORK payload is a
        // DIFFERENT thing and is handled by the envelope branch below, where
        // its specific diagnosis is preserved instead of being replaced by
        // the generic sentence here.
        const netErr = new Error(t('errNetwork'));
        netErr.code = 'NETWORK';
        netErr.detail = err && err.message ? String(err.message) : '';
        throw netErr;
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch (err) {
        payload = null;
      }

      if (!response.ok || !payload || payload.ok === false) {
        const info = payload && payload.error ? payload.error : null;
        const code = info && info.code ? info.code : 'HTTP_' + response.status;
        // The Host writes a specific, actionable Chinese message (it knows
        // whether it was a TLS failure, a missing scope, a rate limit, …).
        // Prefer THAT over the generic per-code label: replacing a precise
        // diagnosis with "网络请求失败，请检查网络连接" is what made a TLS
        // certificate error look like a dead connection. The generic label is
        // only a fallback for envelopes that carry no message.
        const hostMessage = info && typeof info.message === 'string' ? info.message.trim() : '';
        const message = hostMessage
          || (ERROR_KEYS[code] ? t(ERROR_KEYS[code]) : t('unknownError'));
        const wrapped = new Error(message);
        wrapped.code = code;
        // Keep the label so a caller can show a short headline beside the
        // detailed sentence.
        wrapped.label = ERROR_KEYS[code] ? t(ERROR_KEYS[code]) : '';
        wrapped.status = info && info.status;
        throw wrapped;
      }
      return payload.data;
    }

    /* ──────────────────────────── small utils ───────────────────────────── */

    function relativeTime(ts) {
      if (!ts) return '';
      const then = new Date(ts).getTime();
      if (!Number.isFinite(then)) return '';
      const diff = Date.now() - then;
      if (diff < 60000) return t('relJustNow');
      const minutes = Math.floor(diff / 60000);
      if (minutes < 60) return t('relMinutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('relHours', { n: hours });
      const days = Math.floor(hours / 24);
      if (days === 1) return t('relYesterday');
      if (days < 30) return t('relDays', { n: days });
      return new Date(then).toLocaleDateString();
    }

    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (err) {
        /* falls through to the failure return */
      }
      return false;
    }

    /**
     * Bucket `/local/status.files` for display.
     *
     * A file is reported once with three independent flags, so a file that is
     * staged AND then edited again cannot appear in both lists. Priority is
     * conflict (it blocks everything) → untracked (it has no index entry) →
     * staged (it is what the next commit would take) → unstaged.
     */
    function groupFiles(files) {
      const groups = { staged: [], unstaged: [], untracked: [], conflicted: [] };
      for (const file of files || []) {
        if (file.conflicted) groups.conflicted.push(file);
        else if (file.untracked) groups.untracked.push(file);
        else if (file.staged) groups.staged.push(file);
        else groups.unstaged.push(file);
      }
      return groups;
    }

    function splitPatch(patch) {
      const lines = String(patch || '').split('\n');
      const shown = lines.slice(0, DIFF_LINE_LIMIT);
      return { lines: shown, folded: lines.length > shown.length };
    }

    /** Local-time `YYYY-MM-DD`; `toISOString` would shift the day in UTC+8. */
    function dateKey(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return date.getFullYear() + '-' + month + '-' + day;
    }

    /**
     * 53 columns of 7 days, ending on the newest day GitHub returned (or today
     * when the response is empty). Rows are weekdays with Sunday on top.
     */
    function buildContributionWeeks(days) {
      const counts = new Map();
      let newest = 0;
      for (const day of days || []) {
        const key = String((day && day.date) || '');
        if (!key) continue;
        counts.set(key, Number(day.count) || 0);
        const stamp = new Date(key + 'T00:00:00').getTime();
        if (Number.isFinite(stamp) && stamp > newest) newest = stamp;
      }

      const anchor = new Date(newest || Date.now());
      anchor.setHours(0, 0, 0, 0);
      anchor.setDate(anchor.getDate() - anchor.getDay()); // Sunday of that week

      const weeks = [];
      for (let w = CONTRIB_WEEKS - 1; w >= 0; w -= 1) {
        const column = [];
        for (let d = 0; d < 7; d += 1) {
          const date = new Date(anchor.getTime());
          date.setDate(date.getDate() - w * 7 + d);
          const key = dateKey(date);
          column.push({ date: key, count: counts.get(key) || 0 });
        }
        weeks.push(column);
      }
      return weeks;
    }

    /** Count → intensity step, matching the five CSS opacity levels. */
    function contributionLevel(count) {
      if (!count) return 0;
      if (count <= 3) return 1;
      if (count <= 6) return 2;
      if (count <= 9) return 3;
      return 4;
    }

    /**
     * Notification `type` → copy key. The host forwards GitHub's own strings,
     * which are capitalised ('Issue', 'PullRequest', 'Discussion', 'Release').
     */
    const NOTIFICATION_TYPES = {
      issue: 'noteIssue',
      pullrequest: 'notePr',
      pull_request: 'notePr',
      discussion: 'noteDiscussion',
      release: 'noteRelease',
      commit: 'noteCommit',
      checksuite: 'noteCommit',
      comment: 'noteComment',
    };

    function notificationLabel(type) {
      const raw = String(type || '').replace(/[-\s]/g, '').toLowerCase();
      const key = NOTIFICATION_TYPES[raw];
      return key ? t(key) : t('noteOther');
    }

    /** `owner/name` whichever shape the host used for the repository field. */
    function notificationRepo(item) {
      if (!item) return '';
      if (item.repo) return String(item.repo);
      if (item.repository) return String(item.repository);
      if (item.owner && item.name) return item.owner + '/' + item.name;
      if (item.owner && item.repoName) return item.owner + '/' + item.repoName;
      return '';
    }

    /* ──────────────────────────── stylesheet ────────────────────────────── */

    const CSS = `
.dsh-push-root { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dsh-push-root * { box-sizing: border-box; }
.dsh-push-root button, .dsh-push-root input, .dsh-push-root select, .dsh-push-root textarea { font: inherit; }
.dsh-push-root button:disabled { opacity: .45; cursor: default; }

/* ── buttons ─────────────────────────────────────────────────────────── */
.dsh-push-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px;
  font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer; text-decoration: none;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; }
.dsh-push-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-btn--primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.dsh-push-btn--danger { color: var(--dsw-alias-state-error-primary); }
.dsh-push-btn--on { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); }
.dsh-push-btn--mini { height: 20px; padding: 0 6px; font-size: 11px; border-radius: 5px; }

/* ── pills / badges ──────────────────────────────────────────────────── */
.dsh-push-pill { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px;
  font-size: 11px; line-height: 16px; border-radius: 6px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); }
.dsh-push-pill--active { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-push-pill--ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-push-pill--warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-push-pill--err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-push-pill--idle { color: var(--dsw-alias-state-idle-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-push-pill--muted { color: var(--dsw-alias-label-secondary); }
.dsh-push-mono { font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace; }

/* ── inputs ──────────────────────────────────────────────────────────── */
.dsh-push-input { width: 100%; min-width: 0; height: 28px; padding: 0 8px; font-size: 13px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; outline: none; }
.dsh-push-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-push-select { height: 26px; max-width: 100%; padding: 0 6px; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; }
.dsh-push-textarea { width: 100%; min-height: 60px; padding: 6px 8px; font-size: 12px; resize: vertical;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; outline: none; }
.dsh-push-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-push-checkbox { width: 13px; height: 13px; margin: 0; flex: none; accent-color: var(--dsw-alias-brand-primary); }

/* ── switch ──────────────────────────────────────────────────────────── */
.dsh-push-switch { position: relative; width: 32px; height: 18px; flex: none; padding: 0; cursor: pointer;
  border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dsh-push-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-push-switch-knob { position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-bg-base); transition: left .12s ease; }
.dsh-push-switch[aria-checked="true"] .dsh-push-switch-knob { left: 15px; }

/* ── segmented control ───────────────────────────────────────────────── */
.dsh-push-seg { display: inline-flex; overflow: hidden; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); }
.dsh-push-seg > button { height: 24px; padding: 0 8px; font-size: 12px; cursor: pointer; border: 0;
  color: var(--dsw-alias-label-secondary); background: transparent; }
.dsh-push-seg > button.dsh-push-seg-on { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }

/* ── avatars ─────────────────────────────────────────────────────────── */
.dsh-push-avatar { flex: none; border-radius: 50%; object-fit: cover; background: var(--dsw-alias-bg-layer-2); }
.dsh-push-avatar--letter { display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2); }

/* ── settings section ────────────────────────────────────────────────── */
.dsh-push-settings { display: flex; flex-direction: column; gap: 18px; max-width: 660px; padding: 2px 0 12px; }
.dsh-push-group { display: flex; flex-direction: column; }
.dsh-push-group-head { font-size: 13px; font-weight: 600; padding: 2px 0 6px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-push-gearbtn { flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-push-gearbtn:hover { color: var(--dsw-alias-label-primary); }
.dsh-push-gearbtn.is-on { color: var(--dsw-alias-brand-primary); }

/* ── modal (global options) ──────────────────────────────────────────── */
/* The scrim and shadows derive from the label token instead of a literal
   black: only --dsw-* tokens are allowed here, and a token-derived wash
   follows the theme in both light and dark mode. */
.dsh-push-overlay { position: fixed; inset: 0; z-index: 20000;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 24px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent); }
.dsh-push-modal { display: flex; flex-direction: column; width: 100%; max-width: 520px;
  max-height: calc(100vh - 64px); color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent); }
.dsh-push-modal-head { display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-modal-title { font-size: 13px; font-weight: 600; }
.dsh-push-modal-head .dsh-push-iconbtn { margin-left: auto; }
.dsh-push-modal-body { padding: 4px 14px 12px; overflow: auto; }
.dsh-push-modal--bare .dsh-push-modal-body { display: flex; flex-direction: column;
  padding: 0; overflow: hidden; flex: 1 1 auto; min-height: 0; }
.dsh-push-modal--bare .dsh-push-modal-foot { flex: none; }
.dsh-push-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-modal-status { margin-right: auto; min-width: 0; font-size: 12px; }
.dsh-push-modal--wide { max-width: 760px; }
/* Second head slot (the management dialog puts repository identity here). */
.dsh-push-modal-subhead { display: flex; flex-direction: column; gap: 1px;
  flex: 1 1 auto; min-width: 0; padding: 0 8px; }

/* ── repository management dialog ────────────────────────────────────── */
.dsh-push-manage-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-push-manage-name { font-size: 13px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-manage-desc { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-manage-tabs { display: flex; gap: 2px; padding: 8px 14px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); overflow-x: auto; }
.dsh-push-tabs-btn { display: inline-flex; align-items: center; height: 24px; padding: 0 8px;
  flex: none; cursor: pointer; font-size: 12px; white-space: nowrap; border: 0;
  border-bottom: 2px solid transparent; border-radius: 5px 5px 0 0;
  color: var(--dsw-alias-label-secondary); background: transparent; }
.dsh-push-tabs-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-push-tabs-btn.is-on { color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-brand-primary); }
.dsh-push-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.dsh-push-stat { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dsh-push-stat-k { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-stat-v { font-size: 13px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-subhead { display: flex; align-items: center; gap: 6px; min-height: 22px;
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-push-block { display: flex; flex-direction: column; gap: 6px; }
.dsh-push-warnbox { padding: 6px 8px; border-radius: 6px; font-size: 12px; line-height: 16px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.dsh-push-warnbox div + div { margin-top: 3px; }
.dsh-push-skel { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
.dsh-push-skel-row { height: 12px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); }
.dsh-push-skel-row:nth-child(2n) { opacity: .6; }
.dsh-push-branch { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 3px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-branch-name { display: flex; align-items: center; gap: 5px; flex: 1 1 auto; min-width: 0;
  font-size: 12px; }
.dsh-push-branch-name span.dsh-push-mono { overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.dsh-push-branch-actions { display: flex; align-items: center; gap: 4px; flex: none; flex-wrap: wrap;
  justify-content: flex-end; }
.dsh-push-chip { display: inline-flex; align-items: center; gap: 3px; height: 20px; padding: 0 4px 0 6px;
  font-size: 11px; border-radius: 5px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dsh-push-chip button { display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; padding: 0; cursor: pointer; border: 0; border-radius: 3px;
  color: var(--dsw-alias-label-secondary); background: transparent; }
.dsh-push-chip button:hover { color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-2); }
.dsh-push-dangerzone { display: flex; flex-direction: column; gap: 8px; margin-top: 4px;
  padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); }
.dsh-push-dangerrow { display: flex; flex-direction: column; gap: 4px; padding: 4px 0;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-dangerrow:first-of-type { border-top: 0; }
.dsh-push-danger-title { font-size: 12px; font-weight: 600; }
.dsh-push-release { display: flex; align-items: flex-start; gap: 6px; padding: 6px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-release-main { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.dsh-push-release-tag { font-size: 12px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-release-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-release-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dsh-push-rows { display: flex; flex-direction: column; }
.dsh-push-kvrow { display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.dsh-push-kvrow > span:first-child { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); }
.dsh-push-kvrow > span:last-child { flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }

/* ── push target picker ──────────────────────────────────────────────── */
.dsh-push-picker { position: relative; display: flex; flex-direction: column; gap: 4px; }
.dsh-push-picker-box { display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 6px;
  cursor: text; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); }
.dsh-push-picker-box:focus-within { border-color: var(--dsw-alias-brand-primary); }
.dsh-push-picker-box input { flex: 1 1 auto; min-width: 0; height: 100%; border: 0; outline: none;
  background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsh-push-picker-selected { display: flex; align-items: center; gap: 5px; min-width: 0;
  font-size: 12px; }
.dsh-push-picker-selected span.dsh-push-picker-name { overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.dsh-push-picker-list { display: flex; flex-direction: column; max-height: 216px; overflow: auto;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); }
.dsh-push-picker-group { position: sticky; top: 0; padding: 3px 8px; font-size: 11px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-picker-row { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 2px 8px;
  text-align: left; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: transparent; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-picker-row:last-child { border-bottom: 0; }
.dsh-push-picker-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-picker-row.is-active { background: var(--dsw-alias-bg-layer-2);
  box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.dsh-push-picker-row-name { flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-picker-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-push-spin { width: 11px; height: 11px; flex: none; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary);
  animation: dsh-push-spin .7s linear infinite; }
@keyframes dsh-push-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.dsh-push-memory { display: flex; align-items: center; gap: 4px; font-size: 11px;
  color: var(--dsw-alias-label-secondary); }

/* ── segmented control (private / public repos) ──────────────────────── */
.dsh-push-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-seg-btn { display: inline-flex; align-items: center; gap: 5px; height: 22px;
  padding: 0 9px; font-size: 12px; line-height: 18px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: transparent;
  border: 0; border-radius: 5px; }
.dsh-push-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.dsh-push-seg-btn.is-on { color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent); }
.dsh-push-seg-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-segrow { margin-top: 6px; }
.dsh-push-row { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 6px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-row-label { flex: 1 1 auto; min-width: 0; }
.dsh-push-row-title { font-size: 13px; }
.dsh-push-row-hint { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.dsh-push-row-control { display: flex; align-items: center; gap: 8px; flex: 0 1 auto; }
.dsh-push-error { font-size: 12px; line-height: 16px; color: var(--dsw-alias-state-error-primary); }
.dsh-push-ok { font-size: 12px; line-height: 16px; color: var(--dsw-alias-state-success-primary); }
.dsh-push-hint { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.dsh-push-device { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; margin: 2px 0 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dsh-push-device-code { font-size: 16px; letter-spacing: 1px; font-weight: 600; }
.dsh-push-link { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dsh-push-link:hover { text-decoration: underline; }
.dsh-push-divider { height: 1px; flex: none; background: var(--dsw-alias-border-l1); }
.dsh-push-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-push-side-head { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.dsh-push-side-title { font-size: 13px; font-weight: 600; }

/* ── account card + dropdown ─────────────────────────────────────────── */
.dsh-push-acc-card { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px;
  text-align: left; cursor: pointer; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.dsh-push-acc-card:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-acc-card--empty { flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; min-height: 84px; text-align: center; }
.dsh-push-acc-stack { display: flex; flex-direction: column; }
.dsh-push-acc-card-main { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.dsh-push-acc-card-name { font-size: 13px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-acc-card-sub { display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-push-acc-card-login { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-acc-card-empty { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.dsh-push-acc-card-profile { flex: none; display: inline-flex; align-items: center;
  justify-content: center; width: 22px; height: 22px; border-radius: 5px;
  color: var(--dsw-alias-label-secondary); text-decoration: none; }
.dsh-push-acc-card-profile:hover { color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2); }
.dsh-push-acc-card-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-push-chevron { display: inline-flex; flex: none; color: var(--dsw-alias-label-secondary);
  transform: rotate(90deg); transition: transform .12s ease; }
.dsh-push-chevron--open { transform: rotate(270deg); }
.dsh-push-acc-drop { display: flex; flex-direction: column; margin-top: 6px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsh-push-acc-row { display: flex; align-items: center; gap: 4px; padding: 2px 6px 2px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-acc-row-main { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0;
  height: 34px; padding: 0 8px; cursor: pointer; text-align: left; color: var(--dsw-alias-label-primary);
  background: transparent; border: 0; border-radius: 6px; }
.dsh-push-acc-row-main:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-acc-row-login { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-acc-addrow { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px;
  cursor: pointer; font-size: 12px; text-align: left; color: var(--dsw-alias-brand-primary);
  background: transparent; border: 0; }
.dsh-push-acc-addrow:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 22px;
  height: 22px; flex: none; padding: 0; cursor: pointer; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid transparent; }
.dsh-push-iconbtn:hover { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dsh-push-acc-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px;
  background: var(--dsw-alias-bg-layer-1); }
.dsh-push-acc-token { flex: 1 1 180px; width: auto; }

/* ── contribution heatmap ────────────────────────────────────────────── */
.dsh-push-contrib-grid { display: flex; gap: 2px; padding: 2px 0; max-width: 100%; overflow-x: auto; }
.dsh-push-contrib-week { display: flex; flex-direction: column; gap: 2px; flex: none; }
.dsh-push-contrib-day { width: 11px; height: 11px; border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2); }
.dsh-push-contrib--l1 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 25%, transparent); }
.dsh-push-contrib--l2 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, transparent); }
.dsh-push-contrib--l3 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 75%, transparent); }
.dsh-push-contrib--l4 { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 100%, transparent); }
.dsh-push-contrib-skel { display: flex; flex-direction: column; gap: 3px; padding: 3px 0; }
.dsh-push-contrib-skel-row { height: 11px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); }
.dsh-push-contrib-skel-row:nth-child(2n) { opacity: .6; }

/* ── notifications ───────────────────────────────────────────────────── */
.dsh-push-note { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;
  cursor: pointer; border-radius: 6px; }
.dsh-push-note:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-note-dot { width: 6px; height: 6px; flex: none; margin-top: 7px; border-radius: 50%;
  background: transparent; }
.dsh-push-note-dot--on { background: var(--dsw-alias-brand-primary); }
.dsh-push-note-main { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.dsh-push-note-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-push-note-title { min-width: 0; font-size: 12px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-note--unread .dsh-push-note-title { font-weight: 600; }
.dsh-push-note-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-note-chip { flex: none; padding: 0 4px; font-size: 10px; line-height: 14px; border-radius: 4px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); }
.dsh-push-note-actions { display: flex; align-items: center; gap: 4px; flex: none; }

/* ── sidebar panellist icon ──────────────────────────────────────────── */
.dsh-push-sb-icon { display: inline-flex; align-items: center; justify-content: center; color: currentColor; }

/* ── main page ───────────────────────────────────────────────────────── */
.dsh-push-page { display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dsh-push-page-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-page-title { font-size: 14px; font-weight: 600; }
.dsh-push-page-spacer { flex: 1 1 auto; }
.dsh-push-page-toolbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-page-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 16px 16px; }
.dsh-push-page-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-push-search { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; flex: 1 1 220px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); }
.dsh-push-search input { flex: 1 1 auto; min-width: 0; height: 100%; border: 0; outline: none;
  background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-push-repo { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-repo-head { display: flex; align-items: center; gap: 8px; padding: 9px 2px; cursor: pointer; }
.dsh-push-repo-head:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-push-repo-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The name is its own button (it opens the management dialog); it must look
   exactly like the text it replaces until hovered. */
.dsh-push-repo-name--link { min-width: 0; padding: 0; text-align: left; cursor: pointer;
  font-size: 13px; color: inherit; background: transparent; border: 0; border-radius: 4px; }
.dsh-push-repo-name--link:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
.dsh-push-repo-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-push-repo-desc { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  padding: 0 2px 8px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dsh-push-repo-detail { display: flex; flex-direction: column; gap: 8px; padding: 2px 2px 12px; }
.dsh-push-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-push-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-push-empty { padding: 40px 8px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dsh-push-dangerbox { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }

/* ── sidebar tab ─────────────────────────────────────────────────────── */
.dsh-push-tab { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-specific-sidebar-fill); }
.dsh-push-tab-head { flex: none; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-tab-repo { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-push-tab-repo-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-tab-repo-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-toolbar { flex: none; display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dsh-push-section { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-section-head { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 10px;
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-push-section-sub { display: flex; align-items: center; gap: 6px; min-height: 22px; padding: 0 10px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-file { display: flex; align-items: center; gap: 5px; min-height: 24px; padding: 0 8px 0 10px;
  cursor: pointer; }
.dsh-push-file:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-file-name { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-file-actions { display: flex; gap: 3px; flex: none; opacity: 0; }
.dsh-push-file:hover .dsh-push-file-actions, .dsh-push-file:focus-within .dsh-push-file-actions { opacity: 1; }
.dsh-push-commit { position: relative; display: flex; align-items: center; gap: 6px; height: 22px;
  padding-right: 10px; cursor: default; }
.dsh-push-commit:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-commit-graph { flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-push-commit-dot { fill: var(--dsw-alias-brand-primary); stroke: none; }
.dsh-push-commit-subject { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-commit-sha { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; }
.dsh-push-commit-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; }
.dsh-push-commit-actions { position: absolute; right: 4px; top: 1px; display: flex; gap: 2px; opacity: 0;
  padding: 1px 2px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dsh-push-commit:hover .dsh-push-commit-actions, .dsh-push-commit:focus-within .dsh-push-commit-actions { opacity: 1; }
.dsh-push-ref { font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-brand-primary); white-space: nowrap; }
.dsh-push-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); max-height: 46vh; overflow: auto; }
.dsh-push-field { display: flex; flex-direction: column; gap: 3px; }
.dsh-push-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-push-files { max-height: 140px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.dsh-push-filepick { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: 12px; }
.dsh-push-filepick span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-warn { font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-warn-primary); }
.dsh-push-diff { margin: 0; max-height: 240px; overflow: auto; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 11px; line-height: 16px; white-space: pre; }
.dsh-push-diff-line { display: block; }
.dsh-push-diff-line--add { color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.dsh-push-diff-line--del { color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dsh-push-diff-line--hunk { color: var(--dsw-alias-label-secondary); }
.dsh-push-toastbar { flex: none; min-height: 28px; padding: 4px 10px; font-size: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-toastbar--ok { color: var(--dsw-alias-state-success-primary); }
.dsh-push-toastbar--err { color: var(--dsw-alias-state-error-primary); }
/* Remote association bar: the prominent "not linked yet" state, shown above
   the toolbar in BOTH states so the affordance never vanishes from the page. */
.dsh-push-remotebar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px;
  font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.dsh-push-remotebar-text { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-state-warn-primary); }
.dsh-push-remotebar-text--ok { color: var(--dsw-alias-label-secondary); }
/* The refspec preview under the push form: what will actually leave the repo. */
.dsh-push-refline { display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
/* One local branch = its row plus an optional inline force-delete block. */
.dsh-push-branchrow { display: flex; flex-direction: column;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-branchrow:last-child { border-bottom: 0; }
.dsh-push-branchrow .dsh-push-filepick { border-bottom: 0; }
.dsh-push-branchrow-extra { display: flex; flex-direction: column; gap: 4px; padding: 0 6px 6px; }
/* Commit suggestions reuse the picker rows; this only softens the boxed look. */
.dsh-push-suggest { max-height: 132px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; }
.dsh-push-output { margin: 0 0 4px; max-height: 96px; overflow: auto; white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); }

/* ── not-a-repository empty state ────────────────────────────────────── */
.dsh-push-repoempty { display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 34px 12px 16px; text-align: center; }
.dsh-push-repoempty-icon { display: flex; color: var(--dsw-alias-label-secondary); }
.dsh-push-repoempty-title { font-size: 13px; font-weight: 600; }
.dsh-push-repoempty-path { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace; }
.dsh-push-repoempty-form { width: 100%; max-width: 300px; margin-top: 4px; text-align: left; }
.dsh-push-repoempty-form .dsh-push-form { border-bottom: 0; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); }

@media (hover: none) {
  .dsh-push-file-actions, .dsh-push-commit-actions { opacity: 1; }
}

/* ── pre-push review ─────────────────────────────────────────────── */
.dsh-push-rv-head { display: flex; align-items: center; gap: 6px;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* Marks a dialog the agent opened, so it never looks like a stray window. */
.dsh-push-rv-agenttag { font-size: 11px; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-rv-title { font-size: 13px; font-weight: 600; }
.dsh-push-rv-spacer { flex: 1 1 auto; }
.dsh-push-rv-muted { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-push-rv-sub { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-push-rv-sub-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-push-rv-model { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-push-rv-select { height: 24px; max-width: 260px; font-size: 12px; }
.dsh-push-rv-number { width: 90px; }
.dsh-push-rv-settings { padding: 8px 14px; display: flex; flex-direction: column; gap: 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-push-rv-field { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.dsh-push-rv-field-label { flex: 0 0 88px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); }
.dsh-push-rv-field-body { flex: 1 1 auto; min-width: 0; }
.dsh-push-rv-divider { height: 1px; background: var(--dsw-alias-border-l1); }
.dsh-push-rv-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px 14px; }
.dsh-push-rv-group { margin-bottom: 12px; }
.dsh-push-rv-group-head { font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); padding-bottom: 5px; }
.dsh-push-rv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px; }
.dsh-push-rv-card { display: flex; align-items: flex-start; gap: 7px; text-align: left;
  padding: 8px 9px; cursor: pointer; font-size: 12px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; }
.dsh-push-rv-card:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-push-rv-card.is-on { border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsh-push-rv-card-check { flex: none; width: 14px; height: 14px; margin-top: 1px;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 3px;
  border: 1px solid var(--dsw-alias-border-l2); }
.dsh-push-rv-card.is-on .dsh-push-rv-card-check {
  border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-push-rv-card-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-push-rv-card-title { font-weight: 500; }
.dsh-push-rv-card-desc { font-size: 11px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dsh-push-rv-card-del { flex: none; color: var(--dsw-alias-label-secondary); cursor: pointer;
  display: inline-flex; padding: 1px; border-radius: 3px; }
.dsh-push-rv-card-del:hover { color: var(--dsw-alias-state-error-primary); }
.dsh-push-rv-custom { padding: 9px 14px 12px; display: flex; flex-direction: column; gap: 6px; }
.dsh-push-rv-custom-head { display: flex; align-items: center; gap: 8px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); }
.dsh-push-rv-custom-head .dsh-push-btn { margin-left: auto; }
.dsh-push-rv-inline { display: flex; align-items: center; gap: 5px; margin-left: auto; }
.dsh-push-rv-textarea { width: 100%; min-height: 58px; max-height: 120px; resize: vertical;
  font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 6px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); }
.dsh-push-rv-error { margin: 0 14px 10px; }
.dsh-push-rv-confirm { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
  overflow: auto; min-height: 0; }
.dsh-push-rv-files { border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; }
.dsh-push-rv-files-head { display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 7px 9px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary);
  background: transparent; border: 0; text-align: left; }
.dsh-push-rv-filelist { max-height: 168px; overflow: auto; padding: 0 9px 8px; }
.dsh-push-rv-filerow { display: flex; align-items: center; gap: 8px; font-size: 11px;
  padding: 2px 0; }
.dsh-push-rv-filename { flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-rv-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-push-rv-result { padding: 12px 14px; overflow: auto; min-height: 0; }
.dsh-push-rv-summary { margin: 0 0 10px; font-size: 12px; line-height: 19px; }
.dsh-push-rv-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 8px 0; }
.dsh-push-rv-findings { display: flex; flex-direction: column; gap: 7px; }
.dsh-push-rv-finding { padding: 8px 10px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  border-left-width: 3px; }
.dsh-push-rv-sev--blocker { border-left-color: var(--dsw-alias-state-error-primary); }
.dsh-push-rv-sev--high { border-left-color: var(--dsw-alias-state-warn-primary); }
.dsh-push-rv-sev--medium { border-left-color: var(--dsw-alias-brand-primary); }
.dsh-push-rv-sev--low { border-left-color: var(--dsw-alias-border-l2); }
.dsh-push-rv-sev--info { border-left-color: var(--dsw-alias-border-l2); }
.dsh-push-rv-finding-head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.dsh-push-rv-sev { font-size: 11px; font-weight: 600; }
.dsh-push-rv-sev--blocker .dsh-push-rv-sev { color: var(--dsw-alias-state-error-primary); }
.dsh-push-rv-sev--high .dsh-push-rv-sev { color: var(--dsw-alias-state-warn-primary); }
.dsh-push-rv-finding-title { font-weight: 500; }
.dsh-push-rv-loc { margin-left: auto; font-family: ui-monospace, monospace; }
.dsh-push-rv-finding-detail { margin-top: 4px; color: var(--dsw-alias-label-secondary);
  line-height: 18px; }
.dsh-push-rv-finding-sug { margin-top: 4px; color: var(--dsw-alias-label-primary);
  line-height: 18px; }
.dsh-push-rv-effort { display: inline-flex; align-items: center; gap: 6px; }
.dsh-push-rv-slider { width: 96px; accent-color: var(--dsw-alias-brand-primary); }
.dsh-push-rv-effort-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-rv-badge { font-size: 11px; padding: 0 5px; border-radius: 5px;
  color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-state-error-primary); }
/* ── 信息密度 ─────────────────────────────────────────────────────── */
.dsh-push-density-controls { display: flex; align-items: center; gap: 10px;
  flex-wrap: wrap; padding: 2px 0 4px; }
/* 滑杆自己也要跟着缩放，否则文字变大后它显得过细；但不要继承 zoom，
   它就在被缩放的根容器里，保持原生宽度即可。 */
.dsh-push-density-slider { flex: 1 1 160px; min-width: 120px; height: 18px;
  accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.dsh-push-density-presets { display: flex; align-items: center; gap: 4px; }
.dsh-push-density-preset { font: inherit; font-size: 11px; cursor: pointer;
  padding: 3px 9px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); }
.dsh-push-density-preset:hover { color: var(--dsw-alias-label-primary); }
.dsh-push-density-preset.is-on { color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2); }
.dsh-push-density-value { font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; }
/* ── repository cards ─────────────────────────────────────────────── */
.dsh-push-viewswitch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-push-repocards { display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); align-items: stretch; }
.dsh-push-repocards--large { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
/* A DEFINITE height per size. Without it, overflow:auto on the description
   has no box to scroll within, and the card would grow instead of scrolling.
   Both sizes are fixed so a grid of cards stays on a straight line. */
.dsh-push-repocard { display: flex; flex-direction: column; min-width: 0;
  height: 196px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; overflow: hidden; }
.dsh-push-repocard--large { height: 236px; }
.dsh-push-repocard-body { display: flex; flex-direction: column; gap: 6px;
  padding: 10px 11px 8px; flex: 1 1 auto; min-height: 0; min-width: 0; }
.dsh-push-repocard--large .dsh-push-repocard-body { padding: 12px 13px 10px; gap: 8px; }
.dsh-push-repocard-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-push-repocard-name { flex: 1 1 auto; min-width: 0; text-align: left; cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 600; padding: 0; border: 0;
  background: transparent; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-repocard-name:hover { color: var(--dsw-alias-brand-primary); }
.dsh-push-repocard--large .dsh-push-repocard-name { font-size: 13px; }
/* The ONLY scrolling region in a card. 'min-height: 0' is required for a flex
   child to scroll rather than stretch its parent; 'overscroll-behavior' stops
   a scroll inside the card from scrolling the page behind it. */
.dsh-push-repocard-descscroll { flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  /* Room for the scrollbar so the text does not shift when it appears. */
  scrollbar-gutter: stable; }
.dsh-push-repocard-descscroll::-webkit-scrollbar { width: 6px; }
.dsh-push-repocard-descscroll::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2); border-radius: 3px; }
.dsh-push-repocard-desc { font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  /* Full text, wrapped: no clamp, because the box scrolls instead. */
  white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-push-repocard-meta { display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsh-push-repocard-branch { display: inline-flex; align-items: center; gap: 3px;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-push-repocard-actions { display: flex; align-items: center; gap: 6px;
  padding: 0 11px 9px; }
.dsh-push-repocard--large .dsh-push-repocard-actions { padding: 0 13px 10px; }
/* Counts: one line, fixed height, so adding them cannot change a row's
   height (the list row must keep its original metrics). */
/* Metrics live OUTSIDE the scroller: fixed height, never shrinking, so they
   sit on the same line on every card in the grid. */
.dsh-push-repocard-stats { display: flex; align-items: center; gap: 10px;
  flex: none; height: 18px; font-size: 11px;
  color: var(--dsw-alias-label-secondary); }
/* One metric: icon and number side by side. 'font-variant-numeric' keeps the
   digits from jittering as counts change width. */
.dsh-push-metric { display: inline-flex; align-items: center; gap: 3px;
  height: 18px; line-height: 18px; white-space: nowrap; }
.dsh-push-metric-n { font-variant-numeric: tabular-nums; }
/* The list row keeps the exact height it had before metrics were added, so
   nothing below it shifts. */
.dsh-push-row-stats { display: inline-flex; align-items: center; gap: 8px;
  height: 16px; line-height: 16px; font-size: 11px; flex: none;
  color: var(--dsw-alias-label-secondary); }
.dsh-push-row-stats .dsh-push-metric { height: 16px; line-height: 16px; }
/* (.dsh-push-stat belongs to the overview grid and is defined near it.) */
.dsh-push-langbar { display: flex; height: 5px; width: 100%; flex: none;
  background: var(--dsw-alias-bg-layer-2); }
.dsh-push-langbar--empty { opacity: .4; }
.dsh-push-langseg { height: 100%; }
.dsh-push-langseg--rest { background: var(--dsw-alias-border-l2); }
.dsh-push-langlegend { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-push-langlegend-item { display: inline-flex; align-items: center; gap: 3px; }
.dsh-push-langdot { width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-brand-primary); }
/* ── release assets ───────────────────────────────────────────────── */
/* Two related release fields share a row on a wide dialog and stack when
   narrow, so neither gets squeezed to an unusable width. */
.dsh-push-fieldpair { display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.dsh-push-assetdrop { display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 7px; cursor: pointer;
  border: 1px dashed var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-push-assetdrop:hover { border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); }
.dsh-push-assetlist { display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.dsh-push-assetrow { display: flex; align-items: center; gap: 6px; }
`;

    /** One <style> element in document.head; no client.css route is owned here. */
    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.dataset.dshGithubLink = '1';
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    /* ───────────────────────────── icons ────────────────────────────────── */

    /** GitHub mark (24x24 octicon/simple-icons path, filled with currentColor). */
    const GITHUB_PATH = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577'
      + ' 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7'
      + 'c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998'
      + '.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22'
      + '-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405'
      + ' 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176'
      + '.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22'
      + ' 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297'
      + 'c0-6.627-5.373-12-12-12';

    function GithubMark(props) {
      const px = (props && props.size) || 16;
      return h('svg', {
        width: px, height: px, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', { fill: 'currentColor', d: GITHUB_PATH }));
    }

    /** Stroke glyphs, drawn at the caller's size with currentColor. */
    const ICONS = {
      refresh: ['M20 11a8 8 0 1 0-2.3 6.7', 'M20 4v7h-7'],
      search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-3.6-3.6'],
      branch: ['M6 4v11', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a6 6 0 0 1-6 6H6'],
      check: ['M20 6L9 17l-5-5'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      chevron: ['M9 6l6 6-6 6'],
      gear: [
        'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
        'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
      ],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
      copy: ['M9 9h10v10H9z', 'M15 9V5H5v10h4'],
      plus: ['M12 5v14', 'M5 12h14'],
      star: ['M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z'],
      fork: ['M7 4v9a3 3 0 0 0 3 3h4', 'M7 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
      issue: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v5', 'M12 16.5h.01'],
    };

    function Icon(props) {
      const name = props && props.name;
      const size = (props && props.size) || 13;
      const paths = ICONS[name] || ICONS.chevron;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, paths.map((d, i) => h('path', { key: i, d })));
    }

    /* ────────────────────────── shared controls ─────────────────────────── */

    function Btn(props) {
      const className = 'dsh-push-btn'
        + (props.kind ? ' dsh-push-btn--' + props.kind : '')
        + (props.active ? ' dsh-push-btn--on' : '')
        + (props.mini ? ' dsh-push-btn--mini' : '');
      return h('button', {
        type: 'button',
        className,
        title: props.title || undefined,
        disabled: props.disabled || undefined,
        'aria-label': props.label || undefined,
        // Swallow the click: most of these sit inside rows that own their own
        // click behaviour (open diff / expand repo).
        onClick: (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          if (props.onClick) props.onClick(event);
        },
      }, props.children);
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label || undefined,
        title: props.title || props.label || undefined,
        className: 'dsh-push-switch',
        onClick: (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          if (props.onChange) props.onChange(!props.checked);
        },
      }, h('span', { className: 'dsh-push-switch-knob' }));
    }

    function Row(props) {
      return h('div', { className: 'dsh-push-row' },
        h('div', { className: 'dsh-push-row-label' },
          h('div', { className: 'dsh-push-row-title' }, props.title),
          props.hint ? h('div', { className: 'dsh-push-row-hint' }, props.hint) : null),
        h('div', { className: 'dsh-push-row-control' }, props.children));
    }

    /**
     * A small modal used for the global settings.
     *
     * It is rendered INSIDE the settings section's own tree (not appended to
     * document.body) so it inherits the host's theme tokens and unmounts with
     * the section; `position: fixed` still lifts it above the page. Escape and
     * a backdrop click both close it, and the open/close is pure local state —
     * the host's settings shell keeps owning its own navigation.
     */
    function Modal(props) {
      const onClose = props.onClose;
      useEffect(() => {
        if (!props.open) return undefined;
        const onKey = (event) => {
          if (event && event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [props.open, onClose]);
      if (!props.open) return null;
      return h('div', {
        className: 'dsh-push-overlay',
        // Close only when the backdrop itself is clicked; a click that started
        // inside the dialog must not dismiss it.
        onMouseDown: (event) => {
          if (event && event.target === event.currentTarget) onClose();
        },
      },
        h('div', {
          className: 'dsh-push-modal' + (props.wide ? ' dsh-push-modal--wide' : '')
            + (props.bare ? ' dsh-push-modal--bare' : ''),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title,
        },
          // `bare` lets a dialog own its header (title plus controls the shell
          // does not know about, such as the review settings gear). Rendering
          // the shell header as well would show two title bars.
          props.bare
            ? null
            : h('div', { className: 'dsh-push-modal-head' },
              h('span', { className: 'dsh-push-modal-title' }, props.title),
              // Optional second head slot: the management dialog shows the
              // repository identity and description beside its title.
              props.subhead || null,
              h('button', {
                type: 'button',
                className: 'dsh-push-iconbtn',
                title: t('close'),
                'aria-label': t('close'),
                onClick: onClose,
              }, h(Icon, { name: 'close', size: 13 }))),
          props.tabs || null,
          h('div', { className: 'dsh-push-modal-body' }, props.children),
          props.footer ? h('div', { className: 'dsh-push-modal-foot' }, props.footer) : null));
    }

    /**
     * A two-option segmented control.
     *
     * `options` is `[{ value, label, count? }]`; `count` renders a muted
     * tally so the user can see how the repos split without opening each tab.
     */
    function Segmented(props) {
      const value = props.value;
      return h('div', { className: 'dsh-push-seg', role: 'tablist' },
        (props.options || []).map((option) => h('button', {
          key: String(option.value),
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === value ? 'true' : 'false',
          className: 'dsh-push-seg-btn' + (option.value === value ? ' is-on' : ''),
          onClick: () => props.onChange(option.value),
        },
          h('span', null, option.label),
          typeof option.count === 'number'
            ? h('span', { className: 'dsh-push-seg-count' }, String(option.count))
            : null)));
    }

    function Avatar(props) {
      const px = props.size || 24;
      if (props.url) {
        return h('img', {
          className: 'dsh-push-avatar', src: props.url, width: px, height: px,
          alt: props.login || '', referrerPolicy: 'no-referrer',
        });
      }
      return h('span', {
        className: 'dsh-push-avatar dsh-push-avatar--letter',
        style: { width: px + 'px', height: px + 'px' },
        'aria-hidden': 'true',
      }, String(props.login || '?').slice(0, 1).toUpperCase());
    }

    /* ───────────────────── push target picker (CONTRACT §3b) ────────────── */

    /**
     * How long the picker waits after the last keystroke before asking
     * `/push/remotes?q=` for the full result set.
     *
     * The local filter already narrows the prefetched page on every keystroke,
     * so this delay is invisible while typing quickly and still gives the user
     * the complete repository list a moment later. GitHub's search endpoint is
     * rate-limited much more tightly than the plain REST list, which is why the
     * query is not fired per character.
     */
    const PICKER_DEBOUNCE_MS = 300;

    /** Does one `/push/remotes` row match the typed term? */
    function pickerMatches(item, term) {
      const needle = String(term || '').toLowerCase();
      if (!needle) return true;
      const fullName = String(item.fullName || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      return fullName.indexOf(needle) !== -1 || name.indexOf(needle) !== -1;
    }

    /**
     * Pick the destination of a push (CONTRACT §3b), both ways the user asked
     * for: browse the dropdown, or type to search GitHub.
     *
     * `value` is either `{ remote }` (a git remote that already exists) or
     * `{ target: { owner, repo } }` (a GitHub repository, which the host pushes
     * to by URL without touching `.git/config`). Those are exactly the two
     * shapes `/local/push` accepts, so the form can submit the selection
     * unchanged.
     */
    function RepoPicker(props) {
      const ctx = props.ctx;
      const remotes = props.remotes || [];
      const value = props.value || null;

      const [open, setOpen] = useState(false);
      const [term, setTerm] = useState('');
      const [prefetch, setPrefetch] = useState([]);
      const [results, setResults] = useState([]);
      const [resultTerm, setResultTerm] = useState('');
      const [searching, setSearching] = useState(false);
      const [githubError, setGithubError] = useState('');
      const [high, setHigh] = useState(0);

      const aliveRef = useRef(true);
      /** Monotonic ticket: only the newest search may write its result. */
      const requestRef = useRef(0);
      const timerRef = useRef(null);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = null;
          // Invalidate whatever is still in flight so it cannot set state on
          // an unmounted component.
          requestRef.current += 1;
        };
      }, []);

      // Prefetch one page for browsing. Failing here is expected when no
      // account is signed in yet: the local remotes still work, so this is a
      // muted line in the dropdown rather than an error banner.
      useEffect(() => {
        let live = true;
        (async () => {
          try {
            const data = await api(ctx, API + '/push/remotes?page=1');
            if (!live || !aliveRef.current) return;
            setPrefetch((data && data.items) || []);
            setGithubError('');
          } catch (err) {
            if (!live || !aliveRef.current) return;
            setPrefetch([]);
            setGithubError(err.message);
          }
        })();
        return () => { live = false; };
      }, [ctx]);

      // Debounced GitHub search. Clearing the previous timer on every keystroke
      // is what makes it a debounce; the ticket makes a slow answer for an
      // older term unable to overwrite a newer one.
      useEffect(() => {
        if (!open) return undefined;
        const needle = term.trim();
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (!needle) {
          requestRef.current += 1;
          setSearching(false);
          setResults([]);
          setResultTerm('');
          return undefined;
        }
        setSearching(true);
        timerRef.current = setTimeout(async () => {
          timerRef.current = null;
          requestRef.current += 1;
          const ticket = requestRef.current;
          try {
            const data = await api(ctx, API + '/push/remotes?q=' + encodeURIComponent(needle) + '&page=1');
            if (!aliveRef.current || ticket !== requestRef.current) return;
            setResults((data && data.items) || []);
            setResultTerm(needle);
            setGithubError('');
          } catch (err) {
            if (!aliveRef.current || ticket !== requestRef.current) return;
            setResults([]);
            setResultTerm(needle);
            setGithubError(err.message);
          } finally {
            if (aliveRef.current && ticket === requestRef.current) setSearching(false);
          }
        }, PICKER_DEBOUNCE_MS);
        return () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, [open, term, ctx]);

      const needle = term.trim();
      const lower = needle.toLowerCase();
      // While the debounced answer is pending (or its term is behind), the
      // prefetched page is filtered locally, so typing always reacts at once.
      const githubItems = needle
        ? (resultTerm === needle ? results : prefetch.filter((item) => pickerMatches(item, needle)))
        : prefetch;
      const localRows = needle
        ? remotes.filter((row) => (
          String(row.name || '').toLowerCase().indexOf(lower) !== -1
          || String(row.url || '').toLowerCase().indexOf(lower) !== -1
        ))
        : remotes;

      /* One flat list of selectable rows, so ArrowUp/Down and Enter only ever
         deal with indices and the group headings stay purely visual. */
      const options = [];
      for (const row of localRows) {
        options.push({
          key: 'local:' + row.name,
          kind: 'local',
          name: row.name,
          detail: row.owner && row.repo ? row.owner + '/' + row.repo : (row.url || ''),
          value: { remote: row.name },
        });
      }
      for (const item of githubItems) {
        options.push({
          key: 'github:' + item.fullName,
          kind: 'github',
          name: item.fullName,
          detail: item.defaultBranch || '',
          isPrivate: item.private === true,
          value: { target: { owner: item.owner, repo: item.name } },
        });
      }
      const active = options.length === 0 ? -1 : Math.max(0, Math.min(high, options.length - 1));

      const choose = (option) => {
        if (!option) return;
        if (props.onChange) props.onChange(option.value);
        setOpen(false);
        setTerm('');
        setHigh(0);
      };

      const close = () => {
        setOpen(false);
        setTerm('');
        setHigh(0);
      };

      const onKeyDown = (event) => {
        if (!event) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setHigh(options.length === 0 ? 0 : (active + 1) % options.length);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setHigh(options.length === 0 ? 0 : (active <= 0 ? options.length - 1 : active - 1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          choose(options[active]);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      };

      /* ── current selection, resolved to `owner/name` where that is known ── */
      let current = null;
      let kindLabel = t('pickerSelectedGithub');
      if (value && value.target) {
        const owner = String(value.target.owner || '');
        const repo = String(value.target.repo || '');
        const hit = prefetch.concat(results).find((item) => (
          item.owner === owner && item.name === repo
        ));
        current = {
          name: owner + '/' + repo,
          isPrivate: hit ? hit.private === true : null,
        };
      } else if (value && value.remote) {
        const row = remotes.find((item) => item.name === value.remote);
        const owner = row && row.owner ? String(row.owner) : '';
        const repo = row && row.repo ? String(row.repo) : '';
        kindLabel = t('pickerSelectedLocal');
        current = {
          name: owner && repo ? owner + '/' + repo : String(value.remote),
          isPrivate: null,
        };
      }

      let pillText = kindLabel;
      let pillClass = 'dsh-push-pill';
      if (current && current.isPrivate !== null) {
        pillText = current.isPrivate ? t('pickerPrivate') : t('pickerPublic');
      }
      if (current && current.isPrivate === true) pillClass += ' dsh-push-pill--warn';

      const renderRow = (option) => h('button', {
        key: option.key,
        type: 'button',
        role: 'option',
        'aria-selected': options[active] === option ? 'true' : 'false',
        className: 'dsh-push-picker-row' + (options[active] === option ? ' is-active' : ''),
        title: option.detail || option.name,
        onMouseEnter: () => setHigh(options.indexOf(option)),
        onClick: () => choose(option),
      },
        option.kind === 'local'
          ? h(Icon, { name: 'branch', size: 11 })
          : h(GithubMark, { size: 11 }),
        h('span', { className: 'dsh-push-picker-row-name' }, option.name),
        option.kind === 'local' && option.detail
          ? h('span', { className: 'dsh-push-hint' }, option.detail)
          : null,
        option.kind === 'github'
          ? h('span', { className: 'dsh-push-pill' },
            option.isPrivate ? t('pickerPrivate') : t('pickerPublic'))
          : null);

      const listRows = [];
      if (localRows.length > 0) {
        listRows.push(h('div', {
          className: 'dsh-push-picker-group',
          key: 'group-local',
        }, t('pickerLocalGroup')));
        for (const option of options) {
          if (option.kind === 'local') listRows.push(renderRow(option));
        }
      }
      if (githubItems.length > 0) {
        listRows.push(h('div', {
          className: 'dsh-push-picker-group',
          key: 'group-github',
        }, t('pickerGithubGroup')));
        for (const option of options) {
          if (option.kind === 'github') listRows.push(renderRow(option));
        }
      }
      if (options.length === 0) {
        // Both sources can be empty at once (a repository with no remotes and
        // no signed-in account), so the hint names whichever is missing
        // instead of claiming a search found nothing.
        if (needle) {
          listRows.push(h('div', { className: 'dsh-push-picker-empty', key: 'empty' },
            t('pickerNoMatch')));
        } else {
          if (remotes.length === 0) {
            listRows.push(h('div', { className: 'dsh-push-picker-empty', key: 'empty-local' },
              t('pickerNoLocal')));
          }
          listRows.push(h('div', { className: 'dsh-push-picker-empty', key: 'empty-github' },
            githubError || t('pickerNoGithub')));
        }
      }
      if (searching) {
        listRows.push(h('div', {
          className: 'dsh-push-picker-empty dsh-push-inline',
          key: 'searching',
        },
          h('span', { className: 'dsh-push-spin', 'aria-hidden': 'true' }),
          h('span', null, t('pickerSearching'))));
      }

      return h('div', { className: 'dsh-push-picker' },
        open
          ? h('div', { className: 'dsh-push-picker-box' },
            h(Icon, { name: 'search', size: 12 }),
            h('input', {
              type: 'text',
              value: term,
              placeholder: t('pickerSearchPlaceholder'),
              autoFocus: true,
              spellCheck: false,
              disabled: props.disabled || undefined,
              'aria-label': t('pickerTarget'),
              onChange: (event) => {
                setTerm(event.target.value);
                setHigh(0);
              },
              onKeyDown: onKeyDown,
            }),
            searching ? h('span', { className: 'dsh-push-spin', 'aria-hidden': 'true' }) : null,
            h('button', {
              type: 'button',
              className: 'dsh-push-iconbtn',
              title: t('close'),
              'aria-label': t('close'),
              onClick: close,
            }, h(Icon, { name: 'close', size: 11 })))
          : h('div', {
            className: 'dsh-push-picker-box',
            role: 'button',
            tabIndex: 0,
            'aria-label': t('pickerTarget'),
            'aria-expanded': 'false',
            onClick: () => {
              if (props.disabled) return;
              setOpen(true);
              setHigh(0);
            },
            onKeyDown: (event) => {
              if (!event) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (!props.disabled) {
                  setOpen(true);
                  setHigh(0);
                }
              }
            },
          },
            h('span', { className: 'dsh-push-picker-selected' },
              current
                ? h('span', {
                  className: 'dsh-push-picker-name dsh-push-mono',
                  title: current.name,
                }, current.name)
                : h('span', { className: 'dsh-push-hint' }, t('pickerPlaceholder')),
              current ? h('span', { className: pillClass }, pillText) : null),
            h('span', { className: 'dsh-push-page-spacer' }),
            current
              ? h('button', {
                type: 'button',
                className: 'dsh-push-iconbtn',
                title: t('pickerClear'),
                'aria-label': t('pickerClear'),
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                  if (props.onChange) props.onChange(null);
                },
              }, h(Icon, { name: 'close', size: 11 }))
              : null,
            h(Icon, { name: 'chevron', size: 12 })),
        open
          ? h('div', { className: 'dsh-push-picker-list', role: 'listbox' }, listRows)
          : null);
    }

    /* ───────── repo management dialog (CONTRACT §3c) ───────── */

    /** Compact byte label for `stats.sizeKb`. */
    function sizeLabel(sizeKb) {
      const kb = Number(sizeKb) || 0;
      if (kb >= 1024) return t('sizeMb', { n: (kb / 1024).toFixed(1) });
      return t('sizeKb', { n: kb });
    }

    /** `YYYY-MM-DD` for a timestamp, or the muted dash when it is missing. */
    function dayLabel(ts) {
      if (!ts) return t('manageNoValue');
      const stamp = new Date(ts).getTime();
      if (!Number.isFinite(stamp)) return t('manageNoValue');
      const date = new Date(stamp);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return date.getFullYear() + '-' + month + '-' + day;
    }

    /** One `label → value` line of the overview/settings tables. */
    function KVRow(props) {
      return h('div', { className: 'dsh-push-kvrow' },
        h('span', null, props.label),
        h('span', { title: props.title || String(props.value || '') },
          props.children || String(props.value === undefined || props.value === null
            ? t('manageNoValue')
            : props.value)));
    }

    /** Inline tab row for the dialog (the settings page owns its own Segmented). */
    function TabRow(props) {
      return h('div', { className: 'dsh-push-manage-tabs', role: 'tablist' },
        (props.options || []).map((option) => h('button', {
          key: String(option.value),
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === props.value ? 'true' : 'false',
          className: 'dsh-push-tabs-btn' + (option.value === props.value ? ' is-on' : ''),
          onClick: () => props.onChange(option.value),
        }, option.label)));
    }

    /** Skeleton rows while `/repos/manage` is in flight. */
    function ManageSkeleton() {
      return h('div', { className: 'dsh-push-skel', 'aria-hidden': 'true' },
        CONTRIB_SKELETON.map((row) => h('div', {
          key: row,
          className: 'dsh-push-skel-row',
          style: { width: row % 2 === 0 ? '100%' : '62%' },
        })));
    }

    /** Muted block for `warnings[]` — never an error colour, never an alert. */
    function WarnBlock(props) {
      const list = props.warnings || [];
      if (!Array.isArray(list) || list.length === 0) return null;
      return h('div', { className: 'dsh-push-warnbox' },
        h('div', null, props.title || t('manageWarnings')),
        list.map((line, index) => h('div', { key: index }, String(line))));
    }

    /**
     * The repository management dialog: one surface per AG-Grid of CONTRACT §3c
     * tabs (概览 / 分支 / 设置 / 发布 / 协作者 / Webhook), all fed by a single
     * `GET /repos/manage` read.
     *
     * Two invariants hold the whole component together:
     *
     *   1. `null` is DATA, not an error. `collaborators`, `webhooks` and
     *      `releases` come back `null` when the token cannot read them, and the
     *      matching sentence is in `warnings[]`; the tab then renders that
     *      sentence in muted text instead of an error.
     *   2. EVERY mutation re-reads `/repos/manage` and then asks the parent to
     *      refresh its own list (`onChanged`). Nothing is patched locally, so a
     *      dialog can never disagree with the list behind it.
     */
    function RepoManageModal(props) {
      const ctx = props.ctx;
      const repo = props.repo;
      const owner = (repo && repo.owner) || '';
      const name = (repo && repo.name) || '';
      const open = Boolean(props.open && repo);

      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [tab, setTab] = useState('overview');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');

      const [actionError, setActionError] = useState('');

      // §设置 draft
      const [draft, setDraft] = useState({
        description: '', homepage: '', isPrivate: false, archived: false, defaultBranch: '',
      });
      // §概览 topic editor
      const [topicInput, setTopicInput] = useState('');
      // §分支 inline state
      const [renameFor, setRenameFor] = useState('');
      const [renameValue, setRenameValue] = useState('');
      const [branchArm, setBranchArm] = useState('');
      // §设置 dangerous-zone confirmations
      const [dangerKind, setDangerKind] = useState('');
      const [dangerValue, setDangerValue] = useState('');
      const [dangerConfirm, setDangerConfirm] = useState('');
      // §发布 editor
      const [releaseDraft, setReleaseDraft] = useState(null);
      const [releaseArm, setReleaseArm] = useState('');

      // Asset upload state: one upload at a time is enough, and the notice is
      // the only feedback the user gets that a file actually landed.
      const [assetBusy, setAssetBusy] = useState(false);
      const [actionNotice, setActionNotice] = useState('');

      // §协作者 add row
      const [collabUser, setCollabUser] = useState('');
      const [collabPerm, setCollabPerm] = useState('push');
      const [collabArm, setCollabArm] = useState('');

      const aliveRef = useRef(true);
      const seededRef = useRef('');
      const reqRef = useRef(0);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      useEffect(() => {
        if (!notice) return undefined;
        const id = setTimeout(() => { if (aliveRef.current) setNotice(''); }, TOAST_MS);
        return () => clearTimeout(id);
      }, [notice]);

      const load = useCallback(async () => {
        if (!owner || !name) return;
        reqRef.current += 1;
        const ticket = reqRef.current;
        setLoading(true);
        setError('');
        try {
          const params = new URLSearchParams();
          params.set('owner', owner);
          params.set('name', name);
          const next = await api(ctx, API + '/repos/manage?' + params.toString());
          if (!aliveRef.current || ticket !== reqRef.current) return;
          setData(next || null);
        } catch (err) {
          if (!aliveRef.current || ticket !== reqRef.current) return;
          setData(null);
          setError(err.message);
        } finally {
          if (aliveRef.current && ticket === reqRef.current) setLoading(false);
        }
      }, [ctx, owner, name]);

      useEffect(() => {
        if (!open) return undefined;
        // Every newly-opened repository starts on the overview with a clean
        // editor: a stale draft from the previous dialog must never leak in.
        setTab('overview');
        setNotice('');
        setActionError('');
        setRenameFor('');
        setBranchArm('');
        setDangerKind('');
        setDangerValue('');
        setDangerConfirm('');
        setReleaseDraft(null);
        setReleaseArm('');
        setTopicInput('');
        setCollabUser('');
        setCollabArm('');
        seededRef.current = '';
        setData(null);
        load();
        return undefined;
      }, [open, owner, name, load]);

      // Seed the editable draft once per repository; a later refresh after an
      // unrelated mutation must not discard what is being typed.
      useEffect(() => {
        if (!data || !data.repo) return;
        const key = String(data.repo.fullName || (owner + '/' + name));
        if (seededRef.current === key) return;
        seededRef.current = key;
        setDraft({
          description: data.repo.description || '',
          homepage: data.repo.homepage !== undefined && data.repo.homepage !== null
            ? String(data.repo.homepage)
            : '',
          isPrivate: data.repo.private === true,
          archived: data.repo.archived === true,
          defaultBranch: data.repo.defaultBranch || '',
        });
      }, [data, owner, name]);

      /**
       * Run one mutation, then re-read and refresh the parent list.
       *
       * `detach` is for the two operations that change the repository's own
       * identity (rename, transfer): re-reading `/repos/manage` afterwards would
       * ask for the OLD `owner/name` and 404, so the dialog hands the result to
       * the parent (which re-lists) and closes itself instead. `close` alone
       * means "the repository is gone" and runs the caller's `onDeleted`.
       */
      const mutate = useCallback(async (path, body, options) => {
        const opts = options || {};
        setBusy(true);
        setActionError('');
        try {
          const result = await api(ctx, API + path, { method: 'POST', body });
          if (!aliveRef.current) return null;
          setNotice(opts.label ? t('tabDone', { label: opts.label }) : '');
          if (opts.close) {
            if (props.onDeleted) props.onDeleted();
            return result;
          }
          if (opts.detach) {
            if (props.onChanged) props.onChanged();
            if (props.onClose) props.onClose();
            return result;
          }
          await load();
          if (props.onChanged) props.onChanged();
          return result;
        } catch (err) {
          if (aliveRef.current) setActionError(err.message);
          return null;
        } finally {
          if (aliveRef.current) setBusy(false);
        }
      }, [ctx, load, props]);

      if (!open) return null;

      const stats = (data && data.stats) || null;
      const repoData = (data && data.repo) || null;
      const warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];
      const topics = (data && Array.isArray(data.topics)) ? data.topics : [];
      const branches = (data && Array.isArray(data.branches)) ? data.branches : null;
      const releases = (data && Array.isArray(data.releases)) ? data.releases : null;
      const collaborators = data && Array.isArray(data.collaborators) ? data.collaborators : null;
      const webhooks = data && Array.isArray(data.webhooks) ? data.webhooks : null;
      const can = (data && data.can) || { admin: false, push: false, delete: false };
      const defaultBranch = (repoData && repoData.defaultBranch) || draft.defaultBranch || '';

      const warningLines = warnings;

      /* ── mutations ── */

      const addTopic = async () => {
        const value = topicInput.trim().toLowerCase();
        if (!value) return;
        if (topics.indexOf(value) !== -1) { setTopicInput(''); return; }
        const next = topics.concat([value]);
        setTopicInput('');
        await mutate('/repos/update', { owner, name, topics: next }, { label: t('manageTopics') });
      };

      const removeTopic = async (topic) => {
        const next = topics.filter((row) => row !== topic);
        await mutate('/repos/update', { owner, name, topics: next }, { label: t('manageTopics') });
      };

      const saveSettings = async () => {
        const body = {
          owner,
          name,
          description: draft.description,
          homepage: draft.homepage,
          private: draft.isPrivate,
          archived: draft.archived,
        };
        if (draft.defaultBranch) body.defaultBranch = draft.defaultBranch;
        const result = await mutate('/repos/update', body, { label: t('saveSettings') });
        if (result && aliveRef.current) setNotice(t('manageSettingsSaved'));
      };

      const setDefaultBranch = async (branch) => {
        await mutate('/repos/update', { owner, name, defaultBranch: branch }, { label: t('branchSetDefault') });
      };

      const toggleProtect = async (branch) => {
        await mutate('/repos/branch/protect', {
          owner,
          name,
          branch: branch.name,
          protected: !branch.protected,
        }, { label: branch.protected ? t('branchUnprotect') : t('branchProtect') });
      };

      const applyRename = async (branch) => {
        const to = renameValue.trim();
        if (!to) { setActionError(t('branchNameRequired')); return; }
        const result = await mutate('/repos/branch/rename', {
          owner,
          name,
          from: branch.name,
          to,
        }, { label: t('branchRename') });
        if (result && aliveRef.current) {
          setRenameFor('');
          setRenameValue('');
        }
      };

      const deleteBranch = async (branch) => {
        if (branchArm !== branch.name) {
          setBranchArm(branch.name);
          return;
        }
        setBranchArm('');
        await mutate('/repos/branch/delete', {
          owner,
          name,
          branch: branch.name,
        }, { label: t('branchDelete') });
      };

      const runDanger = async () => {
        // The typed `owner/name` is the acknowledgement: it must equal the
        // CURRENT identity exactly, and `confirm: true` is what the host checks.
        const expected = owner + '/' + name;
        if (dangerValue.trim() !== expected) {
          setActionError(t('confirmNameMismatch', { name: expected }));
          return;
        }
        if (dangerKind === 'rename') {
          const newName = dangerConfirm.trim();
          if (!newName) {
            setActionError(t('fieldRequired'));
            return;
          }
          await mutate('/repos/rename', {
            owner, name, newName, confirm: true,
          }, { label: t('dangerRename'), detach: true });
          return;
        }
        if (dangerKind === 'transfer') {
          const newOwner = dangerConfirm.trim();
          if (!newOwner) {
            setActionError(t('fieldRequired'));
            return;
          }
          await mutate('/repos/transfer', {
            owner, name, newOwner, confirm: true,
          }, { label: t('dangerTransfer'), detach: true });
          return;
        }
        if (dangerKind === 'delete') {
          await mutate('/repos/delete', {
            owner,
            name,
            // The host's `/repos/delete` predates §3c's confirm convention, but
            // sending it is harmless and keeps the three dangerous actions
            // shaped the same way.
            confirm: true,
          }, { label: t('dangerDelete'), close: true });
        }
      };

      const saveRelease = async () => {
        if (!releaseDraft) return;
        if (releaseDraft.id) {
          await mutate('/repos/release/update', {
            owner,
            // `name` is the REPOSITORY name and `releaseName` is the release
            // title. They used to share the key `name`, and the duplicate
            // silently replaced the repo name, so every save 404ed.
            name,
            id: releaseDraft.id,
            releaseName: releaseDraft.name,
            body: releaseDraft.body,
            draft: releaseDraft.draft,
            prerelease: releaseDraft.prerelease,
          }, { label: t('releaseSave') });
          if (aliveRef.current) setReleaseDraft(null);
          return;
        }
        const tagName = String(releaseDraft.tagName || '').trim();
        if (!tagName) { setActionError(t('releaseTagRequired')); return; }
        const result = await mutate('/releases', {
          owner,
          repo: name,
          tagName,
          name: releaseDraft.name || undefined,
          body: releaseDraft.body || undefined,
          // Which commit the tag points at. Without this GitHub silently uses
          // the default branch tip, which is rarely what "release this version"
          // means — the user picks the branch/tag/sha here instead.
          target: String(releaseDraft.target || '').trim() || undefined,
          draft: releaseDraft.draft,
          prerelease: releaseDraft.prerelease,
        }, { label: t('releaseNew') });
        if (result && aliveRef.current) {
          setReleaseDraft(null);
          await load();
        }
      };

      /**
       * Attach one file to a release.
       *
       * The browser sends base64 because the plugin's transport is JSON; the
       * Host turns it back into bytes and posts them to GitHub's uploads host.
       * A release with no assets is the "I published something and nobody can
       * download it" case, which is why this exists at all.
       *
       * @param {string|number} releaseId
       * @param {File} file
       */
      const uploadAsset = async (releaseId, file) => {
        if (!file) return;
        if (file.size > 200 * 1024 * 1024) {
          setActionError(t('assetTooLarge'));
          return;
        }
        setAssetBusy(true);
        setActionError('');
        try {
          const buffer = await file.arrayBuffer();
          // Chunked base64 avoids blowing the argument limit on large files.
          let binary = '';
          const bytes = new Uint8Array(buffer);
          const CHUNK = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
          }
          await api(ctx, API + '/releases/asset', {
            method: 'POST',
            body: {
              owner,
              name,
              releaseId: String(releaseId),
              fileName: file.name,
              contentType: file.type || 'application/octet-stream',
              base64: btoa(binary),
            },
          });
          if (!aliveRef.current) return;
          setActionNotice(t('assetUploaded'));
          await load();
        } catch (error) {
          if (aliveRef.current) setActionError(error.message);
        } finally {
          if (aliveRef.current) setAssetBusy(false);
        }
      };

      /**
       * Remove one uploaded asset.
       *
       * A mis-uploaded file is the common mistake; deleting the whole
       * release to fix it would take every other asset with it.
       *
       * @param {string|number} releaseId
       * @param {string|number} assetId
       */
      const removeAsset = async (releaseId, assetId) => {
        setAssetBusy(true);
        setActionError('');
        try {
          await api(ctx, API + '/releases/asset/delete', {
            method: 'POST',
            body: { owner, name, releaseId: String(releaseId), assetId: String(assetId) },
          });
          if (!aliveRef.current) return;
          setActionNotice(t('assetDelete'));
          await load();
        } catch (error) {
          if (aliveRef.current) setActionError(error.message);
        } finally {
          if (aliveRef.current) setAssetBusy(false);
        }
      };

      const deleteRelease = async (release) => {
        if (releaseArm !== release.id) {
          setReleaseArm(release.id);
          return;
        }
        setReleaseArm('');
        await mutate('/repos/release/delete', {
          owner,
          name,
          id: release.id,
        }, { label: t('releaseDelete') });
      };

      const addCollaborator = async () => {
        const user = collabUser.trim();
        if (!user) return;
        const result = await mutate('/repos/collaborator/add', {
          owner,
          name,
          user,
          permission: collabPerm,
        }, { label: t('collaboratorsAdd') });
        if (result && aliveRef.current) setCollabUser('');
      };

      const removeCollaborator = async (row) => {
        if (collabArm !== row.login) {
          setCollabArm(row.login);
          return;
        }
        setCollabArm('');
        await mutate('/repos/collaborator/remove', {
          owner,
          name,
          user: row.login,
        }, { label: t('collaboratorsRemove') });
      };

      /* ── tab bodies ── */

      const tabs = [
        { value: 'overview', label: t('tabOverview') },
        { value: 'branches', label: t('tabBranches') },
        { value: 'settings', label: t('tabSettings') },
        { value: 'releases', label: t('tabReleases') },
        { value: 'collaborators', label: t('tabCollaborators') },
        { value: 'webhooks', label: t('tabWebhooks') },
      ];

      let body = null;

      if (loading && !data) {
        body = h(ManageSkeleton);
      } else if (error) {
        body = h('div', { className: 'dsh-push-error' }, error);
      } else if (!data) {
        body = h('div', { className: 'dsh-push-hint' }, t('manageLoading'));
      } else if (tab === 'overview') {
        body = h('div', { className: 'dsh-push-block' },
          data.stats
            ? h('div', { className: 'dsh-push-stats' },
              h('div', { className: 'dsh-push-stat' },
                h('span', { className: 'dsh-push-stat-k' }, t('statStars')),
                h('span', { className: 'dsh-push-stat-v' }, String(stats.stars || 0))),
              h('div', { className: 'dsh-push-stat' },
                h('span', { className: 'dsh-push-stat-k' }, t('statForks')),
                h('span', { className: 'dsh-push-stat-v' }, String(stats.forks || 0))),
              h('div', { className: 'dsh-push-stat' },
                h('span', { className: 'dsh-push-stat-k' }, t('statWatchers')),
                h('span', { className: 'dsh-push-stat-v' }, String(stats.watchers || 0))),
              h('div', { className: 'dsh-push-stat' },
                h('span', { className: 'dsh-push-stat-k' }, t('statIssues')),
                h('span', { className: 'dsh-push-stat-v' }, String(stats.openIssues || 0))),
              h('div', { className: 'dsh-push-stat' },
                h('span', { className: 'dsh-push-stat-k' }, t('statPRs')),
                h('span', { className: 'dsh-push-stat-v' }, String(stats.openPRs || 0))),
              h('div', { className: 'dsh-push-stat' },
                h('span', { className: 'dsh-push-stat-k' }, t('statSize')),
                h('span', { className: 'dsh-push-stat-v' }, sizeLabel(stats.sizeKb))))
            : null,

          h('div', { className: 'dsh-push-subhead' }, t('manageTopics')),
          h('div', { className: 'dsh-push-chips' },
            topics.length === 0
              ? h('span', { className: 'dsh-push-hint' }, t('manageTopicsEmpty'))
              : topics.map((topic) => h('span', { className: 'dsh-push-chip', key: topic },
                h('span', null, topic),
                h('button', {
                  type: 'button',
                  title: t('topicRemove'),
                  'aria-label': t('topicRemove'),
                  disabled: busy || undefined,
                  onClick: () => removeTopic(topic),
                }, h(Icon, { name: 'close', size: 9 }))))),
          h('div', { className: 'dsh-push-inline' },
            h('input', {
              className: 'dsh-push-input',
              type: 'text',
              value: topicInput,
              placeholder: t('topicPlaceholder'),
              spellCheck: false,
              style: { flex: '1 1 160px', width: 'auto' },
              onChange: (e) => setTopicInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') addTopic(); },
            }),
            h(Btn, { mini: true, disabled: busy || !topicInput.trim(), onClick: addTopic },
              t('topicAdd'))),

          h('div', { className: 'dsh-push-rows' },
            h(KVRow, { label: t('statLanguage'), value: stats ? (stats.language || t('manageNoValue')) : t('manageNoValue') }),
            h(KVRow, { label: t('statLicense'), value: stats ? (stats.license || t('manageNoValue')) : t('manageNoValue') }),
            h(KVRow, { label: t('statCreated'), value: dayLabel(stats && stats.createdAt) }),
            h(KVRow, { label: t('statUpdated'), value: dayLabel(stats && stats.updatedAt) }),
            h(KVRow, { label: t('statPushed'), value: dayLabel(stats && stats.pushedAt) }),
            h(KVRow, { label: t('fieldDefaultBranch'), value: defaultBranch || t('manageNoValue') })),

          h('div', { className: 'dsh-push-subhead' }, t('manageHomepage')),
          // `RemoteRepo` carries no `homepage` field (CONTRACT §2), and
          // `/repos/manage` returns the same shape, so the only homepage the
          // overview can show is the one OTHERS set: it is read from the
          // settings draft once the dialog has one typed in.
          draft.homepage
            ? h('a', {
              className: 'dsh-push-link',
              href: /^https?:\/\//i.test(draft.homepage) ? draft.homepage : 'https://' + draft.homepage,
              target: '_blank',
              rel: 'noreferrer',
            }, draft.homepage)
            : h('div', { className: 'dsh-push-hint' }, t('manageNoHomepage')),

          h(WarnBlock, { warnings: warningLines }));
      } else if (tab === 'branches') {
        body = h('div', { className: 'dsh-push-block' },
          branches === null
            ? h('div', { className: 'dsh-push-hint' }, t('fieldNullWarning'))
            : branches.length === 0
              ? h('div', { className: 'dsh-push-hint' }, t('manageBranchesEmpty'))
              : branches.map((branch) => {
                const isDefault = branch.name === defaultBranch;
                const arming = branchArm === branch.name;
                const renaming = renameFor === branch.name;
                return h('div', { className: 'dsh-push-branch', key: branch.name },
                  h('span', { className: 'dsh-push-branch-name' },
                    h(Icon, { name: 'branch', size: 11 }),
                    h('span', { className: 'dsh-push-mono', title: branch.sha || branch.name },
                      branch.name),
                    isDefault
                      ? h('span', { className: 'dsh-push-pill dsh-push-pill--active' },
                        t('branchDefault'))
                      : null,
                    branch.protected
                      ? h('span', { className: 'dsh-push-pill dsh-push-pill--ok' },
                        t('branchProtected'))
                      : null),
                  renaming
                    ? h('div', { className: 'dsh-push-branch-actions' },
                      h('input', {
                        className: 'dsh-push-input',
                        type: 'text',
                        value: renameValue,
                        autoFocus: true,
                        spellCheck: false,
                        style: { width: '120px' },
                        onChange: (e) => setRenameValue(e.target.value),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter') applyRename(branch);
                          if (e.key === 'Escape') { setRenameFor(''); setRenameValue(''); }
                        },
                      }),
                      h(Btn, { mini: true, kind: 'primary', disabled: busy, onClick: () => applyRename(branch) },
                        t('branchRenameApply')),
                      h(Btn, { mini: true, onClick: () => { setRenameFor(''); setRenameValue(''); } },
                        t('cancel')))
                    : h('div', { className: 'dsh-push-branch-actions' },
                      isDefault
                        ? null
                        : h(Btn, {
                          mini: true,
                          disabled: busy || !can.admin,
                          title: can.admin ? t('branchSetDefault') : t('fieldNullWarning'),
                          onClick: () => setDefaultBranch(branch.name),
                        }, t('branchSetDefault')),
                      h(Btn, {
                        mini: true,
                        disabled: busy || !can.admin,
                        onClick: () => toggleProtect(branch),
                      }, branch.protected ? t('branchUnprotect') : t('branchProtect')),
                      h(Btn, {
                        mini: true,
                        disabled: busy,
                        onClick: () => {
                          setRenameFor(branch.name);
                          setRenameValue(branch.name);
                          setActionError('');
                        },
                      }, t('branchRename')),
                      h(Btn, {
                        mini: true,
                        kind: 'danger',
                        disabled: busy || isDefault,
                        title: isDefault ? t('branchDefaultProtected') : t('branchDelete'),
                        onClick: () => deleteBranch(branch),
                      }, arming ? t('branchDeleteConfirm') : t('branchDelete'))));
              }),
          branches && branches.length > 0 && branchArm
            ? h('div', { className: 'dsh-push-dangerbox' },
              h('div', { className: 'dsh-push-error' }, t('branchDeleteWarn')))
            : null,
          h(WarnBlock, { warnings: warningLines }));
      } else if (tab === 'settings') {
        const dangerReady = dangerValue.trim() === (owner + '/' + name);
        body = h('div', { className: 'dsh-push-block' },
          h('label', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('fieldDescription')),
            h('textarea', {
              className: 'dsh-push-textarea',
              value: draft.description,
              onChange: (e) => setDraft(Object.assign({}, draft, { description: e.target.value })),
            })),
          h('label', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('fieldHomepage')),
            h('input', {
              className: 'dsh-push-input',
              type: 'text',
              value: draft.homepage,
              spellCheck: false,
              onChange: (e) => setDraft(Object.assign({}, draft, { homepage: e.target.value })),
            })),
          h(Row, { title: t('fieldPrivate'), hint: t('fieldPrivateHint') },
            h(Switch, {
              checked: draft.isPrivate,
              label: t('fieldPrivate'),
              onChange: (next) => setDraft(Object.assign({}, draft, { isPrivate: next })),
            })),
          h(Row, { title: t('fieldArchived'), hint: t('fieldArchivedHint') },
            h(Switch, {
              checked: draft.archived,
              label: t('fieldArchived'),
              onChange: (next) => setDraft(Object.assign({}, draft, { archived: next })),
            })),
          h(Row, { title: t('fieldDefaultBranch') },
            h('select', {
              className: 'dsh-push-select',
              value: draft.defaultBranch,
              disabled: branches === null || undefined,
              onChange: (e) => setDraft(Object.assign({}, draft, { defaultBranch: e.target.value })),
            }, (branches || []).map((branch) => h('option', {
              key: branch.name,
              value: branch.name,
            }, branch.name)))),
          h('div', { className: 'dsh-push-inline' },
            h(Btn, { kind: 'primary', disabled: busy, onClick: saveSettings }, t('saveSettings'))),

          h('div', { className: 'dsh-push-subhead', style: { marginTop: '4px' } }, t('dangerZone')),
          h('div', { className: 'dsh-push-dangerzone' },
            h('div', { className: 'dsh-push-dangerrow' },
              h('div', { className: 'dsh-push-inline' },
                h('span', { className: 'dsh-push-danger-title' }, t('dangerRename')),
                h('span', { className: 'dsh-push-page-spacer' }),
                dangerKind === 'rename'
                  ? h(Btn, { mini: true, onClick: () => setDangerKind('') }, t('cancel'))
                  : h(Btn, {
                    mini: true,
                    disabled: busy || !can.admin,
                    onClick: () => {
                      setDangerKind('rename');
                      setDangerConfirm(name);
                      setDangerValue('');
                      setActionError('');
                    },
                  }, t('dangerRename'))),
              h('div', { className: 'dsh-push-row-hint' }, t('dangerRenameHint')),
              dangerKind === 'rename'
                ? h('div', { className: 'dsh-push-block' },
                  h('input', {
                    className: 'dsh-push-input',
                    type: 'text',
                    value: dangerConfirm,
                    spellCheck: false,
                    placeholder: t('dangerRenameField'),
                    onChange: (e) => setDangerConfirm(e.target.value),
                  }))
                : null),

            h('div', { className: 'dsh-push-dangerrow' },
              h('div', { className: 'dsh-push-inline' },
                h('span', { className: 'dsh-push-danger-title' }, t('dangerTransfer')),
                h('span', { className: 'dsh-push-page-spacer' }),
                dangerKind === 'transfer'
                  ? h(Btn, { mini: true, onClick: () => setDangerKind('') }, t('cancel'))
                  : h(Btn, {
                    mini: true,
                    disabled: busy || !can.admin,
                    onClick: () => {
                      setDangerKind('transfer');
                      setDangerConfirm('');
                      setDangerValue('');
                      setActionError('');
                    },
                  }, t('dangerTransfer'))),
              h('div', { className: 'dsh-push-row-hint' }, t('dangerTransferHint')),
              dangerKind === 'transfer'
                ? h('div', { className: 'dsh-push-block' },
                  h('input', {
                    className: 'dsh-push-input',
                    type: 'text',
                    value: dangerConfirm,
                    spellCheck: false,
                    placeholder: t('dangerTransferField'),
                    onChange: (e) => setDangerConfirm(e.target.value),
                  }))
                : null),

            h('div', { className: 'dsh-push-dangerrow' },
              h('div', { className: 'dsh-push-inline' },
                h('span', { className: 'dsh-push-danger-title' }, t('dangerDelete')),
                h('span', { className: 'dsh-push-page-spacer' }),
                dangerKind === 'delete'
                  ? h(Btn, { mini: true, onClick: () => setDangerKind('') }, t('cancel'))
                  : h(Btn, {
                    mini: true,
                    kind: 'danger',
                    disabled: busy || !can.delete,
                    onClick: () => {
                      setDangerKind('delete');
                      setDangerConfirm('');
                      setDangerValue('');
                      setActionError('');
                    },
                  }, t('dangerDelete'))),
              h('div', { className: 'dsh-push-row-hint' }, t('dangerDeleteHint'))),

            dangerKind
              ? h('div', { className: 'dsh-push-block' },
                h('span', { className: 'dsh-push-field-label' },
                  t('confirmTypeName', { name: owner + '/' + name })),
                h('div', { className: 'dsh-push-inline' },
                  h('input', {
                    className: 'dsh-push-input',
                    type: 'text',
                    value: dangerValue,
                    spellCheck: false,
                    autoComplete: 'off',
                    style: { flex: '1 1 180px', width: 'auto' },
                    placeholder: owner + '/' + name,
                    onChange: (e) => setDangerValue(e.target.value),
                  }),
                  h(Btn, {
                    kind: 'danger',
                    disabled: busy || !dangerReady,
                    onClick: runDanger,
                  }, dangerKind === 'delete'
                    ? t('dangerDelete')
                    : (dangerKind === 'rename' ? t('dangerRename') : t('dangerTransfer')))))
              : null),

          h(WarnBlock, { warnings: warningLines }));
      } else if (tab === 'releases') {
        body = h('div', { className: 'dsh-push-block' },
          h('div', { className: 'dsh-push-inline' },
            releaseDraft
              ? null
              : h(Btn, {
                mini: true,
                disabled: busy,
                onClick: () => {
                  setReleaseDraft({
                    id: '', tagName: '', name: '', body: '', draft: false, prerelease: false,
                  });
                  setActionError('');
                },
              }, t('releaseNew'))),

          releaseDraft
            ? h('div', { className: 'dsh-push-dangerbox' },
              releaseDraft.id
                ? null
                : h('div', { className: 'dsh-push-fieldpair' },
                  h('label', { className: 'dsh-push-field' },
                    h('span', { className: 'dsh-push-field-label' }, t('releaseTag')),
                    h('input', {
                      className: 'dsh-push-input',
                      type: 'text',
                      value: releaseDraft.tagName || '',
                      spellCheck: false,
                      placeholder: 'v1.2.0',
                      onChange: (e) => setReleaseDraft(Object.assign({}, releaseDraft, {
                        tagName: e.target.value,
                      })),
                    })),
                  h('label', { className: 'dsh-push-field' },
                    h('span', { className: 'dsh-push-field-label' }, t('releaseFrom')),
                    h('input', {
                      className: 'dsh-push-input',
                      type: 'text',
                      list: 'dsh-push-release-targets',
                      placeholder: t('releaseBranchPick'),
                      value: releaseDraft.target || '',
                      spellCheck: false,
                      onChange: (e) => setReleaseDraft(Object.assign({}, releaseDraft, {
                        target: e.target.value,
                      })),
                    }),
                    h('datalist', { id: 'dsh-push-release-targets' },
                      (data && Array.isArray(data.branches) ? data.branches : [])
                        .map((branch) => h('option', { key: branch.name, value: branch.name })),
                      (data && Array.isArray(data.releases) ? data.releases : [])
                        .map((release) => (release && release.tagName
                          ? h('option', { key: 'tag-' + release.tagName, value: release.tagName })
                          : null))),
                    h('span', { className: 'dsh-push-row-hint' }, t('releaseFromHint')))),
              h('label', { className: 'dsh-push-field' },
                h('span', { className: 'dsh-push-field-label' }, t('releaseName')),
                h('input', {
                  className: 'dsh-push-input',
                  type: 'text',
                  value: releaseDraft.name || '',
                  onChange: (e) => setReleaseDraft(Object.assign({}, releaseDraft, {
                    name: e.target.value,
                  })),
                })),
              h('label', { className: 'dsh-push-field' },
                h('span', { className: 'dsh-push-field-label' }, t('releaseBody')),
                h('textarea', {
                  className: 'dsh-push-textarea',
                  value: releaseDraft.body || '',
                  onChange: (e) => setReleaseDraft(Object.assign({}, releaseDraft, {
                    body: e.target.value,
                  })),
                })),
              h('div', { className: 'dsh-push-inline' },
                h('label', { className: 'dsh-push-inline' },
                  h(Switch, {
                    checked: releaseDraft.draft === true,
                    label: t('releaseDraft'),
                    onChange: (next) => setReleaseDraft(Object.assign({}, releaseDraft, { draft: next })),
                  }),
                  h('span', { className: 'dsh-push-row-hint' }, t('releaseDraft'))),
                h('label', { className: 'dsh-push-inline' },
                  h(Switch, {
                    checked: releaseDraft.prerelease === true,
                    label: t('releasePrerelease'),
                    onChange: (next) => setReleaseDraft(Object.assign({}, releaseDraft, {
                      prerelease: next,
                    })),
                  }),
                  h('span', { className: 'dsh-push-row-hint' }, t('releasePrerelease')))),
              h('div', { className: 'dsh-push-inline' },
                h(Btn, { kind: 'primary', disabled: busy, onClick: saveRelease },
                  releaseDraft.id ? t('releaseSave') : t('releaseCreate')),
                h(Btn, { onClick: () => setReleaseDraft(null) }, t('cancel'))))
            : null,

          releases === null
            ? h('div', { className: 'dsh-push-hint' }, t('fieldNullWarning'))
            : releases.length === 0
              ? h('div', { className: 'dsh-push-hint' }, t('releaseEmpty'))
              : releases.map((release) => {
                const arming = releaseArm === release.id;
                return h('div', { className: 'dsh-push-release', key: release.id },
                  h('div', { className: 'dsh-push-release-main' },
                    h('span', { className: 'dsh-push-release-tag dsh-push-mono' },
                      release.tagName || release.name || release.id),
                    h('span', { className: 'dsh-push-release-meta' },
                      release.name ? h('span', null, release.name) : null,
                      release.draft
                        ? h('span', { className: 'dsh-push-pill' }, t('releaseDraftBadge'))
                        : null,
                      release.prerelease
                        ? h('span', { className: 'dsh-push-pill dsh-push-pill--warn' },
                          t('releasePreBadge'))
                        : null,
                      release.createdAt
                        ? h('span', null, t('releaseCreatedAt') + ' ' + relativeTime(release.createdAt))
                        : null)),
                  h('div', { className: 'dsh-push-release-actions' },
                    release.htmlUrl
                      ? h('a', {
                        className: 'dsh-push-btn dsh-push-btn--mini',
                        href: release.htmlUrl,
                        target: '_blank',
                        rel: 'noreferrer',
                      }, h(Icon, { name: 'external', size: 11 }))
                      : null,
                    h(Btn, {
                      mini: true,
                      disabled: busy,
                      onClick: () => {
                        setReleaseDraft({
                          id: release.id,
                          tagName: release.tagName,
                          name: release.name || '',
                          body: '',
                          draft: release.draft === true,
                          prerelease: release.prerelease === true,
                        });
                        setActionError('');
                      },
                    }, t('releaseEdit')),
                    h(Btn, {
                      mini: true,
                      kind: 'danger',
                      disabled: busy,
                      onClick: () => deleteRelease(release),
                    }, arming ? t('releaseDeleteConfirm') : t('releaseDelete'))),

                  /* Assets belong to THIS release: a published release with no
                     downloadable file is the reason this section exists. The
                     label wraps a hidden file input so the whole strip is the
                     click target. */
                  h('div', { className: 'dsh-push-release-assets' },
                    h('label', { className: 'dsh-push-assetdrop' },
                      h(Icon, { name: 'plus', size: 11 }),
                      h('span', null, assetBusy ? t('assetUploading') : t('assetDrop')),
                      h('input', {
                        type: 'file',
                        style: { display: 'none' },
                        disabled: assetBusy,
                        onChange: (event) => {
                          const picked = event.target.files && event.target.files[0];
                          // Clear the input so picking the SAME file twice still
                          // fires a change event.
                          event.target.value = '';
                          if (picked) uploadAsset(release.id, picked);
                        },
                      })),
                    h('span', { className: 'dsh-push-row-hint' }, t('assetHint')),

                    /* What is already attached. Without this an upload was a
                       one-way door: no list, no way to remove a mistake. */
                    Array.isArray(release.assets) && release.assets.length > 0
                      ? h('div', { className: 'dsh-push-assetlist' },
                        release.assets.map((asset) => h('div', {
                          key: asset.id,
                          className: 'dsh-push-assetrow',
                        },
                          h('span', { className: 'dsh-push-rv-filename' }, asset.name),
                          h('span', { className: 'dsh-push-rv-muted' },
                            t('assetSizeKb', { n: Math.max(1, Math.round((asset.size || 0) / 1024)) })),
                          asset.downloadUrl
                            ? h('a', {
                              className: 'dsh-push-btn dsh-push-btn--mini',
                              href: asset.downloadUrl,
                              target: '_blank',
                              rel: 'noreferrer',
                            }, h(Icon, { name: 'external', size: 10 }))
                            : null,
                          h(Btn, {
                            mini: true,
                            kind: 'danger',
                            disabled: busy || assetBusy,
                            onClick: () => removeAsset(release.id, asset.id),
                          }, t('assetDelete')))))
                      : null));
              }),

          h(WarnBlock, { warnings: warningLines }));
      } else if (tab === 'collaborators') {
        body = h('div', { className: 'dsh-push-block' },
          collaborators === null
            ? h('div', { className: 'dsh-push-hint' }, t('fieldNullWarning'))
            : collaborators.length === 0
              ? h('div', { className: 'dsh-push-hint' }, t('collaboratorsEmpty'))
              : h('div', { className: 'dsh-push-rows' }, collaborators.map((row) => h('div', {
                className: 'dsh-push-branch',
                key: row.login,
              },
                h('span', { className: 'dsh-push-branch-name' },
                  h(Avatar, { url: row.avatarUrl, login: row.login, size: 18 }),
                  h('span', { className: 'dsh-push-mono' }, row.login),
                  h('span', { className: 'dsh-push-hint' }, row.role || '')),
                h('div', { className: 'dsh-push-branch-actions' },
                  h(Btn, {
                    mini: true,
                    kind: collabArm === row.login ? 'danger' : null,
                    disabled: busy || !can.admin,
                    onClick: () => removeCollaborator(row),
                  }, collabArm === row.login
                    ? t('collaboratorsRemoveConfirm')
                    : t('collaboratorsRemove')))))),

          can.admin
            ? h('div', { className: 'dsh-push-inline' },
              h('input', {
                className: 'dsh-push-input',
                type: 'text',
                value: collabUser,
                spellCheck: false,
                placeholder: t('collaboratorsUser'),
                style: { flex: '1 1 160px', width: 'auto' },
                onChange: (e) => setCollabUser(e.target.value),
              }),
              h('select', {
                className: 'dsh-push-select',
                value: collabPerm,
                'aria-label': t('collaboratorsPermission'),
                onChange: (e) => setCollabPerm(e.target.value),
              },
                h('option', { value: 'pull' }, t('collaboratorsRoleRead')),
                h('option', { value: 'push' }, t('collaboratorsRoleWrite')),
                h('option', { value: 'admin' }, t('collaboratorsRoleAdmin'))),
              h(Btn, {
                mini: true,
                disabled: busy || !collabUser.trim(),
                onClick: addCollaborator,
              }, t('collaboratorsAdd')))
            : null,

          h(WarnBlock, { warnings: warningLines }));
      } else {
        body = h('div', { className: 'dsh-push-block' },
          webhooks === null
            ? h('div', { className: 'dsh-push-hint' }, t('fieldNullWarning'))
            : webhooks.length === 0
              ? h('div', { className: 'dsh-push-hint' }, t('webhooksEmpty'))
              : h('div', { className: 'dsh-push-rows' }, webhooks.map((hook) => h('div', {
                className: 'dsh-push-kvrow',
                key: hook.id,
                title: hook.url,
              },
                h('span', { className: 'dsh-push-mono' }, hook.url || hook.id),
                h('span', {
                  className: 'dsh-push-pill' + (hook.active ? ' dsh-push-pill--ok' : ''),
                }, hook.active ? t('webhookActive') : t('webhookInactive')),
                h('span', { className: 'dsh-push-hint' },
                  t('webhookEvents', { n: (hook.events || []).length }))))),
          h(WarnBlock, { warnings: warningLines }));
      }

      const headPill = repoData && repoData.private
        ? h('span', { className: 'dsh-push-pill' }, t('repoPrivateBadge'))
        : h('span', { className: 'dsh-push-pill' }, t('repoPublic'));

      const subhead = h('span', { className: 'dsh-push-modal-subhead' },
        h('span', { className: 'dsh-push-manage-title' },
          h('span', { className: 'dsh-push-manage-name' }, owner + '/' + name),
          headPill),
        repoData && repoData.description
          ? h('span', { className: 'dsh-push-manage-desc', title: repoData.description },
            repoData.description)
          : null);
      return h(Modal, {
        open,
        wide: true,
        onClose: props.onClose,
        title: t('manageTitle'),
        subhead,
        tabs: h(TabRow, { value: tab, options: tabs, onChange: setTab }),
        footer: [
          h('div', { className: 'dsh-push-modal-status', key: 'status' },
            /* Feedback for asset upload/delete. It was being set and never shown,
           so a successful upload looked like nothing had happened. */
        actionNotice ? h('div', { className: 'dsh-push-hint dsh-push-notice' }, actionNotice) : null,
        actionError ? h('div', { className: 'dsh-push-error' }, actionError) : null,
            notice ? h('div', { className: 'dsh-push-ok' }, notice) : null,
            busy ? h('div', { className: 'dsh-push-hint' }, t('busy')) : null),
          h(Btn, { key: 'refresh', disabled: busy, onClick: load }, t('manageRefresh')),
          h(Btn, { key: 'close', onClick: props.onClose }, t('close')),
        ],
      },
        h('div', { className: 'dsh-push-rows', style: { gap: '8px' } }, body));
    }

    /* ─────────────────── A. settings.section: accounts + connection ─────── */

    /** The active account as a card; clicking anywhere toggles the dropdown. */
    function AccountCard(props) {
      const account = props.account;
      const scopes = account && Array.isArray(account.scopes) ? account.scopes : [];
      const name = (account && (account.name || account.login)) || '';
      return h('button', {
        type: 'button',
        className: 'dsh-push-acc-card',
        'aria-expanded': props.open ? 'true' : 'false',
        onClick: props.onToggle,
      },
        h(Avatar, { url: account && account.avatarUrl, login: account && account.login, size: 40 }),
        h('span', { className: 'dsh-push-acc-card-main' },
          h('span', { className: 'dsh-push-acc-card-name' }, name),
          h('span', { className: 'dsh-push-acc-card-sub' },
            h('span', { className: 'dsh-push-acc-card-login' }, '@' + ((account && account.login) || '')),
            // A fine-grained token reports no scopes at all, which is not the
            // same thing as "no permission" — say what is actually known.
            scopes.length === 0
              ? h('span', { className: 'dsh-push-pill dsh-push-pill--muted' }, t('scopeUnknown'))
              : h('span', {
                className: 'dsh-push-pill',
                title: scopes.join(', '),
              }, scopes[0] + (scopes.length > 1 ? ' +' + (scopes.length - 1) : '')))),
        // A direct way to the account's GitHub profile. It sits LEFT of the
        // chevron because the chevron owns the card's own expand action, and a
        // second click target inside the card must not look like part of it.
        account && account.htmlUrl
          ? h('a', {
            className: 'dsh-push-acc-card-profile',
            href: account.htmlUrl,
            target: '_blank',
            rel: 'noreferrer',
            title: t('accountOpenProfile'),
            'aria-label': t('accountOpenProfile'),
            onClick: (event) => { if (event) event.stopPropagation(); },
          }, h(Icon, { name: 'external', size: 12 }))
          : null,
        h('span', { className: 'dsh-push-chevron' + (props.open ? ' dsh-push-chevron--open' : '') },
          h(Icon, { name: 'chevron', size: 14 })));
    }

    /** One account row: pick it, or arm-then-remove it. */
    function AccountRow(props) {
      const account = props.account;
      return h('div', {
        className: 'dsh-push-acc-row' + (props.active ? ' dsh-push-acc-row--active' : ''),
      },
        h('button', {
          type: 'button',
          className: 'dsh-push-acc-row-main',
          onClick: props.onPick,
          title: account.login,
        },
          h(Avatar, { url: account.avatarUrl, login: account.login, size: 24 }),
          h('span', { className: 'dsh-push-acc-row-login' }, account.login),
          props.active ? h('span', { className: 'dsh-push-pill dsh-push-pill--active' }, t('current')) : null),
        h('button', {
          type: 'button',
          className: props.armed ? 'dsh-push-btn dsh-push-btn--danger dsh-push-btn--mini' : 'dsh-push-iconbtn',
          title: props.armed ? t('confirmRemove') : t('remove'),
          'aria-label': props.armed ? t('confirmRemove') : t('remove'),
          onClick: props.onRemove,
        }, props.armed
          ? h('span', null, t('confirmRemoveInline'))
          : h(Icon, { name: 'close', size: 12 })));
    }

    /** Token + device-code sign-in, shown inside the card in add mode. */
    function AddAccountPanel(props) {
      const device = props.device;
      const token = props.token || '';
      return h('div', { className: 'dsh-push-acc-panel' },
        h('div', { className: 'dsh-push-inline' },
          h('input', {
            className: 'dsh-push-input dsh-push-acc-token',
            type: 'password',
            placeholder: t('tokenPlaceholder'),
            value: token,
            autoComplete: 'off',
            spellCheck: false,
            onChange: (e) => props.onToken(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') props.onAdd(); },
          }),
          h(Btn, {
            kind: 'primary',
            disabled: props.busy || !token.trim(),
            onClick: props.onAdd,
          }, t('tokenAdd'))),
        h('div', { className: 'dsh-push-hint' }, t('tokenHint')),
        h('div', { className: 'dsh-push-divider' }),
        h('div', { className: 'dsh-push-inline' },
          device
            ? h(Btn, { onClick: props.onStopDevice }, t('cancelDevice'))
            : h(Btn, { disabled: props.busy, onClick: props.onStartDevice }, t('deviceLogin')),
          h('span', { className: 'dsh-push-hint' }, t('deviceHint'))),

        device
          ? h('div', { className: 'dsh-push-device' },
            h('div', { className: 'dsh-push-hint' }, t('deviceOpenHint')),
            h('div', { className: 'dsh-push-inline' },
              h('span', { className: 'dsh-push-device-code dsh-push-mono' }, device.userCode),
              h(Btn, { mini: true, onClick: props.onCopy }, t('copyCode'))),
            device.verificationUri
              ? h('a', {
                className: 'dsh-push-link',
                href: device.verificationUri,
                target: '_blank',
                rel: 'noreferrer',
              }, device.verificationUri)
              : null,
            h('div', { className: 'dsh-push-hint' }, t('deviceWaiting')))
          : null,

        props.deviceError ? h('div', { className: 'dsh-push-error' }, props.deviceError) : null,
        props.deviceNotice ? h('div', { className: 'dsh-push-ok' }, props.deviceNotice) : null,

        h('div', { className: 'dsh-push-inline' },
          h(Btn, { onClick: props.onClose }, t('cancel'))));
    }

    /** (a) GitHub-style contribution heatmap for the active account. */
    function ContributionsSection(props) {
      const ctx = props.ctx;
      const login = props.login;
      const [data, setData] = useState(null);
      const [days, setDays] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');

      const aliveRef = useRef(true);
      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const next = await api(ctx, API + '/contributions?login=' + encodeURIComponent(login)
            + '&days=365');
          if (!aliveRef.current) return;
          setData(next || {});
          setDays((next && (next.days || next.contributions)) || []);
        } catch (err) {
          if (!aliveRef.current) return;
          setData(null);
          setDays([]);
          setError(err.message);
        } finally {
          if (aliveRef.current) setLoading(false);
        }
      }, [ctx, login]);

      useEffect(() => { load(); }, [load]);

      const unavailable = Boolean(data && data.unavailable === true);
      const total = data && typeof data.total === 'number' ? data.total : 0;
      const weeks = buildContributionWeeks(days);

      let body;
      if (loading && !data) {
        body = h('div', { className: 'dsh-push-contrib-skel', 'aria-hidden': 'true' },
          CONTRIB_SKELETON.map((row) => h('div', { key: row, className: 'dsh-push-contrib-skel-row' })));
      } else if (error) {
        body = h('div', { className: 'dsh-push-error' }, error);
      } else if (unavailable) {
        // A token without `read:user` cannot read the calendar; that is a
        // normal state, not a failure, so it renders as one muted line.
        body = h('div', { className: 'dsh-push-inline' },
          h('span', { className: 'dsh-push-hint' }, data.message || t('contribTitle')),
          h('a', {
            className: 'dsh-push-link',
            href: TOKEN_URL,
            target: '_blank',
            rel: 'noreferrer',
          }, t('contribToken')));
      } else {
        body = h('div', { className: 'dsh-push-contrib-grid' },
          weeks.map((column, columnIndex) => h('div', {
            className: 'dsh-push-contrib-week',
            key: columnIndex,
          }, column.map((day) => {
            const level = contributionLevel(day.count);
            return h('div', {
              key: day.date,
              className: 'dsh-push-contrib-day' + (level > 0 ? ' dsh-push-contrib--l' + level : ''),
              title: day.date + ' · ' + t('contribCell', { n: day.count }),
            });
          }))));
      }

      return h('div', { className: 'dsh-push-side' },
        h('div', { className: 'dsh-push-side-head' },
          h('span', { className: 'dsh-push-side-title' }, t('contribTitle')),
          data && !unavailable && total >= 0
            ? h('span', { className: 'dsh-push-pill' }, t('contribTotal', { n: total }))
            : null,
          h('span', { className: 'dsh-push-page-spacer' }),
          h(Btn, { mini: true, title: t('refresh'), onClick: load },
            h(Icon, { name: 'refresh', size: 11 }))),
        body);
    }

    /** (b) Recent notifications for the active account. */
    function NotificationsSection(props) {
      const ctx = props.ctx;
      const [items, setItems] = useState([]);
      const [unreadCount, setUnreadCount] = useState(0);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busyId, setBusyId] = useState('');

      const aliveRef = useRef(true);
      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          // `all=false` only asks GitHub for the unread threads the section shows.
          const data = await api(ctx, API + '/notifications?all=false&limit=8');
          if (!aliveRef.current) return;
          const list = (data && (data.items || data.notifications)) || [];
          setItems(list);
          setUnreadCount(typeof (data && data.unreadCount) === 'number'
            ? data.unreadCount
            : list.filter((item) => item && item.unread).length);
        } catch (err) {
          if (!aliveRef.current) return;
          setItems([]);
          setUnreadCount(0);
          setError(err.message);
        } finally {
          if (aliveRef.current) setLoading(false);
        }
      }, [ctx]);

      useEffect(() => { load(); }, [load]);

      const markRead = async (item) => {
        if (!item || busyId === item.id) return;
        setBusyId(item.id);
        setError('');
        try {
          await api(ctx, API + '/notifications/read', { method: 'POST', body: { id: item.id } });
          if (!aliveRef.current) return;
          setItems((prev) => prev.map((row) => (
            row.id === item.id ? Object.assign({}, row, { unread: false }) : row
          )));
          setUnreadCount((prev) => Math.max(0, prev - 1));
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        } finally {
          if (aliveRef.current) setBusyId('');
        }
      };

      const openItem = (item) => {
        if (!item || !item.url) return;
        if (typeof window === 'undefined' || typeof window.open !== 'function') return;
        window.open(item.url, '_blank', 'noopener');
      };

      const rows = items.map((item) => {
        const meta = [notificationRepo(item), item.updatedAt ? relativeTime(item.updatedAt) : '']
          .filter(Boolean).join(' · ');
        return h('div', {
          className: 'dsh-push-note' + (item.unread ? ' dsh-push-note--unread' : ''),
          key: String(item.id),
          title: item.title || '',
          onClick: () => openItem(item),
        },
          h('span', { className: 'dsh-push-note-dot' + (item.unread ? ' dsh-push-note-dot--on' : '') }),
          h('div', { className: 'dsh-push-note-main' },
            h('div', { className: 'dsh-push-note-head' },
              h('span', { className: 'dsh-push-note-title' }, item.title || ''),
              h('span', { className: 'dsh-push-note-chip' }, notificationLabel(item.type))),
            meta ? h('div', { className: 'dsh-push-note-meta' }, meta) : null),
          item.unread
            ? h('div', { className: 'dsh-push-note-actions' },
              h(Btn, {
                mini: true,
                disabled: busyId === item.id,
                title: t('notifRead'),
                onClick: () => markRead(item),
              }, t('notifRead')))
            : null);
      });

      return h('div', { className: 'dsh-push-side' },
        h('div', { className: 'dsh-push-side-head' },
          h('span', { className: 'dsh-push-side-title' }, t('notifTitle')),
          unreadCount > 0
            ? h('span', { className: 'dsh-push-pill dsh-push-pill--active' }, String(unreadCount))
            : null,
          h('span', { className: 'dsh-push-page-spacer' }),
          h(Btn, { mini: true, title: t('refresh'), onClick: load },
            h(Icon, { name: 'refresh', size: 11 }))),
        error ? h('div', { className: 'dsh-push-error' }, error) : null,
        items.length === 0
          ? h('div', { className: 'dsh-push-hint' }, loading ? t('loading') : t('notifEmpty'))
          : rows);
    }

    /** (c) Repository management, compact: at most eight rows plus "view all". */
    function ReposSection(props) {
      const ctx = props.ctx;
      const [state, setState] = useState(null);
      const [repos, setRepos] = useState([]);
      const [query, setQuery] = useState('');
      const [search, setSearch] = useState('');
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [expanded, setExpanded] = useState('');
      const [detail, setDetail] = useState(null);
      const [detailError, setDetailError] = useState('');
      const [deleteArm, setDeleteArm] = useState('');
      const [form, setForm] = useState({ name: '', description: '', isPrivate: true });
      const [notice, setNotice] = useState('');
      // Which half of the account the list is showing. Private is the default
      // because that is usually where the working repos live.
      const [visibility, setVisibility] = useState('private');
      // List vs. cards, remembered independently of the settings page because
      // List vs. cards, and the card size. Remembered per surface so switching
      // away and back does not reset a deliberate choice.
      const [viewMode, setViewMode] = useState(() => readViewPref('section', 'card'));
      const [cardSize, setCardSize] = useState(() => readViewPref('section.size', 'small'));
      // The repository whose management dialog is open, if any. It is kept as
      // the repo OBJECT rather than a flag + id so the dialog can paint its
      // header before `/repos/manage` answers.
      const [manageRepo, setManageRepo] = useState(null);

      const aliveRef = useRef(true);
      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      useEffect(() => {
        if (!notice) return undefined;
        const id = setTimeout(() => { if (aliveRef.current) setNotice(''); }, TOAST_MS);
        return () => clearTimeout(id);
      }, [notice]);

      const loadState = useCallback(async () => {
        try {
          const next = await api(ctx, API + '/state');
          if (aliveRef.current) setState(next);
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        }
      }, [ctx]);

      const loadRepos = useCallback(async (term) => {
        setLoading(true);
        setError('');
        try {
          const params = new URLSearchParams();
          params.set('page', '1');
          if (term) params.set('q', term);
          params.set('affiliation', 'owner,collaborator,organization_member');
          params.set('sort', 'updated');
          const data = await api(ctx, API + '/repos?' + params.toString());
          if (!aliveRef.current) return;
          setRepos((data && data.items) || []);
        } catch (err) {
          if (!aliveRef.current) return;
          setError(err.message);
          setRepos([]);
        } finally {
          if (aliveRef.current) setLoading(false);
        }
      }, [ctx]);

      useEffect(() => { loadState(); loadRepos(''); }, [loadState, loadRepos]);

      // Cards need each repo's language mix, which the list payload does not
      // carry. Without this, every card bar on the settings page stayed in the
      // empty state while the README promised a proportion bar.
      // The language cache lives outside React, so filling it does not
      // repaint anything by itself. Bump a counter when the fetch settles;
      // the re-render then picks the data up through languageOf().
      const [, bumpLang] = useState(0);
      useEffect(() => {
        if (repos.length === 0) return undefined;
        let live = true;
        prefetchLanguages(ctx, repos).then(() => {
          if (live) bumpLang((n) => n + 1);
        });
        return () => { live = false; };
      }, [ctx, repos]);

      const runSearch = () => {
        setSearch(query.trim());
        setExpanded('');
        setDetail(null);
        loadRepos(query.trim());
      };

      const toggleDetail = async (repo) => {
        if (expanded === repo.fullName) {
          setExpanded('');
          setDetail(null);
          return;
        }
        setExpanded(repo.fullName);
        setDetail(null);
        setDetailError('');
        try {
          const params = new URLSearchParams();
          params.set('owner', repo.owner);
          params.set('name', repo.name);
          const data = await api(ctx, API + '/repos/detail?' + params.toString());
          if (aliveRef.current) setDetail(data);
        } catch (err) {
          if (aliveRef.current) setDetailError(err.message);
        }
      };

      const createRepo = async () => {
        const name = form.name.trim();
        if (!name) {
          setNotice(t('tabInitNameRequired'));
          return;
        }
        try {
          await api(ctx, API + '/repos/create', {
            method: 'POST',
            body: { name, private: form.isPrivate, description: form.description, autoInit: false },
          });
          if (!aliveRef.current) return;
          setForm({ name: '', description: '', isPrivate: true });
          setNotice(t('tabDone', { label: t('repoCreate') }));
          await loadRepos(search);
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        }
      };

      const deleteRepo = async (repo) => {
        setDeleteArm('');
        try {
          await api(ctx, API + '/repos/delete', {
            method: 'POST',
            // §3c requires an explicit confirmation for destructive repo
            // actions; these surfaces already arm a two-step confirm in the
            // UI, so the flag records the user's intent rather than bypassing
            body: { owner: repo.owner, name: repo.name, confirm: true },
          });
          if (!aliveRef.current) return;
          setNotice(t('tabDone', { label: t('repoDelete') }));
          setExpanded('');
          setDetail(null);
          await loadRepos(search);
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        }
      };

      const copyClone = async (repo) => {
        const ok = await copyText(repo.cloneUrl || '');
        if (aliveRef.current) setNotice(ok ? t('copied') : t('copyFailed'));
      };

      const loggedIn = Boolean(state && (state.accounts || []).length > 0);
      // Private and public repos are managed separately: the API returns one
      // mixed list, so the split is applied here and the two tallies are shown
      // on the control itself, letting the user see the shape of the account
      // without switching tabs.
      const privateCount = repos.filter((repo) => repo.private).length;
      const publicCount = repos.length - privateCount;
      const visible = visibility === 'private'
        ? repos.filter((repo) => repo.private)
        : repos.filter((repo) => !repo.private);
      const shown = visible.slice(0, SIDE_REPO_LIMIT);

      const renderRepo = (repo) => {
        const open = expanded === repo.fullName;
        const armed = deleteArm === repo.fullName;
        return h('div', { className: 'dsh-push-repo', key: repo.fullName },
          h('div', { className: 'dsh-push-repo-head', onClick: () => toggleDetail(repo) },
            h(Icon, { name: 'chevron', size: 12 }),
            // The NAME is a button of its own: clicking a repository's name
            // opens the management dialog, while clicking anywhere else on the
            // row still expands the quick branch list. The row's own handler
            // is cancelled so the two never fire together.
            h('button', {
              type: 'button',
              className: 'dsh-push-repo-name dsh-push-repo-name--link',
              title: repo.fullName + ' — ' + t('manageOpen'),
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                setManageRepo(repo);
              },
            }, repo.fullName),
            repo.private ? h('span', { className: 'dsh-push-pill' }, t('repoPrivateBadge')) : null,
            h('span', { className: 'dsh-push-page-spacer' }),
            /* Metrics sit to the RIGHT of the name, before the timestamp, and
               are single-line with a fixed line-height: the row keeps exactly
               the height it had before. */
            h(RepoMetrics, { repo, size: 10, className: 'dsh-push-row-stats' }),
            h('span', { className: 'dsh-push-repo-meta', title: repo.updatedAt || '' },
              relativeTime(repo.updatedAt))),

          open
            ? h('div', { className: 'dsh-push-repo-detail' },
              h('div', { className: 'dsh-push-row-hint' },
                t('repoDefaultBranch') + ': ' + repo.defaultBranch
                + (repo.language ? ' · ' + repo.language : '')),

              h('div', { className: 'dsh-push-section-sub', style: { padding: 0 } }, t('repoBranches')),
              detail && Array.isArray(detail.branches) && detail.branches.length > 0
                ? h('div', { className: 'dsh-push-chips' }, detail.branches.map((branch) => h('span', {
                  className: 'dsh-push-pill',
                  key: branch.name,
                  title: branch.sha || '',
                }, branch.name)))
                : h('div', { className: 'dsh-push-row-hint' }, detailError || t('repoNoDetail')),

              h('div', { className: 'dsh-push-actions' },
                h(Btn, { onClick: () => setManageRepo(repo) }, t('manageOpen')),
                h('a', {
                  className: 'dsh-push-btn',
                  href: repo.htmlUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                }, h(Icon, { name: 'external', size: 12 }), t('repoOpen')),
                h(Btn, { onClick: () => copyClone(repo) }, t('repoClone')),
                armed
                  ? h(Btn, { kind: 'danger', onClick: () => deleteRepo(repo) }, t('repoDeleteConfirm'))
                  : h(Btn, { kind: 'danger', onClick: () => setDeleteArm(repo.fullName) }, t('repoDelete')),
                armed ? h(Btn, { onClick: () => setDeleteArm('') }, t('cancel')) : null),

              armed
                ? h('div', { className: 'dsh-push-dangerbox' },
                  h('div', { className: 'dsh-push-error' }, t('repoDeleteWarn')))
                : null)
            : null);
      };

      return h('div', { className: 'dsh-push-side' },
        h('div', { className: 'dsh-push-side-head' },
          h('span', { className: 'dsh-push-side-title' }, t('sideRepos')),
          h('span', { className: 'dsh-push-page-spacer' }),
          h(Btn, { mini: true, onClick: props.onOpenAll }, t('openAll'))),

        h('div', { className: 'dsh-push-inline' },
          h('div', { className: 'dsh-push-search' },
            h(Icon, { name: 'search', size: 12 }),
            h('input', {
              type: 'text',
              value: query,
              placeholder: t('pageSearchPlaceholder'),
              disabled: !loggedIn,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); },
            })),
          h(Btn, { disabled: !loggedIn, onClick: runSearch }, t('refresh'))),

        /* Private vs public get their own lists rather than one mixed feed:
           they are managed differently (a delete is far riskier on the public
           side), and the counts make the split visible at a glance. */
        h('div', { className: 'dsh-push-inline dsh-push-segrow' },
          h(Segmented, {
            value: visibility,
            onChange: (next) => {
              setVisibility(next);
              setExpanded('');
              setDetail(null);
            },
            options: [
              { value: 'private', label: t('repoPrivate'), count: privateCount },
              { value: 'public', label: t('repoPublic'), count: publicCount },
            ],
          })),

        h('div', { className: 'dsh-push-inline dsh-push-segrow' },
          h(ViewSwitch, {
            mode: viewMode,
            size: cardSize,
            onMode: (next) => { setViewMode(next); writeViewPref('section', next); },
            onSize: (next) => { setCardSize(next); writeViewPref('section.size', next); },
          })),

        !loggedIn
          ? h('div', { className: 'dsh-push-hint' }, t('repoNoAccount'))
          : loading && repos.length === 0
            ? h('div', { className: 'dsh-push-hint' }, t('loading'))
            : error
              ? h('div', { className: 'dsh-push-error' }, error)
              : shown.length === 0
                ? h('div', { className: 'dsh-push-hint' },
                  search
                    ? t('repoEmpty')
                    : (visibility === 'private' ? t('repoNonePrivate') : t('repoNonePublic')))
                : (viewMode === 'card'
                  ? h('div', {
                    className: 'dsh-push-repocards'
                      + (cardSize === 'large' ? ' dsh-push-repocards--large' : ''),
                  }, shown.map((repo) => h(RepoCard, {
                    key: repo.fullName,
                    repo,
                    size: cardSize,
                    languages: languageOf(repo),
                    // ReposSection owns its own manage dialog; calling a
                    // prop that SettingsSection never passes crashed the click.
                    onOpen: () => setManageRepo(repo),
                    onManage: () => setManageRepo(repo),
                  })))
                  : shown.map(renderRepo)),

        visible.length > SIDE_REPO_LIMIT
          ? h('div', { className: 'dsh-push-inline' },
            h('span', { className: 'dsh-push-hint' },
              t('sideReposTruncated', { n: SIDE_REPO_LIMIT })),
            h(Btn, { mini: true, onClick: props.onOpenAll }, t('openAll')))
          : null,

        h('div', { className: 'dsh-push-inline' },
          h('input', {
            className: 'dsh-push-input',
            type: 'text',
            placeholder: t('repoName'),
            value: form.name,
            disabled: !loggedIn,
            style: { flex: '1 1 140px', width: 'auto' },
            onChange: (e) => setForm(Object.assign({}, form, { name: e.target.value })),
          }),
          h('label', { className: 'dsh-push-inline' },
            h(Switch, {
              checked: form.isPrivate,
              label: t('repoPrivate'),
              onChange: (next) => setForm(Object.assign({}, form, { isPrivate: next })),
            }),
            h('span', { className: 'dsh-push-row-hint' }, t('repoPrivate'))),
          h(Btn, { kind: 'primary', disabled: !loggedIn, onClick: createRepo }, t('repoCreate'))),

        notice ? h('div', { className: 'dsh-push-ok' }, notice) : null,

        /* The management dialog lives inside this section's tree, so it
           inherits the theme tokens and unmounts with the page. */
        h(RepoManageModal, {
          open: Boolean(manageRepo),
          repo: manageRepo,
          ctx,
          onClose: () => setManageRepo(null),
          // A mutation can change the list (a rename, a visibility flip), so
          // the list and the account document are re-read on every change.
          onChanged: () => { loadRepos(search); },
          onDeleted: () => {
            setManageRepo(null);
            setNotice(t('manageClosed'));
            setExpanded('');
            setDetail(null);
            loadRepos(search);
          },
        }));
    }

    function SettingsSection(props) {
            const ctx = props.ctx;
      // 字号与间距的全局缩放，四档界面共用同一个值。
      const [density, setDensity] = useDensity(); const [state, setState] = useState(null);
      const [draft, setDraft] = useState({ oauthClientId: '', gitPath: '', defaultRemote: 'origin', showPrivate: true });
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [savedAt, setSavedAt] = useState(0);
      const [token, setToken] = useState('');
      const [removeArmed, setRemoveArmed] = useState('');
      const [device, setDevice] = useState(null);
      const [deviceError, setDeviceError] = useState('');
      const [deviceNotice, setDeviceNotice] = useState('');
      const [open, setOpen] = useState(false);
      const [addMode, setAddMode] = useState(false);
      // Global options are collapsed by default: they are set once and then
      // never touched again, so they must not push the account panels down.
      const [connOpen, setConnOpen] = useState(false);


      const aliveRef = useRef(true);
      const pollRef = useRef(null);
      const seededRef = useRef(false);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (pollRef.current) clearTimeout(pollRef.current);
          pollRef.current = null;
        };
      }, []);

      const load = useCallback(async () => {
        try {
          const next = await api(ctx, API + '/state');
          if (aliveRef.current) {
            setState(next);
            setError('');
          }
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        }
      }, [ctx]);

      useEffect(() => { load(); }, [load]);

      // Seed the editable draft once: a later /state refresh (after adding an
      // account, say) must not overwrite whatever is still being typed here.
      useEffect(() => {
        if (!state || seededRef.current) return;
        seededRef.current = true;
        setDraft({
          oauthClientId: (state.settings && state.settings.oauthClientId) || '',
          gitPath: (state.settings && state.settings.gitPath) || '',
          defaultRemote: (state.settings && state.settings.defaultRemote) || 'origin',
          showPrivate: !(state.settings && state.settings.showPrivate === false),
        });
      }, [state]);

      useEffect(() => {
        if (!savedAt) return undefined;
        const id = setTimeout(() => { if (aliveRef.current) setSavedAt(0); }, 2000);
        return () => clearTimeout(id);
      }, [savedAt]);

      /** POST through the shared helper, folding failures into the inline error. */
      const post = useCallback(async (path, body) => {
        setBusy(true);
        setError('');
        try {
          return await api(ctx, API + path, { method: 'POST', body });
        } catch (err) {
          if (aliveRef.current) setError(err.message);
          return null;
        } finally {
          if (aliveRef.current) setBusy(false);
        }
      }, [ctx]);

      const stopPoll = useCallback(() => {
        if (pollRef.current) clearTimeout(pollRef.current);
        pollRef.current = null;
        setDevice(null);
      }, []);

      /**
       * Device flow (RFC 8628): the host starts it and relays GitHub's poll
       * answer. `slow_down` is GitHub asking us to back off, so the interval
       * grows instead of the poll stopping; the deadline comes from expiresIn
       * because GitHub silently drops an expired device code.
       */
      const startDevice = useCallback(async () => {
        if (pollRef.current) clearTimeout(pollRef.current);
        pollRef.current = null;
        setDevice(null);
        setDeviceError('');
        setDeviceNotice('');
        setError('');
        setBusy(true);
        let started = null;
        try {
          started = await api(ctx, API + '/accounts/device/start', { method: 'POST', body: {} });
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        } finally {
          if (aliveRef.current) setBusy(false);
        }
        if (!started || !aliveRef.current) return;

        setDevice(started);
        const deadline = Date.now() + Math.max(10, Number(started.expiresIn) || 900) * 1000;
        let interval = Math.max(5, Number(started.interval) || 5) * 1000;

        const tick = async () => {
          if (!aliveRef.current) return;
          let result = null;
          try {
            result = await api(ctx, API + '/accounts/device/poll', {
              method: 'POST',
              body: { deviceCode: started.deviceCode },
            });
          } catch (err) {
            if (aliveRef.current) {
              setDeviceError(err.message);
              setDevice(null);
            }
            return;
          }
          if (!aliveRef.current) return;
          if (result && result.status === 'done') {
            setDevice(null);
            setDeviceError('');
            setDeviceNotice(t('deviceDone'));
            if (result.accounts) {
              setState((prev) => (prev
                ? Object.assign({}, prev, {
                  accounts: result.accounts,
                  activeAccountId: result.activeAccountId || prev.activeAccountId,
                })
                : prev));
            } else {
              load();
            }
            return;
          }
          if (result && result.status === 'slow_down') interval += 5000;
          if (Date.now() >= deadline) {
            setDevice(null);
            setDeviceError(t('deviceExpired'));
            return;
          }
          pollRef.current = setTimeout(tick, interval);
        };
        pollRef.current = setTimeout(tick, interval);
      }, [ctx, load]);

      const accounts = (state && state.accounts) || [];
      const activeId = state ? state.activeAccountId : null;
      const activeAccount = accounts.find((account) => account.id === activeId) || null;
      const gitAvailable = state ? state.gitAvailable : null;

      const addToken = async () => {
        const value = token.trim();
        if (!value) return;
        const result = await post('/accounts/token', { token: value });
        if (result && aliveRef.current) {
          setToken('');
          setState((prev) => (prev
            ? Object.assign({}, prev, { accounts: result.accounts, activeAccountId: result.activeAccountId })
            : prev));
        }
      };

      const activate = async (accountId) => {
        const result = await post('/accounts/activate', { accountId });
        if (result && aliveRef.current) {
          setState((prev) => (prev
            ? Object.assign({}, prev, { activeAccountId: result.activeAccountId || accountId })
            : prev));
        }
      };

      const removeAccount = async (accountId) => {
        setRemoveArmed('');
        const result = await post('/accounts/remove', { accountId });
        if (result && aliveRef.current) {
          setState((prev) => (prev
            ? Object.assign({}, prev, { accounts: result.accounts, activeAccountId: result.activeAccountId })
            : prev));
        }
      };

      const saveSettings = async () => {
        const result = await post('/settings', {
          oauthClientId: draft.oauthClientId.trim(),
          gitPath: draft.gitPath.trim(),
          defaultRemote: draft.defaultRemote.trim() || 'origin',
          showPrivate: draft.showPrivate,
        });
        if (result && aliveRef.current) {
          if (result.settings) setState((prev) => (prev ? Object.assign({}, prev, { settings: result.settings }) : prev));
          setSavedAt(Date.now());
        }
      };

      const copyCode = async () => {
        if (!device) return;
        const ok = await copyText(device.userCode);
        if (aliveRef.current) setDeviceNotice(ok ? t('copied') : t('copyFailed'));
      };

      const toggleCard = () => {
        setAddMode(false);
        setOpen((prev) => !prev);
      };

      const openAdd = () => {
        setOpen(true);
        setAddMode(true);
        setError('');
      };

      const closeAdd = () => {
        stopPoll();
        setDeviceError('');
        setDeviceNotice('');
        setAddMode(false);
        setOpen(false);
      };

      const pickAccount = (accountId) => {
        setAddMode(false);
        setOpen(false);
        if (accountId !== activeId) activate(accountId);
      };

      const removeRow = (accountId) => {
        if (removeArmed !== accountId) {
          setRemoveArmed(accountId);
          return;
        }
        removeAccount(accountId);
      };

      const openAll = () => {
        try {
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : null;
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('push');
        } catch (err) {
          /* the full page is only reachable when a layout service exists */
        }
      };

      const addPanel = h(AddAccountPanel, {
        busy,
        token,
        device,
        deviceError,
        deviceNotice,
        onToken: setToken,
        onAdd: addToken,
        onStartDevice: startDevice,
        onStopDevice: stopPoll,
        onCopy: copyCode,
        onClose: closeAdd,
      });

      let accountBody;
      if (accounts.length === 0) {
        accountBody = addMode
          ? addPanel
          : h('button', {
            type: 'button',
            className: 'dsh-push-acc-card dsh-push-acc-card--empty',
            onClick: openAdd,
          },
            // The plus glyph is drawn by the icon; the label carries no "+" of
            // its own, otherwise the card shows two of them side by side.
            h('span', { className: 'dsh-push-acc-card-empty' },
              h(Icon, { name: 'plus', size: 14 }),
              t('addAccountNew')),
            h('span', { className: 'dsh-push-acc-card-hint' }, t('addAccountHint')));
      } else {
        accountBody = [
          h(AccountCard, {
            key: 'card',
            account: activeAccount || accounts[0],
            open: open,
            onToggle: toggleCard,
          }),
          open
            ? h('div', { className: 'dsh-push-acc-drop', key: 'drop' },
              addMode
                ? addPanel
                : [
                  accounts.map((account) => h(AccountRow, {
                    key: account.id,
                    account,
                    active: account.id === activeId,
                    armed: removeArmed === account.id,
                    onPick: () => pickAccount(account.id),
                    onRemove: () => removeRow(account.id),
                  })),
                  h('button', {
                    key: 'add-row',
                    type: 'button',
                    className: 'dsh-push-acc-addrow',
                    onClick: openAdd,
                  },
                    h(Icon, { name: 'plus', size: 12 }),
                    t('addAccountNew')),
                ])
            : null,
        ];
      }

      return h('div', { className: 'dsh-push-root dsh-push-settings', style: densityStyle(density) },
        /* ── 个性化：信息密度 ──
         * 放在最上面，因为它是用户进来只想调一次就永远不管的开关。
         * 滑杆是无极的，三个按钮只是快捷键。 */
        h('div', { className: 'dsh-push-group' },
          h('div', { className: 'dsh-push-group-head' },
            h('span', null, t('densityTitle')),
            h('span', { className: 'dsh-push-density-value' }, density + '%')),
          h('div', { className: 'dsh-push-density-controls' },
            h('input', {
              className: 'dsh-push-density-slider',
              type: 'range',
              min: DENSITY_MIN,
              max: DENSITY_MAX,
              step: 1,
              value: density,
              'aria-label': t('densityTitle'),
              onChange: (event) => setDensity(Number(event.target.value)),
            }),
            h('div', { className: 'dsh-push-density-presets' },
              DENSITY_PRESETS.map((preset) => h('button', {
                key: preset.id,
                type: 'button',
                className: 'dsh-push-density-preset' + (density === preset.value ? ' is-on' : ''),
                onClick: () => setDensity(preset.value),
              }, t('density_' + preset.id)))),
          h('div', { className: 'dsh-push-row-hint' }, t('densityHint')))),
        /* ── accounts ── */
        h('div', { className: 'dsh-push-group' },
          h('div', { className: 'dsh-push-group-head' },
            h('span', null, t('accountSection')),
            // Global, rarely-touched options live behind this gear instead of
            // occupying a permanent section below the account panels. It sits
            // in the section head's top-right corner, which is where the rest
            // of the host puts per-page options.
            h('button', {
              type: 'button',
              className: 'dsh-push-iconbtn dsh-push-gearbtn' + (connOpen ? ' is-on' : ''),
              title: t('connSection'),
              'aria-label': t('connSection'),
              'aria-expanded': connOpen ? 'true' : 'false',
              onClick: () => setConnOpen((v) => !v),
            }, h(Icon, { name: 'gear', size: 14 }))),
          h('div', { className: 'dsh-push-acc-stack' }, accountBody)),

        /* ── active-account panels ── */
        activeAccount
          ? [
            // Keyed by login: switching accounts must reload both remote panels.
            h(ContributionsSection, { key: 'contrib:' + activeAccount.login, ctx, login: activeAccount.login }),
            h(NotificationsSection, { key: 'notif:' + activeAccount.login, ctx }),
            h(ReposSection, {
              key: 'repos:' + activeAccount.login,
              ctx,
              onOpenAll: openAll,
            }),
          ]
          : null,
        state && !gitAvailable
          ? h('div', { className: 'dsh-push-error' }, t('errGitMissing'))
          : null,

        /* ── global options: a modal, not a section at the bottom ──
         *
         * These four fields are set once and then left alone, so inline they
         * pushed the account panels down and read as a stray block. A modal
         * keeps the overview page about the account and still gives the fields
         * a proper place to live (Escape / backdrop / × all close it). */
        h(Modal, {
          open: connOpen,
          onClose: () => setConnOpen(false),
          title: t('connSection'),
          footer: [
            h('div', { className: 'dsh-push-modal-status', key: 'status' },
              error ? h('div', { className: 'dsh-push-error' }, error) : null,
              savedAt ? h('div', { className: 'dsh-push-ok' }, t('saved')) : null),
            h(Btn, { key: 'close', onClick: () => setConnOpen(false) }, t('close')),
            h(Btn, {
              key: 'save',
              kind: 'primary',
              disabled: busy,
              onClick: saveSettings,
            }, t('save')),
          ],
        },
          h(Row, { title: t('oauthClientId'), hint: t('oauthClientIdHint') },
            h('input', {
              className: 'dsh-push-input',
              type: 'text',
              value: draft.oauthClientId,
              spellCheck: false,
              style: { width: '220px' },
              onChange: (e) => setDraft(Object.assign({}, draft, { oauthClientId: e.target.value })),
            })),

          h(Row, { title: t('gitPath'), hint: t('gitPathPlaceholder') },
            h('input', {
              className: 'dsh-push-input',
              type: 'text',
              placeholder: t('gitPathPlaceholder'),
              value: draft.gitPath,
              spellCheck: false,
              style: { width: '220px' },
              onChange: (e) => setDraft(Object.assign({}, draft, { gitPath: e.target.value })),
            })),

          h(Row, { title: t('defaultRemote') },
            h('input', {
              className: 'dsh-push-input',
              type: 'text',
              placeholder: t('defaultRemotePlaceholder'),
              value: draft.defaultRemote,
              spellCheck: false,
              style: { width: '140px' },
              onChange: (e) => setDraft(Object.assign({}, draft, { defaultRemote: e.target.value })),
            })),

          h(Row, { title: t('showPrivate') },
            h(Switch, {
              checked: draft.showPrivate,
              label: t('showPrivate'),
              onChange: (next) => setDraft(Object.assign({}, draft, { showPrivate: next })),
            })),

          /* git availability is a machine-wide fact, so it belongs with the
             other global options rather than on the account overview. */
          h('div', { className: 'dsh-push-row', style: { borderBottom: 'none' } },
            h('div', { className: 'dsh-push-row-label' },
              h('div', { className: 'dsh-push-row-hint' },
                t('gitVersion') + ': '
                + ((state && state.gitVersion) || (state ? t('gitMissing') : t('loading'))))),
            h(Btn, { onClick: load }, t('refresh')))));
    }

    /* ───────────── B1. sidebar.panellist icon ───────────────────────────── */

    /* ───────────── 信息密度（个性化：字号 + 间距） ───────────── */

/** 允许的缩放区间。低于 0.85 会挤到看不清，高于 1.25 在小面板里会溢出。 */
const DENSITY_MIN = 85;
const DENSITY_MAX = 125;
const DENSITY_DEFAULT = 100;

/** 三档快捷值，滑杆仍是无极的。 */
const DENSITY_PRESETS = [
  { id: 'small', value: 90 },
  { id: 'medium', value: 100 },
  { id: 'large', value: 112 },
];

/** 订阅者：改一处密度，所有已挂载的界面一起变。 */
const densityListeners = new Set();

/** 读回用户上次的密度，非法值一律回到 100。 */
function readDensity() {
  const raw = readViewPref('density', String(DENSITY_DEFAULT));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DENSITY_DEFAULT;
  return Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, value));
}

/** 保存密度并通知所有界面立即重绘。 */
function writeDensity(value) {
  const clamped = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, Math.round(value)));
  writeViewPref('density', String(clamped));
  for (const listener of [...densityListeners]) {
    try { listener(clamped); } catch { /* 订阅者可能已卸载 */ }
  }
}

/**
 * 密度状态。每个界面各自订阅，改设置页的滑杆时侧栏与标签页同时跟随。
 * @returns {[number, (value: number) => void]}
 */
function useDensity() {
  const [value, setValue] = useState(readDensity);
  useEffect(() => {
    const listener = (next) => setValue(next);
    densityListeners.add(listener);
    // 挂载时对齐一次：另一个界面可能刚改过。
    setValue(readDensity());
    return () => { densityListeners.delete(listener); };
  }, []);
  return [value, writeDensity];
}

/** 把密度折算成根容器的内联样式。 */
function densityStyle(value) {
  return { zoom: String(value / 100) };
}

function SidebarIcon(props) {
      return h('span', {
        className: 'dsh-push-sb-icon',
        'data-active': props && props.active ? 'true' : 'false',
      }, h(GithubMark, { size: (props && props.size) || 16 }));
    }

    /* ───────────── B2. main page: remote repositories ───────────────────── */

    function ReposPage(props) {
            const ctx = props.ctx;
      const [density] = useDensity(); const [state, setState] = useState(null);
      const [repos, setRepos] = useState([]);
      const [query, setQuery] = useState('');
      const [search, setSearch] = useState('');
      const [onlyPrivate, setOnlyPrivate] = useState(false);
      const [page, setPage] = useState(1);
      const [hasMore, setHasMore] = useState(false);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [expanded, setExpanded] = useState('');
      const [detail, setDetail] = useState(null);
      const [detailError, setDetailError] = useState('');
      const [deleteArm, setDeleteArm] = useState('');
      const [form, setForm] = useState({ name: '', description: '', isPrivate: true });
      const [notice, setNotice] = useState('');
      // Same contract as the settings-side list: the NAME opens the dialog,
      // the rest of the row expands the inline detail.
      const [manageRepo, setManageRepo] = useState(null);
      // List vs. cards on this page, remembered independently of the settings
      // page because the two surfaces have different widths.
      const [viewMode, setViewMode] = useState(() => readViewPref('page', 'card'));
      const [cardSize, setCardSize] = useState(() => readViewPref('page.size', 'small'));

      const aliveRef = useRef(true);
      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      useEffect(() => {
        if (!notice) return undefined;
        const id = setTimeout(() => { if (aliveRef.current) setNotice(''); }, TOAST_MS);
        return () => clearTimeout(id);
      }, [notice]);

      const loadState = useCallback(async () => {
        try {
          const next = await api(ctx, API + '/state');
          if (aliveRef.current) setState(next);
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        }
      }, [ctx]);

      const loadRepos = useCallback(async (nextPage, term) => {
        setLoading(true);
        setError('');
        try {
          const params = new URLSearchParams();
          params.set('page', String(nextPage));
          if (term) params.set('q', term);
          params.set('affiliation', 'owner,collaborator,organization_member');
          params.set('sort', 'updated');
          const data = await api(ctx, API + '/repos?' + params.toString());
          if (!aliveRef.current) return;
          const items = (data && data.items) || [];
          setRepos((prev) => (nextPage === 1 ? items : prev.concat(items)));
          setPage(nextPage);
          setHasMore(Boolean(data && data.hasMore));
        } catch (err) {
          if (aliveRef.current) {
            setError(err.message);
            if (nextPage === 1) setRepos([]);
          }
        } finally {
          if (aliveRef.current) setLoading(false);
        }
      }, [ctx]);

      useEffect(() => { loadState(); loadRepos(1, ''); }, [loadState, loadRepos]);

      // Cards on this page need the language mix as well.
      // The language cache lives outside React, so filling it does not
      // repaint anything by itself. Bump a counter when the fetch settles;
      // the re-render then picks the data up through languageOf().
      const [, bumpLang] = useState(0);
      useEffect(() => {
        if (repos.length === 0) return undefined;
        let live = true;
        prefetchLanguages(ctx, repos).then(() => {
          if (live) bumpLang((n) => n + 1);
        });
        return () => { live = false; };
      }, [ctx, repos]);

      const runSearch = () => {
        setSearch(query.trim());
        setExpanded('');
        setDetail(null);
        loadRepos(1, query.trim());
      };

      const accounts = (state && state.accounts) || [];
      const activeId = state ? state.activeAccountId : null;
      const active = accounts.find((a) => a.id === activeId) || null;
      const loggedIn = accounts.length > 0;

      const activate = async (accountId) => {
        if (!accountId) return;
        try {
          await api(ctx, API + '/accounts/activate', { method: 'POST', body: { accountId } });
          await loadState();
          await loadRepos(1, search);
          setExpanded('');
          setDetail(null);
        } catch (err) {
          setError(err.message);
        }
      };

      const toggleDetail = async (repo) => {
        if (expanded === repo.fullName) {
          setExpanded('');
          setDetail(null);
          return;
        }
        setExpanded(repo.fullName);
        setDetail(null);
        setDetailError('');
        try {
          const params = new URLSearchParams();
          params.set('owner', repo.owner);
          params.set('name', repo.name);
          const data = await api(ctx, API + '/repos/detail?' + params.toString());
          if (aliveRef.current) setDetail(data);
        } catch (err) {
          if (aliveRef.current) setDetailError(err.message);
        }
      };

      const createRepo = async () => {
        const name = form.name.trim();
        if (!name) {
          setNotice(t('tabInitNameRequired'));
          return;
        }
        try {
          await api(ctx, API + '/repos/create', {
            method: 'POST',
            body: { name, private: form.isPrivate, description: form.description, autoInit: false },
          });
          setForm({ name: '', description: '', isPrivate: true });
          setNotice(t('tabDone', { label: t('repoCreate') }));
          await loadRepos(1, search);
        } catch (err) {
          setError(err.message);
        }
      };

      const deleteRepo = async (repo) => {
        setDeleteArm('');
        try {
          await api(ctx, API + '/repos/delete', {
            method: 'POST',
            // §3c requires an explicit confirmation for destructive repo
            // actions; these surfaces already arm a two-step confirm in the
            // UI, so the flag records the user's intent rather than bypassing
            body: { owner: repo.owner, name: repo.name, confirm: true },
          });
          setNotice(t('tabDone', { label: t('repoDelete') }));
          setExpanded('');
          setDetail(null);
          await loadRepos(1, search);
        } catch (err) {
          setError(err.message);
        }
      };

      const copyClone = async (repo) => {
        const ok = await copyText(repo.cloneUrl || '');
        if (aliveRef.current) setNotice(ok ? t('copied') : t('copyFailed'));
      };

      const visibleRepos = onlyPrivate ? repos.filter((r) => r.private) : repos;

      const renderRepo = (repo) => {
        const open = expanded === repo.fullName;
        const armed = deleteArm === repo.fullName;
        return h('div', { className: 'dsh-push-repo', key: repo.fullName },
          h('div', { className: 'dsh-push-repo-head', onClick: () => toggleDetail(repo) },
            h(Icon, { name: 'chevron', size: 12 }),
            // Same split as the settings list: name → management dialog,
            // rest of the row → inline detail.
            h('button', {
              type: 'button',
              className: 'dsh-push-repo-name dsh-push-repo-name--link',
              title: repo.fullName + ' — ' + t('manageOpen'),
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                setManageRepo(repo);
              },
            }, repo.fullName),
            repo.private ? h('span', { className: 'dsh-push-pill' }, t('repoPrivateBadge')) : null,
            h('span', { className: 'dsh-push-repo-meta' }, repo.defaultBranch),
            h('span', { className: 'dsh-push-repo-meta', title: repo.updatedAt || '' },
              t('repoUpdated') + ' ' + relativeTime(repo.updatedAt))),

          repo.description
            ? h('div', { className: 'dsh-push-repo-desc', title: repo.description }, repo.description)
            : null,

          open
            ? h('div', { className: 'dsh-push-repo-detail' },
              h('div', { className: 'dsh-push-row-hint' },
                t('repoDefaultBranch') + ': ' + repo.defaultBranch
                + (repo.language ? ' · ' + repo.language : '')
                + (typeof repo.stars === 'number' ? ' · ' + repo.stars : '')),

              h('div', { className: 'dsh-push-section-sub', style: { padding: 0 } }, t('repoBranches')),
              detail && Array.isArray(detail.branches) && detail.branches.length > 0
                ? h('div', { className: 'dsh-push-chips' }, detail.branches.map((branch) => h('span', {
                  className: 'dsh-push-pill',
                  key: branch.name,
                  title: branch.sha || '',
                }, branch.name)))
                : h('div', { className: 'dsh-push-row-hint' }, detailError || t('repoNoDetail')),

              h('div', { className: 'dsh-push-actions' },
                h(Btn, { onClick: () => setManageRepo(repo) }, t('manageOpen')),
                h('a', {
                  className: 'dsh-push-btn',
                  href: repo.htmlUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                }, h(Icon, { name: 'external', size: 12 }), t('repoOpen')),
                h(Btn, { onClick: () => copyClone(repo) }, t('repoClone')),
                armed
                  ? h(Btn, { kind: 'danger', onClick: () => deleteRepo(repo) }, t('repoDeleteConfirm'))
                  : h(Btn, { kind: 'danger', onClick: () => setDeleteArm(repo.fullName) }, t('repoDelete')),
                armed ? h(Btn, { onClick: () => setDeleteArm('') }, t('cancel')) : null),

              armed
                ? h('div', { className: 'dsh-push-dangerbox' },
                  h('div', { className: 'dsh-push-error' }, t('repoDeleteWarn')))
                : null)
            : null);
      };

      return h('div', { className: 'dsh-push-root dsh-push-page', style: densityStyle(density) },
        h('div', { className: 'dsh-push-page-head' },
          h('span', { className: 'dsh-push-page-title' }, t('pageTitle')),
          h('span', { className: 'dsh-push-page-spacer' }),
          loggedIn && active
            ? h('span', { className: 'dsh-push-inline' },
              h(Avatar, { url: active.avatarUrl, login: active.login, size: 20 }),
              h('span', { className: 'dsh-push-repo-meta' }, active.login))
            : h('span', { className: 'dsh-push-pill dsh-push-pill--idle' }, t('repoNoLogin')),
          loggedIn
            ? h('select', {
              className: 'dsh-push-select',
              value: activeId || '',
              'aria-label': t('repoSwitchLabel'),
              onChange: (e) => activate(e.target.value),
            }, accounts.map((account) => h('option', { key: account.id, value: account.id }, account.login)))
            : null),

        h('div', { className: 'dsh-push-page-toolbar' },
          h('div', { className: 'dsh-push-search' },
            h(Icon, { name: 'search', size: 13 }),
            h('input', {
              type: 'text',
              value: query,
              placeholder: t('pageSearchPlaceholder'),
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); },
            })),
          h('div', { className: 'dsh-push-seg' },
            h('button', {
              type: 'button',
              className: onlyPrivate ? '' : 'dsh-push-seg-on',
              onClick: () => setOnlyPrivate(false),
            }, t('filterAll')),
            h('button', {
              type: 'button',
              className: onlyPrivate ? 'dsh-push-seg-on' : '',
              onClick: () => setOnlyPrivate(true),
            }, t('filterPrivate'))),
          h(Btn, { onClick: () => { loadState(); loadRepos(1, search); } }, t('refresh'))),

        h('div', { className: 'dsh-push-inline', style: { padding: '0 0 8px' } },
          h(ViewSwitch, {
            mode: viewMode,
            size: cardSize,
            onMode: (next) => { setViewMode(next); writeViewPref('page', next); },
            onSize: (next) => { setCardSize(next); writeViewPref('page.size', next); },
          })),

        h('div', { className: 'dsh-push-page-body' },
          !loggedIn
            ? h('div', { className: 'dsh-push-empty' },
              h(GithubMark, { size: 28 }),
              h('div', { style: { marginTop: '8px' } }, t('repoNoAccount')))
            : loading && repos.length === 0
              ? h('div', { className: 'dsh-push-empty' }, t('loading'))
              : error
                ? h('div', { className: 'dsh-push-empty' }, h('div', { className: 'dsh-push-error' }, error))
                : visibleRepos.length === 0
                  ? h('div', { className: 'dsh-push-empty' }, search ? t('repoEmpty') : t('repoNoRepos'))
                  : (viewMode === 'card'
                    ? h('div', {
                      key: 'page-cards',
                      className: 'dsh-push-repocards'
                        + (cardSize === 'large' ? ' dsh-push-repocards--large' : ''),
                    }, visibleRepos.map((repo) => h(RepoCard, {
                      key: repo.fullName,
                      repo,
                      size: cardSize,
                      languages: languageOf(repo),
                      onOpen: () => setManageRepo(repo),
                      onManage: () => setManageRepo(repo),
                    })))
                    : visibleRepos.map(renderRepo)),

          hasMore
            ? h('div', { style: { padding: '10px 0' } },
              h(Btn, { disabled: loading, onClick: () => loadRepos(page + 1, search) }, t('repoLoadMore')))
            : null),

        /* bottom action row: create / notices */
        h('div', { className: 'dsh-push-page-foot' },
          h('span', { className: 'dsh-push-page-title' }, t('repoNew')),
          h('input', {
            className: 'dsh-push-input',
            type: 'text',
            placeholder: t('repoName'),
            value: form.name,
            style: { width: '150px' },
            disabled: !loggedIn,
            onChange: (e) => setForm(Object.assign({}, form, { name: e.target.value })),
          }),
          h('label', { className: 'dsh-push-inline' },
            h(Switch, {
              checked: form.isPrivate,
              label: t('repoPrivate'),
              onChange: (next) => setForm(Object.assign({}, form, { isPrivate: next })),
            }),
            h('span', { className: 'dsh-push-row-hint' }, t('repoPrivate'))),
          h('input', {
            className: 'dsh-push-input',
            type: 'text',
            placeholder: t('repoDesc'),
            value: form.description,
            style: { width: '200px' },
            disabled: !loggedIn,
            onChange: (e) => setForm(Object.assign({}, form, { description: e.target.value })),
          }),
          h(Btn, { kind: 'primary', disabled: !loggedIn, onClick: createRepo }, t('repoCreate')),
          h('span', { className: 'dsh-push-page-spacer' }),
          notice ? h('span', { className: 'dsh-push-ok' }, notice) : null,
          error ? h('span', { className: 'dsh-push-error', title: error }, error) : null),

        /* management dialog — same component the settings page uses */
        h(RepoManageModal, {
          open: Boolean(manageRepo),
          repo: manageRepo,
          ctx,
          onClose: () => setManageRepo(null),
          onChanged: () => { loadRepos(1, search); },
          onDeleted: () => {
            setManageRepo(null);
            setNotice(t('manageClosed'));
            setExpanded('');
            setDetail(null);
            loadRepos(1, search);
          },
        }));
    }

    /* ─────────────────── C. Git toolbar form panels ─────────────────────── */

    /**
     * 关联远端 — `POST /local/remote`, fed by `GET /local/remotes`.
     *
     * The audit's #1 gap: a clone with no remote had no way back from inside the
     * tab. This covers both directions in one form — pick a GitHub repository
     * (the same RepoPicker the push form uses), which fills the URL field, or
     * paste any https/ssh URL by hand. `name` defaults to `origin` and the
     * host's setRemote is an upsert, so the same form also serves 更换远端.
     */
    function RemoteForm(props) {
      const status = props.status || {};
      const ctx = props.ctx;
      const remotes = Array.isArray(props.remotes) ? props.remotes : [];
      const githubRemote = status.githubRemote || null;

      const [name, setName] = useState(props.initialName || 'origin');
      const [url, setUrl] = useState(props.initialUrl || '');
      const [pick, setPick] = useState(null);
      const [error, setError] = useState('');

      const applyPick = (next) => {
        setPick(next);
        // A GitHub selection IS the URL: the host parses it back into owner/repo.
        if (next && next.target) {
          setUrl('https://github.com/' + next.target.owner + '/' + next.target.repo + '.git');
          setError('');
        }
      };

      const submit = () => {
        const trimmedName = name.trim();
        const trimmedUrl = url.trim();
        if (!trimmedName) { setError(t('remoteNameRequired')); return; }
        if (!trimmedUrl) { setError(t('remoteUrlRequired')); return; }
        setError('');
        props.onRun({ name: trimmedName, url: trimmedUrl });
      };

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('remotePickGithub')),
          h(RepoPicker, {
            ctx,
            remotes,
            value: pick,
            disabled: props.busy,
            onChange: applyPick,
          }),
          h('span', { className: 'dsh-push-hint' }, t('remotePickGithubHint'))),

        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('remoteManual')),
          h('input', {
            className: 'dsh-push-input',
            type: 'text',
            value: url,
            spellCheck: false,
            placeholder: t('remoteUrlPlaceholder'),
            disabled: Boolean(props.busy),
            onChange: (e) => setUrl(e.target.value),
          })),

        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('remoteName')),
          h('input', {
            className: 'dsh-push-input',
            type: 'text',
            value: name,
            spellCheck: false,
            disabled: Boolean(props.busy),
            onChange: (e) => setName(e.target.value),
          })),

        error ? h('div', { className: 'dsh-push-error' }, error) : null,

        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'primary',
            disabled: Boolean(props.busy),
            onClick: submit,
          }, t('remoteSaveAction')),
          h(Btn, { disabled: Boolean(props.busy), onClick: props.onCancel }, t('cancel'))),

        /* The live remote list: the visible answer to "what is linked now?". */
        remotes.length > 0
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('remoteListTitle')),
            h('div', { className: 'dsh-push-files' }, remotes.map((row) => h('div', {
              className: 'dsh-push-filepick',
              key: row.name,
              title: row.url,
            },
              h(Icon, { name: 'branch', size: 11 }),
              h('span', { style: { flex: '0 0 auto' } }, row.name),
              h('span', { className: 'dsh-push-hint', style: { flex: '1 1 auto' } }, row.url || ''),
              githubRemote && githubRemote.name === row.name
                ? h('span', { className: 'dsh-push-pill dsh-push-pill--active' },
                  githubRemote.owner + '/' + githubRemote.repo)
                : null))))
          : null);
    }

    function CommitForm(props) {
      const status = props.status || {};
      const files = status.files || [];
      const [message, setMessage] = useState('');
      const submit = (alsoPush) => {
        if (!message.trim()) { props.onProblem(t('tabMessageRequired')); return; }
        // No file list means nothing is unstaged to choose between: the commit
        // is "stage everything" (`all`), which is also the contract default.
        if (files.length > 0 && props.pickedPaths.length === 0) {
          props.onProblem(t('tabPickAtLeastOne'));
          return;
        }
        const all = files.length === 0 || props.pickedPaths.length === files.length;
        const body = all
          ? { message: message.trim(), all: true }
          : { message: message.trim(), all: false, files: props.pickedPaths };
        props.onSubmit(body, alsoPush);
      };

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabCommitMessage')),
          h('textarea', {
            className: 'dsh-push-textarea',
            placeholder: t('tabCommitMessagePlaceholder'),
            value: message,
            onChange: (e) => setMessage(e.target.value),
          })),
        files.length > 0
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabIncludeFiles')),
            h('div', { className: 'dsh-push-files' }, files.map((file) => h('label', {
              className: 'dsh-push-filepick',
              key: file.path,
              title: file.path,
            },
              h('input', {
                type: 'checkbox',
                className: 'dsh-push-checkbox',
                checked: props.isPicked(file.path),
                onChange: () => props.onTogglePick(file.path),
              }),
              h('span', null, file.path)))))
          : null,
        h('div', { className: 'dsh-push-inline' },
          h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => submit(true) }, t('tabCommitAndPush')),
          h(Btn, { disabled: props.busy, onClick: () => submit(false) }, t('tabCommitOnly'))));
    }

    /**
     * Push form: destination (§3b picker + per-branch memory) + branch + force.
     *
     * The remembered target is NOT a separate control — it is what the picker
     * starts on. `remember: true` is sent on every push so the host refreshes
     * the memory for this branch, and the muted "上次推送到 …" line is re-read
     * from `/push/targets` afterwards (a push that failed must not update it).
     */
/* ══════════════════ pre-push review (CONTRACT §3d) ══════════════════ */

/** Severity to the CSS class that colours its chip. */
const SEVERITY_TONE = {
  blocker: 'dsh-push-sev--blocker',
  high: 'dsh-push-sev--high',
  medium: 'dsh-push-sev--medium',
  low: 'dsh-push-sev--low',
  info: 'dsh-push-sev--info',
};

/** Severity to its localized label key. */
const SEVERITY_LABEL = {
  blocker: 'rvSeverityBlocker',
  high: 'rvSeverityHigh',
  medium: 'rvSeverityMedium',
  low: 'rvSeverityLow',
  info: 'rvSeverityInfo',
};

/** The composite provider+model value used by the model select. */
function providerAndModel(value) {
  if (!value || !value.provider || !value.model) return '';
  return value.provider + '\u0000' + value.model;
}

/** The index of the selected effort, falling back to the model default. */
function effortIndex(efforts, current, model) {
  const wanted = current || (model && model.defaultEffort);
  const found = efforts.findIndex((effort) => effort.id === wanted);
  return found >= 0 ? found : 0;
}

/** The display name of the selected effort. */
function effortName(efforts, current, model) {
  const index = effortIndex(efforts, current, model);
  const effort = efforts[index];
  return effort ? (effort.name || effort.id) : '';
}

/** The effort display name for the confirmation row. */
function effortLabelFor(models, value) {
  const providers = (models && models.providers) || [];
  const provider = providers.find((p) => p.id === value.provider);
  const model = provider && (provider.models || []).find((m) => m.id === value.model);
  const efforts = (model && model.efforts) || [];
  if (efforts.length === 0) return '';
  return effortName(efforts, value.reasoningEffort, model);
}

/** One labelled control row inside the review dialogs. */
/* ═══════════════ repository cards + language bar ═══════════════ */

/* GitHub linguist colours — the ones users already recognise from GitHub. */
const LANG_COLOR_MAP = [
  ['JavaScript', '#F1E05A'],
  ['TypeScript', '#3178C6'],
  ['Python', '#3572A5'],
  ['HTML', '#E34C26'],
  ['CSS', '#563D7C'],
  ['SCSS', '#C6538C'],
  ['Sass', '#A53B70'],
  ['Less', '#1D365D'],
  ['Vue', '#41B883'],
  ['Svelte', '#FF3E00'],
  ['Astro', '#FF5A03'],
  ['Java', '#B07219'],
  ['Kotlin', '#A97BFF'],
  ['Swift', '#F05138'],
  ['Objective-C', '#438EFF'],
  ['C', '#555555'],
  ['C++', '#F34B7D'],
  ['C#', '#178600'],
  ['F#', '#B845FC'],
  ['Go', '#00ADD8'],
  ['Rust', '#DEA584'],
  ['Ruby', '#701516'],
  ['PHP', '#4F5D95'],
  ['Dart', '#00B4AB'],
  ['Scala', '#C22D40'],
  ['Haskell', '#5E5086'],
  ['Elixir', '#6E4A7E'],
  ['Erlang', '#B83998'],
  ['Clojure', '#DB5855'],
  ['Groovy', '#4298B8'],
  ['Lua', '#000080'],
  ['Perl', '#0298C3'],
  ['R', '#198CE7'],
  ['Julia', '#A270BA'],
  ['MATLAB', '#E16737'],
  ['Shell', '#89E051'],
  ['PowerShell', '#012456'],
  ['Batchfile', '#C1F12E'],
  ['Assembly', '#6E4C13'],
  ['Zig', '#EC915C'],
  ['Nim', '#FFC200'],
  ['OCaml', '#3BE133'],
  ['Solidity', '#AA6746'],
  ['GDScript', '#355570'],
  ['Vim Script', '#199F4B'],
  ['Emacs Lisp', '#C065DB'],
  ['Makefile', '#427819'],
  ['Dockerfile', '#384D54'],
  ['CMake', '#DA3434'],
  ['Nix', '#7E7EFF'],
  ['Jupyter Notebook', '#DA5B0B'],
  ['Markdown', '#083FA1'],
  ['MDX', '#FCB32C'],
  ['TeX', '#3D6117'],
  ['JSON', '#292929'],
  ['YAML', '#CB171E'],
  ['TOML', '#9C4221'],
  ['SQL', '#E38C00'],
  ['GraphQL', '#E10098'],
  ['Protocol Buffer', '#B7D8EC'],
  ['Thrift', '#D12127'],
  ['HCL', '#844FBA'],
  ['V', '#4F87C4'],
  ['Crystal', '#000100'],
  ['D', '#BA595E'],
  ['Racket', '#3C5CAA'],
  ['Scheme', '#1E4AEC'],
  ['Prolog', '#74283C'],
  ['Fortran', '#4D41B1'],
  ['COBOL', '#A8B9CC'],
  ['Pascal', '#E3F171'],
  ['Ada', '#02F88C'],
  ['Verilog', '#B2B7F8'],
  ['VHDL', '#ADB2CB'],
  ['WebAssembly', '#04133B'],
  ['GLSL', '#5686A5'],
  ['ShaderLab', '#222C37'],
];

const LANG_COLORS = new Map(LANG_COLOR_MAP);

/** GitHub's own colours for the languages linguist renders without a marker. */
const LANG_ALIASES = new Map([
  ['js', 'JavaScript'],
  ['ts', 'TypeScript'],
  ['py', 'Python'],
  ['sh', 'Shell'],
  ['bash', 'Shell'],
  ['zsh', 'Shell'],
  ['ps1', 'PowerShell'],
  ['c++', 'C++'],
  ['cpp', 'C++'],
  ['c#', 'C#'],
  ['cs', 'C#'],
  ['objc', 'Objective-C'],
  ['yml', 'YAML'],
  ['md', 'Markdown'],
  ['htm', 'HTML'],
  ['golang', 'Go'],
  ['rs', 'Rust'],
  ['rb', 'Ruby'],
  ['kt', 'Kotlin'],
]);


/**
 * The brand colour of a language, as GitHub shows it.
 *
 * Lookup is BY NAME. An unknown language gets a stable fallback derived from its
 * name (so the same language keeps the same colour across repos), never a
 * position-based one, which is what made every first segment black.
 *
 * @param {string} name language name as GitHub reports it.
 * @returns {string} a CSS colour.
 */
function langColor(name) {
  const raw = String(name ?? '').trim();
  if (raw === '') return FALLBACK_COLORS[0];
  const direct = LANG_COLORS.get(raw);
  if (direct) return direct;
  const alias = LANG_ALIASES.get(raw.toLowerCase());
  if (alias && LANG_COLORS.get(alias)) return LANG_COLORS.get(alias);
  // Case-insensitive match, so "javascript" still lands on JavaScript.
  const lower = raw.toLowerCase();
  for (const [key, value] of LANG_COLOR_MAP) {
    if (key.toLowerCase() === lower) return value;
  }
  // Stable per-name fallback with its own hue: an eight-colour palette made
  // two different unknown languages share a colour inside one bar.
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 62% 52%)`;
}


/**
 * The proportion bar pinned to a card's bottom edge.
 *
 * Rendered as one flex row of percentage-sized segments rather than an SVG: it
 * reflows with the card, needs no measurement, and each segment can carry its
 * own tooltip. Languages beyond the sixth are folded into one muted "其他"
 * segment so a repo with many languages does not turn into confetti.
 */
function LanguageBar(props) {
  const items = Array.isArray(props.items) ? props.items : [];
  if (items.length === 0) {
    return h('div', { className: 'dsh-push-langbar dsh-push-langbar--empty' });
  }
  const head = items.slice(0, 6);
  const rest = items.slice(6);
  const restPercent = rest.reduce((sum, item) => sum + (Number(item.percent) || 0), 0);

  return h('div', {
    className: 'dsh-push-langbar',
    title: items.map((item) => `${item.name} ${item.percent}%`).join('\n'),
  },
    head.map((item, index) => h('span', {
      key: item.name,
      className: 'dsh-push-langseg',
      // The language's OWN colour. A literal hex is correct here: these are
      // identity colours (like an avatar), not theme colours, and they must
      // match what GitHub shows for the same language.
      style: {
        width: String(Math.max(0.5, Number(item.percent) || 0)) + '%',
        background: langColor(item.name),
      },
      title: `${item.name} ${item.percent}%`,
    })),
    rest.length > 0
      ? h('span', {
        className: 'dsh-push-langseg dsh-push-langseg--rest',
        // The folded tail is intentionally neutral: it is not a language.
        style: { width: String(Math.max(0.5, restPercent)) + '%', background: 'var(--dsw-alias-border-l2)' },
        title: rest.map((item) => `${item.name} ${item.percent}%`).join('\n'),
      })
      : null);
}

/** The legend under/next to a bar: at most three names, then "+N". */
function LanguageLegend(props) {
  const items = Array.isArray(props.items) ? props.items : [];
  if (items.length === 0) return null;
  const head = items.slice(0, 3);
  return h('div', { className: 'dsh-push-langlegend' },
    head.map((item, index) => h('span', { key: item.name, className: 'dsh-push-langlegend-item' },
      h('span', {
        className: 'dsh-push-langdot',
        style: { background: langColor(item.name) },
      }),
      h('span', null, item.name + ' ' + item.percent + '%'))),
    items.length > 3
      ? h('span', { className: 'dsh-push-langlegend-item dsh-push-rv-muted' },
        '+' + (items.length - 3))
      : null);
}

/**
 * A compact list/card view switch with a size option.
 *
 * `mode` is 'list' | 'card'; `size` is 'small' | 'large' and only applies to
 * cards, so it is hidden in list mode rather than shown disabled — a control
 * that does nothing is worse than no control.
 */
function ViewSwitch(props) {
  return h('div', { className: 'dsh-push-viewswitch' },
    h(Segmented, {
      value: props.mode,
      onChange: props.onMode,
      options: [
        { value: 'list', label: t('viewList') },
        { value: 'card', label: t('viewCard') },
      ],
    }),
    props.mode === 'card'
      ? h(Segmented, {
        value: props.size,
        onChange: props.onSize,
        options: [
          { value: 'small', label: t('viewSizeSmall') },
          { value: 'large', label: t('viewSizeLarge') },
        ],
      })
      : null);
}

/**
 * One repository card.
 *
 * The card exists to show, without expanding anything, what the list view
 * hides: the description, the default branch, the language mix, and the two
 * jump actions. Every card is the same height (a fixed min-height plus a
 * two-line description clamp) so a grid of them stays aligned — ragged cards
 * are the fastest way to make this look unfinished.
 */
/* ══════════ view preferences + language cache ══════════ */

/**
 * Remember the list/card choice per surface.
 *
 * Stored on the client (localStorage) rather than the Host: this is a display
 * preference of THIS browser, not plugin state, and it must not cost a round
 * trip or leak between machines. Every access is guarded because a sandboxed or
 * private-mode document can throw on storage access.
 *
 * @param {string} key surface key, e.g. 'section' or 'page'.
 * @param {string} fallback value to use when nothing is stored.
 * @returns {string}
 */
function readViewPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem('dsh-push.view.' + key);
    return typeof raw === 'string' && raw !== '' ? raw : fallback;
  } catch (error) {
    return fallback;
  }
}

/** Store one view preference; failures are ignored by design. */
function writeViewPref(key, value) {
  try {
    window.localStorage.setItem('dsh-push.view.' + key, String(value));
  } catch (error) {
    /* storage may be unavailable; the in-memory state still works */
  }
}

/**
 * Language breakdown cache, keyed by owner/name.
 *
 * The list payload carries only the PRIMARY language, but a card needs the
 * proportions, which is a separate request per repository. Caching keeps
 * re-render from re-fetching, and an in-flight map keeps two cards (or a
 * card and the modal) from asking twice for the same repo.
 */
const languageCache = new Map();
const languagePending = new Map();

/**
 * Read the cached language breakdown for a repo.
 * @param {object} repo
 * @returns {object[]}
 */
function languageOf(repo) {
  if (!repo || !repo.fullName) return [];
  return languageCache.get(repo.fullName) || [];
}

/**
 * Fill the language cache for the repos currently on screen.
 *
 * Failures are swallowed ON PURPOSE: a repository whose languages cannot be
 * read still belongs in the list, and its card simply renders without the bar.
 * Requesting only the visible slice keeps a 50-repo page from firing 50 calls.
 *
 * @param {object} ctx client context.
 * @param {object[]} repos
 * @returns {Promise<void>}
 */
async function prefetchLanguages(ctx, repos) {
  const targets = (repos || []).filter((repo) => repo && repo.fullName
    && !languageCache.has(repo.fullName) && !languagePending.has(repo.fullName));
  await Promise.all(targets.map(async (repo) => {
    const key = repo.fullName;
    const pending = (async () => {
      try {
        const data = await api(ctx, API + '/repos/languages?owner='
          + encodeURIComponent(repo.owner) + '&name=' + encodeURIComponent(repo.name));
        languageCache.set(key, (data && data.items) || []);
      } catch (error) {
        // Remember the failure as "no data" so a broken token does not retry
        // on every render.
        languageCache.set(key, []);
      } finally {
        languagePending.delete(key);
      }
    })();
    languagePending.set(key, pending);
  }));
  await Promise.all([...languagePending.values()]);
}

/**
 * Star / fork / issue counts, icon then number, on one horizontal line.
 *
 * One component for both surfaces: the list and the card must not drift
 * into showing different numbers or different shapes for the same repo.
 *
 * @param {{repo: object, size?: number, className?: string}} props
 */
function RepoMetrics(props) {
  const repo = props.repo ?? {};
  const size = props.size ?? 11;
  return h('span', { className: props.className || 'dsh-push-repocard-stats' },
    h('span', { className: 'dsh-push-metric', title: t('statStars') },
      h(Icon, { name: 'star', size }),
      h('span', { className: 'dsh-push-metric-n' }, String(repo.stars || 0))),
    h('span', { className: 'dsh-push-metric', title: t('statForks') },
      h(Icon, { name: 'fork', size }),
      h('span', { className: 'dsh-push-metric-n' }, String(repo.forks || 0))),
    h('span', { className: 'dsh-push-metric', title: t('statIssues') },
      h(Icon, { name: 'issue', size }),
      h('span', { className: 'dsh-push-metric-n' }, String(repo.openIssues || 0))));
}

function RepoCard(props) {
  const repo = props.repo;
  const large = props.size === 'large';
  return h('div', {
    className: 'dsh-push-repocard' + (large ? ' dsh-push-repocard--large' : ''),
    // The whole card is the click target; the name button and the external
    // link stop propagation so they keep their own meaning.
    role: 'button',
    tabIndex: 0,
    onClick: () => props.onOpen(repo),
    onKeyDown: (event) => {
      if (event && (event.key === 'Enter' || event.key === ' ')) {
        if (event.preventDefault) event.preventDefault();
        props.onOpen(repo);
      }
    },
  },
    h('div', { className: 'dsh-push-repocard-body' },
      h('div', { className: 'dsh-push-repocard-head' },
        h('button', {
          type: 'button',
          className: 'dsh-push-repocard-name',
          title: repo.fullName,
          onClick: (event) => {
            if (event && event.stopPropagation) event.stopPropagation();
            props.onOpen(repo);
          },
        }, repo.fullName),
        repo.private
          ? h('span', { className: 'dsh-push-pill' }, t('repoPrivateBadge'))
          : h('span', { className: 'dsh-push-pill' }, t('repoPublicBadge'))),

      /* Branch + updated time: a fixed header line, above the scroller. */
      h('div', { className: 'dsh-push-repocard-meta' },
        h('span', { className: 'dsh-push-repocard-branch' },
          h(Icon, { name: 'branch', size: 11 }),
          h('span', null, repo.defaultBranch || '—')),
        h('span', { className: 'dsh-push-rv-muted' }, relativeTime(repo.updatedAt))),

      /* The description is its own scroll region: a long one must neither
         stretch the card nor push the metrics out of line. */
      h('div', { className: 'dsh-push-repocard-descscroll' },
        h('div', { className: 'dsh-push-repocard-desc' },
          repo.description || t('repoNoDescription'))),

      /* Counts sit OUTSIDE the scroller, so they stay on a straight line
         across every card regardless of how long a description is. */
      h(RepoMetrics, { repo, size: large ? 12 : 11 }),

      large
        ? h(LanguageLegend, { items: props.languages })
        : null),

    h('div', { className: 'dsh-push-repocard-actions' },
      h(Btn, {
        mini: true,
        onClick: (event) => {
          if (event && event.stopPropagation) event.stopPropagation();
          props.onManage(repo);
        },
      }, t('manageOpen')),
      h('a', {
        className: 'dsh-push-btn dsh-push-btn--mini',
        href: repo.htmlUrl,
        target: '_blank',
        rel: 'noreferrer',
        onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); },
      }, h(Icon, { name: 'external', size: 11 }), t('repoOpen'))),

    /* The bar is pinned to the bottom edge, inside the card's own border. */
    h(LanguageBar, { items: props.languages }));
}


function ReviewField(props) {
  return h('div', { className: 'dsh-push-rv-field' },
    h('span', { className: 'dsh-push-rv-field-label' }, props.label),
    h('div', { className: 'dsh-push-rv-field-body' }, props.children));
}

/**
 * Model + reasoning-effort picker.
 *
 * Data comes from GET /review/models, which the Host enumerates through the
 * llm service, so this control always offers exactly what this host can run.
 * When the host has no model configuration the control says so and the review
 * falls back to its rule pass.
 */
function ModelPicker(props) {
  const models = props.models || { providers: [], default: null };
  const value = props.value || {};
  const providers = models.providers || [];

  const currentProvider = providers.find((p) => p.id === value.provider);
  const currentModel = currentProvider
    ? (currentProvider.models || []).find((m) => m.id === value.model)
    : null;
  const efforts = (currentModel && currentModel.efforts) || [];
  const showEffort = efforts.length > 0;

  if (providers.length === 0) {
    return h('span', { className: 'dsh-push-rv-muted' }, t('rvNoModels'));
  }

  return h('div', { className: 'dsh-push-rv-model' },
    h('select', {
      className: 'dsh-push-select dsh-push-rv-select',
      value: providerAndModel(value),
      onChange: (event) => {
        const parts = String(event.target.value).split('\u0000');
        const provider = providers.find((p) => p.id === parts[0]);
        const model = provider && (provider.models || []).find((m) => m.id === parts[1]);
        props.onChange({
          provider: parts[0],
          model: parts[1],
          reasoningEffort: (model && model.defaultEffort) || '',
        });
      },
    }, providers.flatMap((provider) => (provider.models || []).map((model) => h('option', {
      key: provider.id + '\u0000' + model.id,
      value: provider.id + '\u0000' + model.id,
    }, (provider.name || provider.id) + ' / ' + (model.name || model.id))))),
    showEffort
      ? (efforts.length >= 3
        // A slider reads better than a short ordered list of efforts, which is
        // exactly what a reasoning scale is.
        ? h('div', { className: 'dsh-push-rv-effort' },
          h('input', {
            className: 'dsh-push-rv-slider',
            type: 'range',
            min: 0,
            max: efforts.length - 1,
            step: 1,
            value: String(effortIndex(efforts, value.reasoningEffort, currentModel)),
            onChange: (event) => {
              const effort = efforts[Number(event.target.value)];
              if (effort) props.onChange({ ...value, reasoningEffort: effort.id });
            },
          }),
          h('span', { className: 'dsh-push-rv-effort-label' },
            effortName(efforts, value.reasoningEffort, currentModel)))
        : h('select', {
          className: 'dsh-push-select dsh-push-rv-select',
          value: value.reasoningEffort || '',
          onChange: (event) => props.onChange({ ...value, reasoningEffort: event.target.value }),
        }, efforts.map((effort) => h('option', {
          key: effort.id,
          value: effort.id,
        }, effort.name || effort.id))))
      : null);
}

/**
 * The two-step review flow.
 *
 * Step 1 configures (presets, model, custom prompt); step 2 confirms and runs.
 * They are separate screens rather than one long form because the confirmation
 * is the user's last chance to see WHICH model will read their code and WHICH
 * files it will see.
 */
function ReviewDialog(props) {
  const ctx = props.ctx;
  const [step, setStep] = useState('configure');
  const [presets, setPresets] = useState({ builtin: [], custom: [], categories: [] });
  const [models, setModels] = useState({ providers: [], default: null });
  const [picked, setPicked] = useState({});
  const [customPrompt, setCustomPrompt] = useState('');
  const [modelValue, setModelValue] = useState({ provider: '', model: '', reasoningEffort: '' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stagedOnly, setStagedOnly] = useState(false);
  const [maxFiles, setMaxFiles] = useState(60);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filesOpen, setFilesOpen] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Load the catalog once per open. A failure here is not fatal: the custom
  // prompt alone is still a valid review.
  useEffect(() => {
    if (!props.open) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await api(ctx, API + '/review/presets');
        if (cancelled || !aliveRef.current) return;
        setPresets({
          builtin: (data && data.builtin) || [],
          custom: (data && data.custom) || [],
          categories: (data && data.categories) || [],
        });
      } catch (err) {
        if (!cancelled && aliveRef.current) setError(err.message);
      }
      try {
        const data = await api(ctx, API + '/review/models');
        if (cancelled || !aliveRef.current) return;
        const list = data || { providers: [], default: null };
        setModels(list);
        const def = list.default;
        const provider = def ? def.provider : '';
        const model = def ? def.model : '';
        let effort = '';
        const group = (list.providers || []).find((p) => p.id === provider);
        const entry = group && (group.models || []).find((m) => m.id === model);
        if (entry && entry.defaultEffort) effort = entry.defaultEffort;
        setModelValue({ provider, model, reasoningEffort: effort });
      } catch {
        // The picker renders its own "no model" state.
      }
    })();
    return () => { cancelled = true; };
  }, [props.open, ctx]);

  // An agent-initiated request arrives with a path and proposed items; seed
  // the form from it so confirming is a single click. Declared BEFORE the
  // catalog load so `picked` is ready by the time the cards render.
  useEffect(() => {
    if (!props.open) return;
    const pending = props.pending;
    if (!pending) return;
    const next = {};
    for (const id of (pending.presetIds || [])) next[id] = true;
    setPicked(next);
    if (typeof pending.customPrompt === 'string') setCustomPrompt(pending.customPrompt);
    // A request always starts at the configuration step: the user must see
    // and confirm the choices.
    setStep('configure');
    setResult(null);
  }, [props.open, props.pending]);

  useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => { if (aliveRef.current) setNotice(''); }, 3000);
    return () => clearTimeout(id);
  }, [notice]);

  const allPresets = [...presets.builtin, ...presets.custom];
  const selectedIds = allPresets.filter((preset) => picked[preset.id]).map((preset) => preset.id);
  const hasSelection = selectedIds.length > 0 || customPrompt.trim() !== '';

  const togglePreset = (id) => {
    setPicked((previous) => ({ ...previous, [id]: !previous[id] }));
  };

  const savePreset = async () => {
    const title = saveTitle.trim();
    const prompt = customPrompt.trim();
    if (title === '' || prompt === '') return;
    try {
      const data = await api(ctx, API + '/review/presets', {
        method: 'POST',
        body: { title, prompt, category: 'custom' },
      });
      if (!aliveRef.current) return;
      setSaveOpen(false);
      setSaveTitle('');
      setNotice(t('rvPresetSaved'));
      const preset = data && data.preset;
      if (preset) {
        setPresets((previous) => ({ ...previous, custom: [...previous.custom, preset] }));
        setPicked((previous) => ({ ...previous, [preset.id]: true }));
      }
    } catch (err) {
      if (aliveRef.current) setError(err.message);
    }
  };

  const deletePreset = async (id) => {
    try {
      await api(ctx, API + '/review/presets/delete', { method: 'POST', body: { id } });
      if (!aliveRef.current) return;
      setPresets((previous) => ({
        ...previous,
        custom: previous.custom.filter((preset) => preset.id !== id),
      }));
    } catch (err) {
      if (aliveRef.current) setError(err.message);
    }
  };

  const run = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    setStep('running');
    try {
      const data = await api(ctx, API + '/review/run', {
        method: 'POST',
        body: {
          path: props.path,
          presetIds: selectedIds,
          customPrompt: customPrompt.trim(),
          provider: modelValue.provider,
          model: modelValue.model,
          reasoningEffort: modelValue.reasoningEffort || undefined,
          staged: stagedOnly,
          maxFiles,
        },
      });
      if (!aliveRef.current) return;
      setResult(data);
      setStep('result');
      if (props.onReviewed) props.onReviewed(data);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message);
      setStep('confirm');
    } finally {
      if (aliveRef.current) setRunning(false);
    }
  };

  /**
   * The files the confirmation screen advertises.
   *
   * The authoritative list only exists after the Host collects the diff, so
   * this is the caller's best estimate from the status it already has; the
   * wording says so for exactly that reason.
   */
  const estimatedFiles = (props.status && Array.isArray(props.status.files)
    ? props.status.files.filter((file) => (stagedOnly ? file.staged : true))
    : []);

  /* ---------------- screen 1: configure ---------------- */
  const configureBody = [
    h('div', { className: 'dsh-push-rv-head', key: 'head' },
      h('span', { className: 'dsh-push-rv-title' }, t('rvTitle')),
      // A dialog that opened by itself must say why. Computed inline on
      // purpose: a component-local flag was once declared in ANOTHER
      // component by mistake, and the resulting ReferenceError stopped the
      // whole sidebar from opening.
      (props.pending && props.pending.source === 'agent')
        ? h('span', { className: 'dsh-push-rv-agenttag', title: t('rvAgentAskedHint') },
          t('rvAgentAsked'))
        : null,
      h('span', { className: 'dsh-push-rv-spacer' }),
      h('button', {
        type: 'button',
        className: 'dsh-push-iconbtn' + (settingsOpen ? ' is-on' : ''),
        title: t('rvSettings'),
        'aria-label': t('rvSettings'),
        onClick: () => setSettingsOpen((v) => !v),
      }, h(Icon, { name: 'gear', size: 14 })),
      h('button', {
        type: 'button',
        className: 'dsh-push-iconbtn',
        title: t('rvClose'),
        'aria-label': t('rvClose'),
        onClick: props.onClose,
      }, h(Icon, { name: 'close', size: 13 }))),

    h('div', { className: 'dsh-push-rv-sub', key: 'model' },
      h('span', { className: 'dsh-push-rv-sub-label' }, t('rvModel')),
      h(ModelPicker, { models, value: modelValue, onChange: setModelValue })),

    settingsOpen
      ? h('div', { className: 'dsh-push-rv-settings', key: 'settings' },
        h(ReviewField, { label: t('rvStagedOnly') },
          h(Switch, { checked: stagedOnly, label: t('rvStagedOnly'), onChange: setStagedOnly })),
        h(ReviewField, { label: t('rvMaxFiles') },
          h('input', {
            className: 'dsh-push-input dsh-push-rv-number',
            type: 'number',
            min: 1,
            max: 500,
            value: String(maxFiles),
            onChange: (event) => {
              const next = Number(event.target.value);
              setMaxFiles(Number.isFinite(next) && next > 0 ? Math.trunc(next) : 60);
            },
          })))
      : null,

    h('div', { className: 'dsh-push-rv-divider', key: 'd1' }),

    // The ONLY scrolling region: presets can be numerous, so everything else
    // stays put and the footer is always reachable.
    h('div', { className: 'dsh-push-rv-scroll', key: 'presets' },
      presets.categories.map((category) => {
        const inCategory = allPresets.filter((preset) => preset.category === category.id);
        if (inCategory.length === 0) return null;
        return h('div', { className: 'dsh-push-rv-group', key: category.id },
          h('div', { className: 'dsh-push-rv-group-head' }, category.label),
          h('div', { className: 'dsh-push-rv-cards' }, inCategory.map((preset) => {
            const on = Boolean(picked[preset.id]);
            return h('button', {
              key: preset.id,
              type: 'button',
              className: 'dsh-push-rv-card' + (on ? ' is-on' : ''),
              'aria-pressed': on ? 'true' : 'false',
              onClick: () => togglePreset(preset.id),
            },
              h('span', { className: 'dsh-push-rv-card-check' },
                on ? h(Icon, { name: 'check', size: 11 }) : null),
              h('span', { className: 'dsh-push-rv-card-main' },
                h('span', { className: 'dsh-push-rv-card-title' }, preset.title),
                h('span', { className: 'dsh-push-rv-card-desc' }, preset.description)),
              preset.builtin
                ? null
                : h('span', {
                  className: 'dsh-push-rv-card-del',
                  role: 'button',
                  tabIndex: 0,
                  title: t('rvDeletePreset'),
                  onClick: (event) => {
                    event.stopPropagation();
                    deletePreset(preset.id);
                  },
                }, h(Icon, { name: 'close', size: 10 })));
          })));
      })),

    h('div', { className: 'dsh-push-rv-divider', key: 'd2' }),

    h('div', { className: 'dsh-push-rv-custom', key: 'custom' },
      h('div', { className: 'dsh-push-rv-custom-head' },
        h('span', null, t('rvCustomPrompt')),
        saveOpen
          ? h('div', { className: 'dsh-push-rv-inline' },
            h('input', {
              className: 'dsh-push-input dsh-push-rv-number',
              type: 'text',
              placeholder: t('rvSavePresetTitle'),
              value: saveTitle,
              onChange: (event) => setSaveTitle(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') savePreset(); },
            }),
            h(Btn, { kind: 'primary', mini: true, onClick: savePreset }, t('rvSave')),
            h(Btn, { mini: true, onClick: () => setSaveOpen(false) }, t('rvCancel')))
          : h(Btn, {
            mini: true,
            disabled: customPrompt.trim() === '',
            onClick: () => setSaveOpen(true),
          }, t('rvSavePreset'))),
      h('textarea', {
        className: 'dsh-push-rv-textarea',
        placeholder: t('rvCustomPlaceholder'),
        value: customPrompt,
        onChange: (event) => setCustomPrompt(event.target.value),
      })),

    error ? h('div', { className: 'dsh-push-error dsh-push-rv-error', key: 'err' }, error) : null,
    notice ? h('div', { className: 'dsh-push-ok dsh-push-rv-error', key: 'notice' }, notice) : null,
  ];

  const configureFooter = [
    h('span', { className: 'dsh-push-rv-muted', key: 'count' },
      selectedIds.length > 0
        ? t('rvSelected', { n: selectedIds.length })
        : t('rvSelectionEmpty')),
    h('span', { className: 'dsh-push-rv-spacer', key: 'spacer' }),
    h(Btn, { key: 'cancel', onClick: props.onClose }, t('rvCancel')),
    h(Btn, {
      key: 'next',
      kind: 'primary',
      disabled: !hasSelection,
      onClick: () => { setStep('confirm'); setResult(null); },
    }, t('rvNext')),
  ];

  /* ---------------- screen 2: confirm ---------------- */
  const confirmBody = [
    h('div', { className: 'dsh-push-rv-head', key: 'head' },
      h('span', { className: 'dsh-push-rv-title' }, t('rvConfirmTitle')),
      h('span', { className: 'dsh-push-rv-spacer' }),
      h('button', {
        type: 'button',
        className: 'dsh-push-iconbtn',
        title: t('rvClose'),
        'aria-label': t('rvClose'),
        onClick: props.onClose,
      }, h(Icon, { name: 'close', size: 13 }))),

    h('div', { className: 'dsh-push-rv-confirm', key: 'body' },
      h(ReviewField, { label: t('rvConfirmModel') },
        h(ModelPicker, { models, value: modelValue, onChange: setModelValue })),

      h(ReviewField, { label: t('rvConfirmEffort') },
        h('span', { className: 'dsh-push-rv-muted' },
          effortLabelFor(models, modelValue) || t('rvEffortDefault'))),

      h('div', { className: 'dsh-push-rv-files' },
        h('button', {
          type: 'button',
          className: 'dsh-push-rv-files-head',
          onClick: () => setFilesOpen((v) => !v),
        },
          h(Icon, { name: 'chevron', size: 11 }),
          h('span', null, t('rvConfirmFiles', { n: estimatedFiles.length })),
          h('span', { className: 'dsh-push-rv-muted' }, ' (' + t('rvConfirmFilesHint') + ')')),
        filesOpen
          ? h('div', { className: 'dsh-push-rv-filelist' },
            estimatedFiles.length === 0
              ? h('div', { className: 'dsh-push-rv-muted' }, t('rvNoFindings'))
              : estimatedFiles.map((file) => h('div', {
                key: file.path,
                className: 'dsh-push-rv-filerow',
              },
                h('span', { className: 'dsh-push-rv-filename' }, file.path),
                h('span', { className: 'dsh-push-rv-muted' },
                  ' +' + (file.additions || 0) + ' -' + (file.deletions || 0)))))
          : null),

      h(ReviewField, { label: t('rvConfirmFeatures') },
        h('div', { className: 'dsh-push-rv-chips' },
          selectedIds.length === 0 && customPrompt.trim() === ''
            ? h('span', { className: 'dsh-push-rv-muted' }, t('rvSelectionEmpty'))
            : [
              ...allPresets
                .filter((preset) => picked[preset.id])
                .map((preset) => h('span', {
                  key: preset.id,
                  className: 'dsh-push-pill',
                }, preset.title)),
              customPrompt.trim() === ''
                ? null
                : h('span', { key: 'custom', className: 'dsh-push-pill dsh-push-pill--active' },
                  t('rvConfirmCustomChip')),
            ]))),

    error ? h('div', { className: 'dsh-push-error dsh-push-rv-error', key: 'err' }, error) : null,
  ];

  const confirmFooter = [
    h(Btn, { key: 'back', onClick: () => setStep('configure') }, t('rvBack')),
    h('span', { className: 'dsh-push-rv-spacer', key: 'spacer' }),
    running
      ? h('span', { className: 'dsh-push-rv-muted', key: 'running' },
        t('rvRunningWith', { model: modelValue.model || t('rvNoModels') }))
      : h(Btn, { key: 'start', kind: 'primary', onClick: run }, t('rvStart')),
  ];

  /* ---------------- screen 3: result ---------------- */
  const findings = (result && result.findings) || [];
  const resultBody = [
    h('div', { className: 'dsh-push-rv-head', key: 'head' },
      h('span', { className: 'dsh-push-rv-title' }, t('rvResult')),
      h('span', { className: 'dsh-push-rv-spacer' }),
      h('button', {
        type: 'button',
        className: 'dsh-push-iconbtn',
        title: t('rvClose'),
        'aria-label': t('rvClose'),
        onClick: props.onClose,
      }, h(Icon, { name: 'close', size: 13 }))),

    h('div', { className: 'dsh-push-rv-result', key: 'body' },
      h('p', { className: 'dsh-push-rv-summary' }, (result && result.summary) || ''),
      result && result.degraded
        ? h('div', { className: 'dsh-push-rv-muted' }, t('rvDegraded'))
        : null,
      result && result.truncated
        ? h('div', { className: 'dsh-push-rv-muted' }, t('rvTruncated'))
        : null,
      findings.length === 0
        ? h('div', { className: 'dsh-push-rv-empty' }, t('rvNoFindings'))
        : h('div', { className: 'dsh-push-rv-findings' }, findings.map((finding, index) => h('div', {
          key: index,
          className: 'dsh-push-rv-finding ' + (SEVERITY_TONE[finding.severity] || ''),
        },
          h('div', { className: 'dsh-push-rv-finding-head' },
            h('span', { className: 'dsh-push-rv-sev' },
              t(SEVERITY_LABEL[finding.severity] || 'rvSeverityInfo')),
            h('span', { className: 'dsh-push-rv-finding-title' }, finding.title),
            finding.file
              ? h('span', { className: 'dsh-push-rv-muted dsh-push-rv-loc' },
                finding.file + (finding.line ? ':' + finding.line : ''))
              : null),
          finding.detail ? h('div', { className: 'dsh-push-rv-finding-detail' }, finding.detail) : null,
          finding.suggestion
            ? h('div', { className: 'dsh-push-rv-finding-sug' }, finding.suggestion)
            : null)))),
  ];

  return h(Modal, {
    open: props.open,
    onClose: props.onClose,
    // The dialogs render their own header (title + gear + close), so the shell's
    // title bar is suppressed.
    bare: true,
    wide: true,
    footer: step === 'configure'
      ? configureFooter
      : step === 'result'
        ? [
          h(Btn, { key: 'again', onClick: () => { setStep('confirm'); setResult(null); } }, t('rvRerun')),
          h('span', { className: 'dsh-push-rv-spacer', key: 'spacer' }),
          h(Btn, { key: 'done', kind: 'primary', onClick: props.onClose }, t('rvDone')),
        ]
        : confirmFooter,
  }, step === 'configure' ? configureBody : (step === 'result' ? resultBody : confirmBody));
}


    function PushForm(props) {
      const ctx = props.ctx;
      const status = props.status || {};
      const statusRemotes = status.remotes || [];

      const [targets, setTargets] = useState(null);
      const [selection, setSelection] = useState(null);
      const [branch, setBranch] = useState(status.branch || '');
      const [force, setForce] = useState(false);
      const [targetsError, setTargetsError] = useState('');
      const [seeded, setSeeded] = useState(false);
      // Which VERSION leaves the repository: the current branch (default), a
      // specific commit, or a specific tag. The commit field is free text so
      // any sha can be typed, not only the sixty the graph happened to load.
      const [versionSource, setVersionSource] = useState(
        props.initialSource && props.initialSource.kind ? props.initialSource.kind : 'branch',
      );
      const [commitSource, setCommitSource] = useState(
        props.initialSource && props.initialSource.kind === 'commit'
          ? props.initialSource.value || ''
          : '',
      );
      const [tagSource, setTagSource] = useState(
        props.initialSource && props.initialSource.kind === 'tag'
          ? props.initialSource.value || ''
          : '',
      );

      const aliveRef = useRef(true);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const loadTargets = useCallback(async () => {
        if (!props.cwd) return;
        try {
          const data = await api(ctx, API + '/push/targets?path=' + encodeURIComponent(props.cwd));
          if (!aliveRef.current) return;
          setTargets(data || null);
          setTargetsError('');
        } catch (err) {
          if (!aliveRef.current) return;
          setTargetsError(err.message);
        }
      }, [ctx, props.cwd]);

      useEffect(() => { loadTargets(); }, [loadTargets]);

      // Seed the destination ONCE from the branch memory. A later refresh (after
      // a successful push) must not override a selection the user has since
      // changed — the memory line alone is allowed to update.
      useEffect(() => {
        if (seeded || !targets) return;
        const memory = targets.memory;
        if (!memory || !memory.owner || !memory.repo) {
          setSeeded(true);
          return;
        }
        setSeeded(true);
        if (memory.remote) setSelection({ remote: memory.remote });
        else setSelection({ target: { owner: memory.owner, repo: memory.repo } });
      }, [targets, seeded]);

      // The branch memory is per local branch: following the status keeps the
      // form in step when the user checks out another branch while it is open.
      useEffect(() => {
        if (typeof status.branch === 'string' && status.branch) setBranch(status.branch);
      }, [status.branch]);

      const remotes = (targets && Array.isArray(targets.remotes) && targets.remotes.length > 0)
        ? targets.remotes
        : statusRemotes.map((row) => ({
          name: row.name,
          url: row.url,
          owner: null,
          repo: null,
        }));

      const memory = targets ? targets.memory : null;
      const memoryName = memory && memory.owner && memory.repo
        ? memory.owner + '/' + memory.repo
        : '';

      /* ── 版本来源: which VERSION leaves the repository ──
       *
       * git accepts a branch, a tag or a commit as the SOURCE of a refspec, but
       * only a branch can lean on the remote's configured merge ref. A sha or a
       * tag therefore needs the destination branch spelled out — `git push
       * origin <sha>` is refused outright — which is why 目标分支 turns
       * required the moment this is not 当前分支. */
      const fixedSource = versionSource === 'commit'
        ? commitSource.trim()
        : (versionSource === 'tag' ? tagSource.trim() : '');
      const needsTarget = versionSource !== 'branch';
      const targetBranch = branch.trim();
      const versionReady = !needsTarget || (fixedSource !== '' && targetBranch !== '');
      const destinationLabel = selection && selection.remote
        ? selection.remote
        : (remotes[0] && remotes[0].name ? remotes[0].name : 'origin');
      const sourceLabel = needsTarget
        ? fixedSource
        : (targetBranch || (status.branch || ''));
      const commitRows = Array.isArray(props.commits) ? props.commits : [];
      const tagList = Array.isArray(status.tags) ? status.tags : [];

      const submit = async () => {
        if (!versionReady) {
          props.onProblem(needsTarget && !fixedSource
            ? t('pushSourceRequired')
            : t('pushTargetBranchRequired'));
          return;
        }
        const body = {
          force,
          tags: false,
          // §3b: the host writes the memory only after a successful push.
          remember: true,
        };
        if (targetBranch) body.branch = targetBranch;
        // `source` is OMITTED for 当前分支: the host then pushes the branch
        // itself, exactly as it always has. Naming it would turn the historical
        // implicit refspec into an explicit src:dst.
        if (needsTarget) body.source = fixedSource;
        if (selection && selection.target) body.target = selection.target;
        else if (selection && selection.remote) body.remote = selection.remote;
        else if (remotes.length > 0) body.remote = remotes[0].name;

        const data = await props.onRun(body);
        if (data) await loadTargets();
      };

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('pickerTarget')),
          h(RepoPicker, {
            ctx,
            remotes,
            value: selection,
            disabled: props.busy,
            onChange: setSelection,
          }),
          memory && memoryName
            ? h('span', { className: 'dsh-push-memory', title: memory.at || '' },
              t('pickerMemory', { name: memoryName })
              + (memory.at ? ' · ' + relativeTime(memory.at) : ''),
              h(Btn, {
                mini: true,
                disabled: props.busy,
                title: t('pushForgetMemoryHint'),
                onClick: (event) => {
                  if (event && event.stopPropagation) event.stopPropagation();
                  if (props.onForgetMemory) props.onForgetMemory();
                },
              }, t('pushForgetMemory')))
            : null,
          targetsError
            ? h('span', { className: 'dsh-push-error' }, targetsError)
            : (!selection ? h('span', { className: 'dsh-push-memory' }, t('pickerNoTarget')) : null)),

        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('pushVersionSource')),
          h(Segmented, {
            value: versionSource,
            options: [
              { value: 'branch', label: t('pushVersionBranch') },
              { value: 'commit', label: t('pushVersionCommit') },
              { value: 'tag', label: t('pushVersionTag') },
            ],
            onChange: (next) => {
              setVersionSource(next);
              if (next === 'commit' && !commitSource && commitRows.length > 0) {
                setCommitSource(commitRows[0].sha);
              }
            },
          })),

        versionSource === 'commit'
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('pushCommitSearch')),
            h('input', {
              className: 'dsh-push-input', type: 'text', value: commitSource,
              spellCheck: false, disabled: Boolean(props.busy),
              placeholder: t('pushCommitSearch'),
              onChange: (e) => setCommitSource(e.target.value),
            }),
            h('div', { className: 'dsh-push-suggest' },
              commitRows.length === 0
                ? h('div', { className: 'dsh-push-hint', style: { padding: '4px 8px' } },
                  t('pushCommitEmpty'))
                : commitRows.slice(0, 30).map((commit) => h('button', {
                  key: commit.sha,
                  type: 'button',
                  className: 'dsh-push-picker-row'
                    + (commit.sha === commitSource.trim() ? ' is-active' : ''),
                  title: commit.subject,
                  disabled: Boolean(props.busy),
                  onClick: () => setCommitSource(commit.sha),
                },
                  h('span', { className: 'dsh-push-mono dsh-push-hint' }, commit.shortSha || ''),
                  h('span', { className: 'dsh-push-picker-row-name' }, commit.subject || ''),
                  commit.refs && commit.refs.length > 0
                    ? h('span', { className: 'dsh-push-pill' }, commit.refs[0])
                    : null))))
          : null,

        versionSource === 'tag'
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('pushTagPick')),
            h('select', {
              className: 'dsh-push-select', value: tagSource,
              disabled: Boolean(props.busy) || undefined,
              onChange: (e) => setTagSource(e.target.value),
            },
              h('option', { value: '' }, t('pushTagPick')),
              tagList.map((tag) => h('option', { key: tag, value: tag }, tag))))
          : null,

        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' },
            t('tabBranchName') + (needsTarget ? ' *' : '')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: branch,
            disabled: Boolean(props.busy),
            onChange: (e) => setBranch(e.target.value),
          })),
        needsTarget && !targetBranch
          ? h('div', { className: 'dsh-push-warn' }, t('pushTargetBranchRequired'))
          : null,

        h('label', { className: 'dsh-push-inline' },
          h('input', {
            type: 'checkbox', className: 'dsh-push-checkbox',
            checked: force, onChange: (e) => setForce(e.target.checked),
          }),
          h('span', { className: 'dsh-push-warn' }, t('tabForce'))),
        force ? h('div', { className: 'dsh-push-warn' }, t('tabForceWarn')) : null,
        /* Review is independent of pushing: you can check a change without
           sending it anywhere. It sits beside 推送 because that is the moment
           the user is about to leave the machine. */
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            disabled: props.busy,
            title: props.reviewBlocked ? t('rvBlockedBadge') : undefined,
            onClick: () => { if (props.onReview) props.onReview(); },
          }, h(Icon, { name: 'check', size: 12 }), t('rvAgentReview')),
          props.reviewBlocked
            ? h('span', { className: 'dsh-push-rv-badge' }, t('rvBlockedBadge'))
            : null),

        /* The refspec preview: the one place to see exactly what will move. */
        h('div', { className: 'dsh-push-refline' },
          h('span', null, t('pushRefspec')),
          h('span', { className: 'dsh-push-mono' },
            targetBranch
              ? t('pushRefspecHint', {
                source: sourceLabel || 'HEAD',
                remote: destinationLabel,
                branch: targetBranch,
              })
              : t('pushRefspecNoBranch', {
                source: sourceLabel || 'HEAD',
                remote: destinationLabel,
              }))),

        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: force ? 'danger' : 'primary',
            disabled: Boolean(props.busy) || !versionReady,
            title: versionReady ? undefined
              : (needsTarget && !fixedSource
                ? t('pushSourceRequired')
                : t('pushTargetBranchRequired')),
            onClick: submit,
          }, t('tabPush'))));
    }

    function PullForm(props) {
      const status = props.status || {};
      const remotes = status.remotes || [];
      const [remote, setRemote] = useState((remotes[0] && remotes[0].name) || 'origin');
      const [rebase, setRebase] = useState(false);

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabRemote')),
          h('select', {
            className: 'dsh-push-select', value: remote,
            onChange: (e) => setRemote(e.target.value),
          }, (remotes.length > 0 ? remotes : [{ name: 'origin' }]).map((r) => h('option', {
            key: r.name, value: r.name,
          }, r.name)))),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, { checked: rebase, label: t('tabRebase'), onChange: setRebase }),
          h('span', { className: 'dsh-push-row-hint' }, t('tabRebase'))),
        h('div', { className: 'dsh-push-inline' },
          h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => props.onRun({ remote, rebase }) }, t('tabPull'))));
    }

    function FetchForm(props) {
      const status = props.status || {};
      const remotes = status.remotes || [];
      const [remote, setRemote] = useState((remotes[0] && remotes[0].name) || 'origin');
      const [prune, setPrune] = useState(false);

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabRemote')),
          h('select', {
            className: 'dsh-push-select', value: remote,
            onChange: (e) => setRemote(e.target.value),
          }, (remotes.length > 0 ? remotes : [{ name: 'origin' }]).map((r) => h('option', {
            key: r.name, value: r.name,
          }, r.name)))),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, { checked: prune, label: t('tabPrune'), onChange: setPrune }),
          h('span', { className: 'dsh-push-row-hint' }, t('tabPrune'))),
        h('div', { className: 'dsh-push-inline' },
          h(Btn, { kind: 'primary', disabled: props.busy, onClick: () => props.onRun({ remote, prune }) }, t('tabFetch'))));
    }

    function ResetForm(props) {
      const [mode, setMode] = useState('mixed');
      const [ref, setRef] = useState(props.initialRef || 'HEAD');
      const [confirmText, setConfirmText] = useState('');
      const hard = mode === 'hard';
      const blocked = hard && confirmText.trim() !== t('tabConfirmWord');

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabResetMode')),
          h('select', {
            className: 'dsh-push-select', value: mode,
            onChange: (e) => setMode(e.target.value),
          },
            h('option', { value: 'soft' }, t('tabModeSoft')),
            h('option', { value: 'mixed' }, t('tabModeMixed')),
            h('option', { value: 'hard' }, t('tabModeHard')))),
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabTargetRef')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: ref,
            onChange: (e) => setRef(e.target.value),
          })),
        hard ? h('div', { className: 'dsh-push-warn' }, t('tabHardWarn')) : null,
        hard
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabConfirmWord')),
            h('input', {
              className: 'dsh-push-input', type: 'text', value: confirmText,
              placeholder: t('tabConfirmWord'),
              onChange: (e) => setConfirmText(e.target.value),
            }))
          : null,
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'danger',
            disabled: props.busy || blocked,
            onClick: () => props.onRun({ ref: ref.trim() || 'HEAD', mode }),
          }, t('tabReset'))));
    }

    function BranchForm(props) {
      const status = props.status || {};
      const branches = status.branches || [];
      const [name, setName] = useState('');
      const [from, setFrom] = useState('');
      const [checkout, setCheckout] = useState(true);
      // Two-step delete: the first click arms, the second deletes. `forceArm`
      // is a THIRD step offered only after git refused the safe delete ("not
      // fully merged"), so a forced delete can never be reached by a double
      // click on one button.
      const [deleteArm, setDeleteArm] = useState('');
      const [forceArm, setForceArm] = useState('');

      const armDelete = (branch) => {
        setForceArm('');
        setDeleteArm(deleteArm === branch ? '' : branch);
      };

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabNewBranch')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: name,
            placeholder: t('tabBranchName'),
            onChange: (e) => setName(e.target.value),
          })),
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabFrom')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: from,
            placeholder: status.branch || 'HEAD',
            onChange: (e) => setFrom(e.target.value),
          })),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, { checked: checkout, label: t('tabCheckout'), onChange: setCheckout }),
          h('span', { className: 'dsh-push-row-hint' }, t('tabCheckout'))),
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'primary',
            disabled: props.busy || !name.trim(),
            onClick: () => props.onRun({
              name: name.trim(),
              from: from.trim() || undefined,
              checkout,
            }),
          }, t('tabNewBranch'))),
        branches.length > 0
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabBranchList')),
            h('div', { className: 'dsh-push-files' },
              branches.map((branch) => {
                const armed = deleteArm === branch;
                const forceArmed = forceArm === branch;
                return h('div', { className: 'dsh-push-branchrow', key: branch },
                  h('div', { className: 'dsh-push-filepick' },
                    h(Icon, { name: 'branch', size: 12 }),
                    h('span', { style: { flex: '1 1 auto' }, title: branch }, branch),
                    branch === status.branch
                      ? h('span', { className: 'dsh-push-pill dsh-push-pill--active' }, t('current'))
                      : h('div', { className: 'dsh-push-inline' },
                        h(Btn, {
                          mini: true,
                          disabled: props.busy,
                          onClick: () => props.onCheckout(branch),
                        }, t('tabCheckout')),
                        h(Btn, {
                          mini: true,
                          kind: 'danger',
                          disabled: props.busy,
                          onClick: () => armDelete(branch),
                        }, armed ? t('branchDeleteConfirmAction') : t('branchDeleteAction')))),
                  armed
                    ? h('div', { className: 'dsh-push-branchrow-extra' },
                      h('div', { className: 'dsh-push-hint' }, t('branchDeleteWarn')),
                      h('div', { className: 'dsh-push-inline' },
                        h(Btn, {
                          mini: true,
                          kind: 'danger',
                          disabled: props.busy,
                          onClick: async () => {
                            const ok = await props.onDelete(branch, false);
                            // Only a REFUSAL keeps the block open, with the
                            // forced retry offered. Success closes it (the
                            // refreshed status no longer lists the branch).
                            if (ok) { setDeleteArm(''); setForceArm(''); }
                            else setForceArm(branch);
                          },
                        }, t('branchDeleteConfirmAction')),
                        h(Btn, { mini: true, onClick: () => armDelete(branch) }, t('cancel'))),
                      forceArmed
                        ? h('div', { className: 'dsh-push-branchrow-extra' },
                          h('div', { className: 'dsh-push-warn' }, t('branchDeleteNotMerged')),
                          h('div', { className: 'dsh-push-inline' },
                            h(Btn, {
                              mini: true,
                              kind: 'danger',
                              disabled: props.busy,
                              onClick: async () => {
                                const ok = await props.onDelete(branch, true);
                                if (ok) { setDeleteArm(''); setForceArm(''); }
                              },
                            }, t('branchDeleteForceConfirm'))))
                        : null)
                    : null);
              })))
          : null);
    }

    function TagForm(props) {
      const status = props.status || {};
      const [name, setName] = useState('');
      const [ref, setRef] = useState(props.initialRef || 'HEAD');
      const [push, setPush] = useState(false);

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabTagName')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: name,
            onChange: (e) => setName(e.target.value),
          })),
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabTagRef')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: ref,
            onChange: (e) => setRef(e.target.value),
          })),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, { checked: push, label: t('tabPushTag'), onChange: setPush }),
          h('span', { className: 'dsh-push-row-hint' }, t('tabPushTag'))),
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'primary',
            disabled: props.busy || !name.trim(),
            onClick: () => props.onRun({ name: name.trim(), ref: ref.trim() || 'HEAD', push }),
          }, t('tabTag'))),
        (status.tags || []).length > 0
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabTagList')),
            h('div', { className: 'dsh-push-chips' }, (status.tags || []).slice(0, 24).map((tag) => h('span', {
              className: 'dsh-push-pill', key: tag, title: tag,
            }, tag))))
          : null);
    }

    /**
     * 暂存 — `POST /local/stash` plus 恢复 (`POST /local/stash/pop`).
     *
     * Deletion has NO host route, so the list deliberately offers only 恢复: a
     * menu entry that cannot work is exactly the "cannot do X" gap this change
     * exists to close.
     */
    function StashForm(props) {
      const status = props.status || {};
      const stashes = Array.isArray(status.stashes) ? status.stashes : [];
      const [message, setMessage] = useState('');
      const [includeUntracked, setIncludeUntracked] = useState(true);

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('stashTitle')),
          h('span', { className: 'dsh-push-hint' }, t('stashHint'))),
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('stashMessage')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: message,
            disabled: Boolean(props.busy),
            onChange: (e) => setMessage(e.target.value),
          })),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, {
            checked: includeUntracked,
            label: t('stashIncludeUntracked'),
            onChange: setIncludeUntracked,
          }),
          h('span', { className: 'dsh-push-row-hint' }, t('stashIncludeUntracked'))),
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'primary',
            disabled: Boolean(props.busy),
            onClick: () => props.onCreate({
              message: message.trim() || undefined,
              includeUntracked,
            }),
          }, t('stashCreate'))),

        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('stashList')),
          stashes.length === 0
            ? h('span', { className: 'dsh-push-hint' }, t('stashEmpty'))
            : h('div', { className: 'dsh-push-files' }, stashes.map((entry) => h('div', {
              className: 'dsh-push-filepick',
              key: String(entry.index),
              title: entry.message || '',
            },
              h('span', { className: 'dsh-push-pill' }, 'stash@{' + entry.index + '}'),
              h('span', { style: { flex: '1 1 auto' } }, entry.message || ''),
              h(Btn, {
                mini: true,
                disabled: Boolean(props.busy),
                title: t('stashPopHint'),
                onClick: () => props.onPop(entry.index),
              }, t('stashPop')))))));
    }

    /**
     * 合并 — `POST /local/merge`.
     *
     * The ref is a free-text field fed by two selects (branches, tags), so both
     * the common pick and an arbitrary sha work. A merge that stops on conflicts
     * arrives as a thrown GIT_FAILED carrying git's own output; the caller keeps
     * that output visible and this component names the state in Chinese on top
     * of it instead of leaving the user to read `<<<<<<<`.
     */
    function MergeForm(props) {
      const status = props.status || {};
      const branches = Array.isArray(status.branches)
        ? status.branches.filter((branch) => branch !== status.branch)
        : [];
      const tags = Array.isArray(status.tags) ? status.tags : [];
      const [ref, setRef] = useState('');
      const [picked, setPicked] = useState('');

      const choose = (value) => {
        setPicked(value);
        if (value) setRef(value);
      };

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('mergeTitle')),
          h('span', { className: 'dsh-push-hint' }, t('mergeHint'))),
        branches.length > 0
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabBranchList')),
            h('select', {
              className: 'dsh-push-select',
              value: branches.indexOf(picked) !== -1 ? picked : '',
              disabled: Boolean(props.busy) || undefined,
              onChange: (e) => choose(e.target.value),
            },
              h('option', { value: '' }, t('mergeRef')),
              branches.map((branch) => h('option', { key: branch, value: branch }, branch))))
          : null,
        tags.length > 0
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabTagList')),
            h('select', {
              className: 'dsh-push-select',
              value: tags.indexOf(picked) !== -1 ? picked : '',
              disabled: Boolean(props.busy) || undefined,
              onChange: (e) => choose(e.target.value),
            },
              h('option', { value: '' }, t('tabTag')),
              tags.map((tag) => h('option', { key: tag, value: tag }, tag))))
          : null,
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('mergeRef')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: ref,
            spellCheck: false, disabled: Boolean(props.busy),
            placeholder: t('mergeRef'),
            onChange: (e) => setRef(e.target.value),
          })),
        props.conflict ? h('div', { className: 'dsh-push-warn' }, t('mergeConflicts')) : null,
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'primary',
            disabled: Boolean(props.busy) || !ref.trim(),
            onClick: () => props.onRun({ ref: ref.trim() }),
          }, t('mergeRun'))));
    }

    /**
     * 清空工作区 — `POST /local/discard-all`, gated behind typing 确认.
     *
     * The host refuses without `confirm: true`, so the typed word is the only
     * gate that matters; `confirm: true` travels beside it and the button stays
     * disabled until the word matches exactly. This is 更多操作's danger area, so
     * it wears the danger-zone treatment rather than looking like a normal form.
     */
    function DiscardAllForm(props) {
      const [word, setWord] = useState('');
      const expected = t('tabConfirmWord');
      const ready = word.trim() === expected;

      return h('div', { className: 'dsh-push-form' },
        h('div', { className: 'dsh-push-subhead', style: { marginTop: '2px' } },
          t('moreDangerZone')),
        h('div', { className: 'dsh-push-dangerzone' },
          h('div', { className: 'dsh-push-dangerrow' },
            h('span', { className: 'dsh-push-danger-title' }, t('discardAllTitle')),
            h('div', { className: 'dsh-push-hint' }, t('discardAllHint'))),
          h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' },
              t('discardAllTypeWord', { word: expected })),
            h('input', {
              className: 'dsh-push-input', type: 'text', value: word,
              spellCheck: false, autoComplete: 'off',
              disabled: Boolean(props.busy),
              placeholder: expected,
              onChange: (e) => setWord(e.target.value),
            })),
          h('div', { className: 'dsh-push-inline' },
            h(Btn, {
              kind: 'danger',
              disabled: Boolean(props.busy) || !ready,
              title: ready ? undefined : t('discardAllConfirm'),
              onClick: () => props.onRun(),
            }, t('discardAllArm')),
            h(Btn, { disabled: Boolean(props.busy), onClick: props.onCancel }, t('cancel')))));
    }

    /* ─────────────────── C. workspace Git tab ───────────────────────────── */

    /**
     * Lane geometry for one commit row.
     *
     * `/local/log` already hands us each commit's `lane`, so the row only needs
     * the lines that JOIN rows: an incoming segment (previous row's lane → this
     * dot) and an outgoing one (this dot → next row's lane). `parents` decides
     * whether a connector exists at all — a row whose successor does not name
     * it as a parent is the end of that strand, so no line may continue out of
     * it, which is what keeps two unrelated strands from being welded together.
     */
    function laneGeometry(commits, index, laneCount) {
      const laneOf = (i) => Math.max(0, Math.min(laneCount - 1, Number(commits[i] && commits[i].lane) || 0));
      const current = laneOf(index);
      const previous = index > 0 ? laneOf(index - 1) : current;
      const cx = (lane) => lane * LANE_W + LANE_W / 2;
      const mid = ROW_H / 2;
      const segments = [];

      if (index > 0) {
        // Incoming: straight down the same lane, otherwise elbow across at the
        // dot's own centre so the stroke always terminates ON the dot.
        segments.push(previous === current
          ? 'M' + cx(previous) + ' 0V' + mid
          : 'M' + cx(previous) + ' 0V' + mid + 'H' + cx(current));
      }

      const next = commits[index + 1];
      const parents = (commits[index] && commits[index].parents) || [];
      if (next && parents.indexOf(next.sha) !== -1) {
        const target = laneOf(index + 1);
        segments.push(target === current
          ? 'M' + cx(current) + ' ' + mid + 'V' + ROW_H
          : 'M' + cx(current) + ' ' + mid + 'V' + ROW_H + 'H' + cx(target));
      }

      return { d: segments.join(' '), x: cx(current) };
    }

    function WorkspaceTab(props) {
            const ctx = props.ctx;
      const [density] = useDensity(); const visible = props.visible !== false;
      // `repoRoot` is the selected Git repository when `cwd` is a workspace
      // container holding several; it is the path git commands must target,
      // while `cwd` alone would be the folder that merely contains them.
      const cwd = (props.scope && (props.scope.repoRoot || props.scope.cwd)) || '';

      const [status, setStatus] = useState(null);
      const [log, setLog] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [panel, setPanel] = useState('');
      const [toast, setToast] = useState(null);
      const [output, setOutput] = useState('');
      const [diff, setDiff] = useState(null);
      const [unpicked, setUnpicked] = useState(() => new Set());
      const [restoreArm, setRestoreArm] = useState('');
      const [tagRef, setTagRef] = useState('HEAD');
      const [resetRef, setResetRef] = useState('HEAD');
      const [initOpen, setInitOpen] = useState(false);
      const [hasAccount, setHasAccount] = useState(false);
      // 关联远端 needs its OWN read (/local/remotes): the form opens right
      // before a write and must show .git/config as it is now, not the value
      // captured by the last status poll.
      const [remotes, setRemotes] = useState([]);
      // Which VERSION the push form starts on, so a commit row can seed it.
      const [pushSource, setPushSource] = useState(null);
      const [mergeConflict, setMergeConflict] = useState(false);

      const aliveRef = useRef(true);
      const busyRef = useRef(false);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      useEffect(() => {
        if (!toast) return undefined;
        const id = setTimeout(() => { if (aliveRef.current) setToast(null); }, TOAST_MS);
        return () => clearTimeout(id);
      }, [toast]);

      // The remote switch defaults ON only when there is an account to create
      // it with; that is a property of the plugin, not of the repository, so it
      // is probed last and re-probed whenever the tab is reopened.
      useEffect(() => {
        if (!visible || hasAccount) return undefined;
        let live = true;
        (async () => {
          try {
            const data = await api(ctx, API + '/state');
            if (live && aliveRef.current) setHasAccount(((data && data.accounts) || []).length > 0);
          } catch (err) {
            /* no account list only leaves the switch at its OFF default */
          }
        })();
        return () => { live = false; };
      }, [ctx, visible, hasAccount]);

      const refresh = useCallback(async (quiet) => {
        if (!cwd) return;
        if (!quiet) setError('');
        try {
          const next = await api(ctx, API + '/local/status?path=' + encodeURIComponent(cwd));
          if (!aliveRef.current) return;
          setStatus(next);
          if (next && next.isRepo) {
            try {
              const history = await api(ctx, API + '/local/log?path=' + encodeURIComponent(cwd) + '&limit=60');
              if (aliveRef.current) setLog(history);
            } catch (err) {
              // A fresh `git init` has no HEAD yet — an empty graph, not an error.
              if (aliveRef.current) setLog({ commits: [], hasMore: false });
            }
          } else if (aliveRef.current) {
            setLog(null);
            setDiff(null);
          }
        } catch (err) {
          if (aliveRef.current) setError(err.message);
        }
      }, [ctx, cwd]);

      useEffect(() => { if (cwd) refresh(false); }, [cwd, refresh]);

      // Poll only while the tab is the visible, active one. The first paint is
      // already handled by the mount effect above, so this installs the timer
      // alone — two effects both fetching on mount would double every load.
      useEffect(() => {
        if (!cwd || !visible) return undefined;
        const id = setInterval(() => {
          if (!busyRef.current) refresh(true);
        }, STATUS_POLL_MS);
        return () => clearInterval(id);
      }, [cwd, visible, refresh]);

      /* An agent cannot run a review on its own any more: it records a
         request, and this poll turns that request into the ordinary review
         dialog so the user picks the items. Polling is what makes the agent
         path and the button path end in the same place. */
      useEffect(() => {
        if (!cwd) return undefined;
        let live = true;
        const check = async () => {
          try {
            const data = await api(ctx, API + '/review/pending?path=' + encodeURIComponent(cwd));
            if (!live || !aliveRef.current) return;
            const pending = data && data.pending;
            if (!pending) return;
            // Already showing it? Leave the user alone.
            setReviewPending((current) => (current && current.id === pending.id ? current : pending));
            setReviewOpen(true);
          } catch (error) {
            /* a failed poll must never disturb the panel */
          }
        };
        check();
        const id = setInterval(check, STATUS_POLL_MS);
        return () => { live = false; clearInterval(id); };
      }, [ctx, cwd]);

      // The picked set is per repository: another root means other file paths.
      const rootKey = (status && status.root) || '';
      useEffect(() => { setUnpicked(new Set()); }, [rootKey]);

      const exec = useCallback(async (label, path, body) => {
        if (!cwd) return null;
        setBusy(label);
        busyRef.current = true;
        try {
          const payload = Object.assign({ path: cwd }, body || {});
          const data = await api(ctx, API + path, { method: 'POST', body: payload });
          if (!aliveRef.current) return data;
          setToast({ kind: 'ok', text: t('tabDone', { label }) });
          setOutput(data && typeof data.output === 'string' ? data.output : '');
          setPanel('');
          setDiff(null);
          await refresh(true);
          return data;
        } catch (err) {
          if (aliveRef.current) {
            setToast({ kind: 'err', text: err.message });
            setOutput(err.detail || '');
          }
          return null;
        } finally {
          if (aliveRef.current) {
            setBusy('');
            busyRef.current = false;
          }
        }
      }, [ctx, cwd, refresh]);

      const openDiff = useCallback(async (file, staged) => {
        if (!cwd) return;
        try {
          const data = await api(ctx, API + '/local/diff?path=' + encodeURIComponent(cwd)
            + '&file=' + encodeURIComponent(file) + '&staged=' + (staged ? 'true' : 'false'));
          if (aliveRef.current) {
            setDiff({ file, patch: (data && data.patch) || '', truncated: data && data.truncated === true });
          }
        } catch (err) {
          if (aliveRef.current) setToast({ kind: 'err', text: err.message });
        }
      }, [ctx, cwd]);

      /**
       * 反向提交 — `POST /local/revert` (CONTRACT §3's row for this action).
       *
       * The host ALSO registers `/local/revert-commit` as a second alias of
       * the same method. Exactly one is the working path here: `/local/revert`
       * is always tried first and the alias is used ONLY when the route itself
       * is absent (a 404/405, i.e. not a git failure) — never to retry a revert
       * that genuinely failed, which could undo two commits.
       */
      const revertCommit = async (sha) => {
        if (!cwd) return null;
        setBusy(t('tabRevert'));
        busyRef.current = true;
        try {
          const body = { path: cwd, sha };
          let data;
          try {
            data = await api(ctx, API + '/local/revert', { method: 'POST', body });
          } catch (err) {
            const missing = err && (err.code === 'HTTP_404' || err.code === 'HTTP_405');
            if (!missing) throw err;
            data = await api(ctx, API + '/local/revert-commit', { method: 'POST', body });
          }
          if (!aliveRef.current) return data;
          setToast({ kind: 'ok', text: t('tabDone', { label: t('tabRevert') }) });
          setOutput(data && typeof data.output === 'string' ? data.output : '');
          setPanel('');
          setDiff(null);
          await refresh(true);
          return data;
        } catch (err) {
          if (aliveRef.current) {
            setToast({ kind: 'err', text: err.message });
            setOutput(err.detail || '');
          }
          return null;
        } finally {
          if (aliveRef.current) {
            setBusy('');
            busyRef.current = false;
          }
        }
      };

      /** `GET /local/remotes` — the 关联远端 form's own read. */
      const loadRemotes = useCallback(async () => {
        if (!cwd) return;
        try {
          const data = await api(ctx, API + '/local/remotes?path=' + encodeURIComponent(cwd));
          if (!aliveRef.current) return;
          setRemotes(data && Array.isArray(data.remotes) ? data.remotes : []);
        } catch (err) {
          // A broken `git remote -v` is reported by the write itself with a
          // real message; the form still works from the status copy.
          if (aliveRef.current) setRemotes([]);
        }
      }, [ctx, cwd]);

      // Seed the remote list from the status document so the bar can tell an
      // unlinked clone from a linked one before the first explicit read.
      useEffect(() => {
        if (!status) return;
        const list = Array.isArray(status.remotes) ? status.remotes : [];
        if (list.length > 0) setRemotes((prev) => (prev.length === 0 ? list : prev));
      }, [status]);

      /** `POST /local/remote` — add or change a remote, then re-read. */
      const saveRemote = async (body) => {
        const data = await exec(t('remoteSaveAction'), '/local/remote', body);
        if (data) await loadRemotes();
        return data;
      };

      /**
       * `POST /local/branch/delete`. Returns true only when git ACCEPTED it, so
       * the branch form knows whether to offer the forced retry.
       */
      const deleteBranch = async (name, force) => {
        const label = force ? t('branchDeleteForce') : t('branchDeleteAction');
        setBusy(label);
        busyRef.current = true;
        try {
          const data = await api(ctx, API + '/local/branch/delete', {
            method: 'POST',
            body: { path: cwd, name, force },
          });
          if (!aliveRef.current) return true;
          setToast({ kind: 'ok', text: t('tabDone', { label }) });
          setOutput(data && typeof data.output === 'string' ? data.output : '');
          setPanel('');
          await refresh(true);
          return true;
        } catch (err) {
          if (aliveRef.current) {
            setToast({ kind: 'err', text: err.message });
            setOutput(err.detail || '');
          }
          return false;
        } finally {
          if (aliveRef.current) {
            setBusy('');
            busyRef.current = false;
          }
        }
      };

      /**
       * `POST /local/merge`. A failure keeps git's own output AND flips
       * `mergeConflict` when git reported conflicts, so the panel can name the
       * state in Chinese on top of the raw text.
       */
      const mergeRef = async (body) => {
        setMergeConflict(false);
        setBusy(t('mergeRun'));
        busyRef.current = true;
        try {
          const data = await api(ctx, API + '/local/merge', {
            method: 'POST',
            body: Object.assign({ path: cwd }, body),
          });
          if (!aliveRef.current) return data;
          setToast({ kind: 'ok', text: t('tabDone', { label: t('mergeRun') }) });
          setOutput(data && typeof data.output === 'string' ? data.output : '');
          setPanel('');
          await refresh(true);
          return data;
        } catch (err) {
          const raw = String(err.detail || err.message || '');
          if (aliveRef.current) {
            setToast({ kind: 'err', text: err.message });
            setOutput(raw);
            if (/CONFLICT|Automatic merge failed/i.test(raw)) setMergeConflict(true);
          }
          return null;
        } finally {
          if (aliveRef.current) {
            setBusy('');
            busyRef.current = false;
          }
        }
      };

      // Pre-push review (CONTRACT §3d). Declared HERE, above every early
      // return: a hook inside a conditional branch violates the rules of hooks
      // and left `reviewResult` undefined on the normal path, which crashed the
      // whole tab on a real repository.
      const [reviewOpen, setReviewOpen] = useState(false);
      // The request an agent raised, if any. Rendering the dialog from it is
      // what guarantees the agent path asks the user before inspecting anything.
      const [reviewPending, setReviewPending] = useState(null);
      const [reviewResult, setReviewResult] = useState(null);

      const copySha = async (sha) => {
        const ok = await copyText(sha);
        if (aliveRef.current) setToast({ kind: ok ? 'ok' : 'err', text: ok ? t('copied') : t('copyFailed') });
      };

      const files = (status && status.files) || [];
      const isPicked = (path) => !unpicked.has(path);
      const togglePick = (path) => {
        setUnpicked((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      };
      const pickedPaths = files.filter((file) => !unpicked.has(file.path)).map((file) => file.path);

      const groups = groupFiles(files);
      const commits = (log && log.commits) || [];
      const laneCount = commits.reduce((max, commit) => Math.max(max, (Number(commit.lane) || 0) + 1), 1);

      const openPanel = (name) => setPanel(panel === name ? '' : name);
      const problem = (text) => setToast({ kind: 'err', text });

      /* The review dialog is rendered ONCE, before any early return, so it is
         available whether or not the directory is a repository. It portals
         itself over the page, so it must not live inside a scroll child. */
      const reviewDialog = h(ReviewDialog, {
        open: reviewOpen,
        path: cwd,
        status,
        ctx,
        // Seeded when an agent asked for a review; null for a manual click.
        pending: reviewPending,
        onClose: () => {
          setReviewOpen(false);
          // Answering (either way) frees the slot so a later request can open
          // a fresh dialog instead of being swallowed by the dedupe guard.
          const pending = reviewPending;
          setReviewPending(null);
          if (pending && pending.id) {
            api(ctx, API + '/review/pending/clear', { method: 'POST', body: { id: pending.id } })
              .catch(() => {});
          }
        },
        onReviewed: (result) => setReviewResult(result),
      });

      /* ── no workspace path: nothing can be asked of git without one ── */
      if (!cwd) {
        return h('div', { className: 'dsh-push-root dsh-push-tab', style: densityStyle(density) },
        reviewDialog,
          h('div', { className: 'dsh-push-tab-head' },
            h('div', { className: 'dsh-push-tab-repo' },
              h(GithubMark, { size: 14 }),
              h('span', { className: 'dsh-push-tab-repo-name' }, t('tabTitle')))),
          h('div', { className: 'dsh-push-scroll' },
            h('div', { className: 'dsh-push-section-sub', style: { padding: '12px 10px' } },
              t('tabNoCwd'))),
          h('div', { className: 'dsh-push-toastbar' }, t('tabNoCwd')));
      }

      /* ── empty state + init form, when the directory is not a repository ── */
      if (status && !status.isRepo) {
        const resolved = (props.scope && (props.scope.repoRoot || props.scope.cwd)) || cwd;
        return h('div', { className: 'dsh-push-root dsh-push-tab', style: densityStyle(density) },
        reviewDialog,
          h('div', { className: 'dsh-push-tab-head' },
            h('div', { className: 'dsh-push-tab-repo' },
              h(GithubMark, { size: 14 }),
              h('span', { className: 'dsh-push-tab-repo-name' }, t('tabTitle')))),

          h('div', { className: 'dsh-push-scroll' },
            h('div', { className: 'dsh-push-repoempty' },
              h('div', { className: 'dsh-push-repoempty-icon' }, h(Icon, { name: 'branch', size: 32 })),
              h('div', { className: 'dsh-push-repoempty-title' }, t('tabNotRepo')),
              h('div', { className: 'dsh-push-hint dsh-push-repoempty-path', title: resolved }, resolved),

              initOpen
                ? h('div', { className: 'dsh-push-repoempty-form' },
                  h(InitForm, {
                    busy: busy,
                    cwd,
                    hasAccount,
                    onGo: (body) => exec(t('tabInitSubmit'), '/local/init', body),
                    onRefresh: () => refresh(false),
                  }))
                : h(Btn, {
                  kind: 'primary',
                  disabled: Boolean(busy),
                  onClick: () => setInitOpen(true),
                }, t('tabCreateRepo')))),

          h('div', { className: 'dsh-push-toastbar' + (toast ? ' dsh-push-toastbar--' + toast.kind : '') },
            toast ? toast.text : (error || '')));
      }

      /* ── 关联远端 bar ──
       *
       * The audit's headline gap: a clone with no remote could never be linked
       * from this tab. The bar appears in BOTH states — a prominent warning-toned
       * call to action when nothing is linked, a muted "change it" line when
       * something is — so the affordance never disappears from the page. */
      const linkedRemote = status && status.githubRemote ? status.githubRemote : null;
      const knownRemotes = remotes.length > 0
        || Boolean(status && Array.isArray(status.remotes) && status.remotes.length > 0);
      const remoteBar = h('div', { className: 'dsh-push-remotebar' },
        linkedRemote
          ? h('span', { className: 'dsh-push-remotebar-text dsh-push-remotebar-text--ok' },
            t('remoteLinkedHint', {
              name: linkedRemote.name || 'origin',
              url: linkedRemote.url || (linkedRemote.owner + '/' + linkedRemote.repo),
            }))
          : h('span', { className: 'dsh-push-remotebar-text' },
            t('remoteUnlinked') + ' — ' + t('remoteUnlinkedHint')),
        h(Btn, {
          mini: true,
          kind: linkedRemote || knownRemotes ? undefined : 'primary',
          disabled: Boolean(busy),
          onClick: () => setPanel(panel === 'remote' ? '' : 'remote'),
        }, linkedRemote || knownRemotes ? t('remoteChangeCta') : t('remoteLinkCta')));

      return h('div', { className: 'dsh-push-root dsh-push-tab', style: densityStyle(density) },
        reviewDialog,
        /* ── repo line ── */
        h('div', { className: 'dsh-push-tab-head' },
          h('div', { className: 'dsh-push-tab-repo' },
            h(GithubMark, { size: 14 }),
            h('span', { className: 'dsh-push-tab-repo-name', title: cwd },
              status && status.githubRemote
                ? status.githubRemote.owner + '/' + status.githubRemote.repo
                : t('tabNoRemote')),
            h('span', { className: 'dsh-push-page-spacer' }),
            h(Btn, { mini: true, onClick: () => refresh(false), title: t('refresh') },
              h(Icon, { name: 'refresh', size: 12 }))),
          h('div', { className: 'dsh-push-tab-repo-sub' },
            status && status.branch
              ? h('span', { className: 'dsh-push-pill dsh-push-pill--active' },
                h(Icon, { name: 'branch', size: 11 }), status.branch)
              : h('span', { className: 'dsh-push-pill dsh-push-pill--warn' },
                status && status.detachedHead ? t('tabDetached') : '—'),
            status
              ? h('span', null, '↑' + (status.ahead || 0) + ' ↓' + (status.behind || 0))
              : null,
            status && status.dirty
              ? h('span', { className: 'dsh-push-pill' },
                t('tabStaged') + ' ' + (status.dirty.staged || 0)
                + ' · ' + t('tabUnstaged') + ' ' + (status.dirty.changed || 0)
                + ' · ' + t('tabUntracked') + ' ' + (status.dirty.untracked || 0))
              : null,
            status && status.dirty && status.dirty.conflicted > 0
              ? h('span', { className: 'dsh-push-pill dsh-push-pill--err' },
                t('tabConflicted') + ' ' + status.dirty.conflicted)
              : null,
            !cwd ? h('span', { className: 'dsh-push-error' }, t('tabNoCwd')) : null,
            error ? h('span', { className: 'dsh-push-error', title: error }, error) : null)),
        /* ── toolbar ── */
        /* ── 关联远端 / 更换远端 ── */
        remoteBar,

        /* ── toolbar ── */
        h('div', { className: 'dsh-push-toolbar' },
          toolbarButton('commit', t('tabCommit')),
          toolbarButton('push', t('tabPush')),
          toolbarButton('pull', t('tabPull')),
          toolbarButton('fetch', t('tabFetch')),
          toolbarButton('reset', t('tabReset')),
          toolbarButton('branch', t('tabBranch')),
          toolbarButton('tag', t('tabTag')),
          toolbarButton('stash', t('stashTitle')),
          toolbarButton('merge', t('mergeTitle')),
          toolbarButton('more', t('tabMore'))),

        /* ── inline toolbar form ── */
        panel === 'remote'
          ? h(RemoteForm, {
            status,
            ctx,
            busy,
            remotes,
            initialName: linkedRemote && linkedRemote.name ? linkedRemote.name : 'origin',
            initialUrl: linkedRemote && linkedRemote.url ? linkedRemote.url : '',
            onRun: saveRemote,
            onCancel: () => setPanel(''),
          })
          : null,
        panel === 'commit'
          ? h(CommitForm, {
            status, busy, pickedPaths, isPicked, onTogglePick: togglePick, onProblem: problem,
            onSubmit: async (body, alsoPush) => {
              const committed = await exec(t('tabCommit'), '/local/commit', body);
              if (committed && alsoPush) await exec(t('tabPush'), '/local/push', {});
            },
          })
          : null,
        panel === 'push'
          ? h(PushForm, {
            status,
            busy,
            ctx,
            cwd,
            // The review button lives inside PushForm (next to 推送); this
            // handler is what makes clicking it open the dialog.
            onReview: () => setReviewOpen(true),
            // A blocker finding warns on the push button; it never disables it,
            // because the user may have a reason to push anyway.
            reviewBlocked: Boolean(reviewResult && Array.isArray(reviewResult.findings)
              && reviewResult.findings.some((finding) => finding.severity === 'blocker')),
            // Recent commits for 指定提交 come from the ALREADY-LOADED graph:
            // re-fetching /local/log here would be a second source of truth.
            commits,
            initialSource: pushSource,
            onProblem: problem,
            onRun: (body) => exec(t('tabPush'), '/local/push', body),
            // CONTRACT §3b's optional companion: a remembered target that has
            // gone wrong would otherwise be permanent from inside the panel.
            onForgetMemory: async () => {
              const data = await exec(t('pushForgetMemory'), '/local/push/target/forget', {});
              if (data) setToast({ kind: 'ok', text: t('pushMemoryForgotten') });
              return data;
            },
          })
          : null,
        panel === 'pull'
          ? h(PullForm, { status, busy, onRun: (body) => exec(t('tabPull'), '/local/pull', body) })
          : null,
        panel === 'fetch'
          ? h(FetchForm, { status, busy, onRun: (body) => exec(t('tabFetch'), '/local/fetch', body) })
          : null,
        panel === 'reset'
          ? h(ResetForm, {
            busy, initialRef: resetRef,
            onRun: (body) => exec(t('tabReset'), '/local/reset', body),
          })
          : null,
        panel === 'branch'
          ? h(BranchForm, {
            status, busy,
            onRun: (body) => exec(t('tabNewBranch'), '/local/branch', body),
            onCheckout: (ref) => exec(t('tabCheckout'), '/local/checkout', { ref }),
            onDelete: deleteBranch,
          })
          : null,
        panel === 'tag'
          ? h(TagForm, {
            status, busy, initialRef: tagRef,
            onRun: (body) => exec(t('tabTag'), '/local/tag', body),
          })
          : null,
        panel === 'stash'
          ? h(StashForm, {
            status,
            busy,
            onCreate: (body) => exec(t('stashCreate'), '/local/stash', body),
            onPop: (index) => exec(t('stashPop'), '/local/stash/pop', { index }),
          })
          : null,
        panel === 'merge'
          ? h(MergeForm, {
            status,
            busy,
            conflict: mergeConflict,
            onRun: mergeRef,
          })
          : null,
        panel === 'more'
          ? h(DiscardAllForm, {
            busy,
            onRun: () => exec(t('discardAllArm'), '/local/discard-all', { confirm: true }),
            onCancel: () => setPanel(''),
          })
          : null,

        /* ── scrolling body ── */
        h('div', { className: 'dsh-push-scroll' },
          /* changes */
          h('div', { className: 'dsh-push-section' },
            h('div', { className: 'dsh-push-section-head' },
              h(Icon, { name: 'check', size: 12 }),
              t('tabChanges'),
              status && status.dirty
                ? h('span', { className: 'dsh-push-pill' },
                  (status.dirty.changed || 0) + ' · ' + (status.dirty.untracked || 0))
                : null),
            files.length === 0
              ? h('div', { className: 'dsh-push-section-sub' }, status ? t('tabNoFiles') : t('loading'))
              : [
                fileGroup('staged', t('tabStaged'), groups.staged, 'dsh-push-pill--ok'),
                fileGroup('unstaged', t('tabUnstaged'), groups.unstaged, ''),
                fileGroup('untracked', t('tabUntracked'), groups.untracked, ''),
                fileGroup('conflicted', t('tabConflicted'), groups.conflicted, 'dsh-push-pill--err'),
              ],
            diff
              ? h('div', { style: { padding: '4px 10px 10px' } },
                h('div', { className: 'dsh-push-section-sub', style: { padding: '0 0 4px' } },
                  h('span', { className: 'dsh-push-mono', title: diff.file }, diff.file),
                  h('span', { className: 'dsh-push-page-spacer' }),
                  h(Btn, { mini: true, onClick: () => setDiff(null) }, h(Icon, { name: 'close', size: 11 }))),
                renderDiff(diff.patch, diff.truncated))
              : null),

          /* git graph */
          h('div', { className: 'dsh-push-section' },
            h('div', { className: 'dsh-push-section-head' },
              h(Icon, { name: 'branch', size: 12 }),
              t('tabGraph'),
              commits.length > 0 ? h('span', { className: 'dsh-push-pill' }, String(commits.length)) : null),
            commits.length === 0
              ? h('div', { className: 'dsh-push-section-sub' },
                status && status.isRepo ? t('tabEmptyLog') : t('loading'))
              : commits.map((commit, index) => {
                const geometry = laneGeometry(commits, index, laneCount);
                return h('div', {
                  className: 'dsh-push-commit',
                  key: commit.sha,
                  title: commit.subject,
                },
                  h('svg', {
                    className: 'dsh-push-commit-graph',
                    width: laneCount * LANE_W,
                    height: ROW_H,
                    viewBox: '0 0 ' + (laneCount * LANE_W) + ' ' + ROW_H,
                    'aria-hidden': 'true',
                  },
                    h('path', {
                      d: geometry.d,
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: '1.5',
                    }),
                    h('circle', {
                      className: 'dsh-push-commit-dot',
                      cx: geometry.x,
                      cy: ROW_H / 2,
                      r: 3,
                    })),
                  h('span', { className: 'dsh-push-commit-subject' }, commit.subject),
                  (commit.refs || []).slice(0, 2).map((ref) => h('span', {
                    className: 'dsh-push-ref', key: ref, title: ref,
                  }, ref)),
                  h('span', { className: 'dsh-push-commit-sha dsh-push-mono' }, commit.shortSha),
                  h('span', { className: 'dsh-push-commit-meta' }, commit.author),
                  h('span', { className: 'dsh-push-commit-meta' }, relativeTime(commit.date)),
                  h('div', { className: 'dsh-push-commit-actions' },
                    h(Btn, {
                      mini: true, disabled: Boolean(busy), title: t('tabCheckoutAction'),
                      onClick: () => exec(t('tabCheckoutAction'), '/local/checkout', { ref: commit.sha }),
                    }, t('tabCheckoutAction')),
                    h(Btn, {
                      mini: true, disabled: Boolean(busy), title: t('tabRevert'),
                      onClick: () => revertCommit(commit.sha),
                    }, t('tabRevert')),
                    h(Btn, {
                      mini: true, disabled: Boolean(busy), title: t('pushThisVersion'),
                      onClick: () => {
                        // Seed the push form with THIS commit as the source.
                        setPushSource({ kind: 'commit', value: commit.sha });
                        setPanel('push');
                      },
                    }, t('pushThisVersion')),
                    h(Btn, {
                      mini: true, title: t('tabCopySha'),
                      onClick: () => copySha(commit.sha),
                    }, h(Icon, { name: 'copy', size: 11 })),
                    h(Btn, {
                      mini: true, title: t('tabTagHere'),
                      onClick: () => { setTagRef(commit.sha); setPanel('tag'); },
                    }, t('tabTagHere')),
                    h(Btn, {
                      mini: true, kind: 'danger', title: t('tabResetHere'),
                      onClick: () => { setResetRef(commit.sha); setPanel('reset'); },
                    }, t('tabResetHere'))));
              }))),

        /* ── status line ── */
        h('div', { className: 'dsh-push-toastbar' + (toast ? ' dsh-push-toastbar--' + toast.kind : '') },
          output ? h('pre', { className: 'dsh-push-output' }, output) : null,
          toast ? toast.text : (busy ? t('busy') + ' ' + busy : (error || ''))));

      /* ── local render helpers (need the component's state) ── */

      function toolbarButton(name, label) {
        return h(Btn, {
          active: panel === name,
          disabled: Boolean(busy),
          onClick: () => openPanel(name),
        }, label);
      }

      function fileGroup(key, label, list, pillClass) {
        if (!list || list.length === 0) return null;
        return h('div', { key },
          h('div', { className: 'dsh-push-section-sub' },
            h('span', { className: 'dsh-push-pill ' + (pillClass || '') }, label + ' ' + list.length)),
          list.map((file) => {
            const armed = restoreArm === file.path;
            return h('div', {
              className: 'dsh-push-file',
              key: file.path,
              title: file.path,
              onClick: () => openDiff(file.path, file.staged),
            },
              h('input', {
                type: 'checkbox',
                className: 'dsh-push-checkbox',
                checked: isPicked(file.path),
                'aria-label': t('tabIncludeFiles'),
                title: t('tabPickHint'),
                onClick: (event) => event.stopPropagation(),
                onChange: () => togglePick(file.path),
              }),
              h('span', { className: 'dsh-push-file-name' }, file.path),
              h('div', { className: 'dsh-push-file-actions' },
                // This toggles INCLUSION in the next commit, not the git
                // index, so the label must not say 暂存/取消暂存.
                h(Btn, {
                  mini: true,
                  disabled: Boolean(busy),
                  title: t('tabPickHint'),
                  onClick: () => togglePick(file.path),
                }, isPicked(file.path) ? t('tabPickExclude') : t('tabPickInclude')),
                file.conflicted
                  ? null
                  : h(Btn, {
                    mini: true,
                    kind: 'danger',
                    disabled: Boolean(busy),
                    title: t('tabRestoreHint'),
                    onClick: async () => {
                      if (!armed) { setRestoreArm(file.path); return; }
                      setRestoreArm('');
                      await exec(t('tabRestore'), '/local/restore', {
                        files: [file.path],
                        staged: false,
                      });
                    },
                  }, armed ? t('tabRestoreConfirm') : t('tabRestore'))));
          }));
      }

      function renderDiff(patch, truncated) {
        const split = splitPatch(patch);
        const rows = split.lines.map((line, index) => {
          let kind = '';
          if (line.startsWith('@@')) kind = ' dsh-push-diff-line--hunk';
          else if (line.startsWith('+') && !line.startsWith('+++')) kind = ' dsh-push-diff-line--add';
          else if (line.startsWith('-') && !line.startsWith('---')) kind = ' dsh-push-diff-line--del';
          return h('span', { className: 'dsh-push-diff-line' + kind, key: index }, line || ' ');
        });
        return [
          h('pre', { className: 'dsh-push-diff', key: 'diff' }, rows),
          split.folded || truncated
            ? h('div', { className: 'dsh-push-hint', key: 'folded' },
              t('tabDiffTruncated', { n: split.lines.length }))
            : null,
        ];
      }
    }

    /** 初始化仓库: expanded from the not-a-repository empty state. */
    function InitForm(props) {
      const base = (props.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
      const [name, setName] = useState(base);
      const [isPrivate, setPrivate] = useState(true);
      const [createRemote, setCreateRemote] = useState(Boolean(props.hasAccount));
      const [remoteName, setRemoteName] = useState('origin');

      return h('div', { className: 'dsh-push-form', style: { borderBottom: 'none' } },
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabInitTitle'))),
        h('div', { className: 'dsh-push-field' },
          h('span', { className: 'dsh-push-field-label' }, t('tabInitName')),
          h('input', {
            className: 'dsh-push-input', type: 'text', value: name,
            onChange: (e) => setName(e.target.value),
          })),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, { checked: isPrivate, label: t('tabInitPrivate'), onChange: setPrivate }),
          h('span', { className: 'dsh-push-row-hint' }, t('tabInitPrivateHint'))),
        h('label', { className: 'dsh-push-inline' },
          h(Switch, { checked: createRemote, label: t('tabInitRemote'), onChange: setCreateRemote }),
          h('span', { className: 'dsh-push-row-hint' }, t('tabInitRemote'))),
        createRemote
          ? h('div', { className: 'dsh-push-field' },
            h('span', { className: 'dsh-push-field-label' }, t('tabInitRemoteName')),
            h('input', {
              className: 'dsh-push-input', type: 'text', value: remoteName,
              onChange: (e) => setRemoteName(e.target.value),
            }))
          : null,
        h('div', { className: 'dsh-push-inline' },
          h(Btn, {
            kind: 'primary',
            disabled: props.busy,
            onClick: () => {
              if (!name.trim()) return;
              props.onGo({
                name: name.trim(),
                private: isPrivate,
                remoteName: remoteName.trim() || 'origin',
                createRemote,
              });
            },
          }, t('tabInitSubmit')),
          h(Btn, { onClick: props.onRefresh }, t('refresh'))));
    }

    /* ────────────────────────── plugin wiring ───────────────────────────── */

    function apply(ctx) {
      injectStyles();
      attachHostLocale(ctx);

      // The stylesheet is ours; drop it when this fiber disposes (HMR /
      // disable), so a reload never stacks duplicate rule sets.
      try {
        ctx.effect(() => () => {
          if (typeof document === 'undefined') return;
          const style = document.getElementById(STYLE_ID);
          if (style && style.dataset && style.dataset.dshGithubLink === '1') style.remove();
        }, 'push: inline stylesheet');
      } catch (err) {
        /* an older host without ctx.effect still works: the style stays */
      }

      /* A. settings.section */
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'push',
          order: 22,
          label: () => 'Push',
        }, (props) => h(SettingsSection, Object.assign({}, props, { ctx }))));
      } catch (err) {
        console.error('push: settings.section registration failed', err);
      }

      /* B. sidebar row icon + its main page.
       *
       * `main` is registered from INSIDE the `sidebar.panellist` injection,
       * which is the working dshmarket pattern: the page is only reachable by
       * clicking that row, so it is registered exactly when the row exists and
       * both disposers retire together. */
      try {
        ctx.slots.inject('sidebar.panellist', () => {
          const offRow = ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'push',
            order: 2,
            label: () => 'Push',
          }, (props) => h(SidebarIcon, props));

          let offPage = null;
          try {
            offPage = ctx.slots.register({
              name: 'main',
              key: 'push',
            }, (props) => h(ReposPage, Object.assign({}, props, { ctx })));
          } catch (err) {
            console.error('push: main page registration failed', err);
          }

          return () => {
            try { if (typeof offRow === 'function') offRow(); } catch (err) { /* already gone */ }
            try { if (typeof offPage === 'function') offPage(); } catch (err) { /* already gone */ }
          };
        });
      } catch (err) {
        console.error('push: sidebar panellist registration failed', err);
      }

      /* C. right-sidebar workspace tab.
       *
       * `betterSidebar` is an OPTIONAL service owned by another bundle, so it
       * is NOT in `inject` (naming it there parks this whole fiber INACTIVE on
       * any host without that plugin, taking the settings page and the sidebar
       * row down with it).
       *
       * A one-shot `ctx.get('betterSidebar')` is not enough either, and this is
       * the subtle part: Client plugins are activated in an arbitrary order, so
       * on a fresh page load this factory can run BEFORE dsh-better-sidebar has
       * provided its service. The probe then reads `undefined` and returns — the
       * tab silently never appears, and only an HMR re-apply (by which time the
       * service exists) makes it show up again. `ctx.inject([...])` is the
       * cordis contract for exactly this: it runs now when the service is
       * present, waits and runs later when it is not, re-runs if the provider
       * restarts, and disposes the registration when the provider goes away.
       */
      const registerWorkspaceTab = (sidebar) => {
        const dispose = sidebar.registerTab({
          id: 'push',
          title: () => t('tabTitle'),
          description: () => t('tabDesc'),
          order: 40,
          single: true,
          icon: (size) => h(GithubMark, { size: size || 16 }),
          component: (props) => h(WorkspaceTab, Object.assign({}, props, { ctx })),
        });
        return typeof dispose === 'function' ? dispose : () => {};
      };

      if (typeof ctx.inject === 'function') {
        try {
          // A scoped child fiber owns the tab: it is created when the service
          // appears and torn down with it, without touching the surfaces above.
          ctx.inject(['betterSidebar'], (scoped) => {
            const sidebar = typeof scoped.get === 'function' ? scoped.get('betterSidebar') : scoped.betterSidebar;
            if (!sidebar || typeof sidebar.registerTab !== 'function') return;
            const dispose = registerWorkspaceTab(sidebar);
            if (typeof scoped.effect === 'function') {
              scoped.effect(() => dispose, 'push: sidebar tab');
            }
          });
        } catch (err) {
          console.error('push: betterSidebar injection failed', err);
        }
      } else {
        // Older host without ctx.inject: best-effort probe only.
        try {
          const sidebar = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : ctx.betterSidebar;
          if (sidebar && typeof sidebar.registerTab === 'function') {
            const dispose = registerWorkspaceTab(sidebar);
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => () => { try { dispose(); } catch (err) { /* already gone */ } }, 'push: sidebar tab');
            }
          }
        } catch (err) {
          console.error('push: betterSidebar tab registration failed', err);
        }
      }
    }

    exports.apply = apply;
    // Only `slots` is mandatory. `locale` and `betterSidebar` are probed with
    // ctx.get: naming a missing service in `inject` parks the fiber INACTIVE,
    // which would take the whole plugin down on hosts without it.
    exports.inject = ['slots'];

    return module.exports;
  },
});
