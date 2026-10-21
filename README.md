# dsh-auto-restart

创造模式（`cordis` preset）中的 DSH 自动重启工具。**工具描述里写明了准入规则：只有确认「必须重启才能达到目的」且没有更简单的替代方案（重载组件、改配置、新开会话、重试等）时才调用。** 模型调用 `dsh_restart` 后：

1. 记录调用方与其他活动会话（含排队输入、运行中 job、已装载提醒的计数）；
2. 起一个脱离宿主进程树的 helper；
3. 等调用方工具结果落盘、活动会话停稳并 flush 后，由 helper 关闭 Electron 主进程（host 通过 IPC 断开自我优雅退出）并重启应用；
4. 新宿主按 journal 恢复调用方与其他活动会话，注入 **user 角色内容、以 notice 来源呈现**的续跑通知（不是用户气泡，也不是 tool 角色），并自动补上幂等 marker。

同时提供设置卡片：权限准入策略、重启前确认、是否恢复其他会话、两段续跑提示词。布局沿用 dsh-lore 设置页的单层列表：左侧标签/说明、右侧控件、行下细分隔线，开关用官方 `Switch` 原语。设置值写入 profile patch，**改值不需要重启 DSH**。

**与官方的关系**：DSH 生产环境没有模型可调用的重启。桌面主进程的 `app.relaunch()` 只出现在崩溃恢复对话框和开发模式菜单；`Restart App and Host` 菜单包在 `...development ? [...] : []` 里，打包版不显示。`dsh_restart` 填的就是这个空档。

> 刷新页面的 `dsh_reload` 已移除（0.1.9）。运行中改写客户端 bundle 再 reload 会引入 boot 竞态；客户端半边改完请直接 `dsh_restart` 宿主。

## 安装

在 profile 中安装本地 bundle：

```powershell
dsh plugin --profile desktop add "file:D:\Program Files (x86)\dsh_manner_space\publish\dsh-auto-restart"
```

或通过 `plugin_manager` 的 `install_bundle` 使用同一个绝对路径。

首次安装需要**手动重启一次 DSH**，因为 host 行和 `preset-cordis` 覆盖在宿主启动时生效；安装/升级客户端半边后同样需要**重启一次 DSH**（宿主重启会重载页面并加载新的客户端代码）。之后修改设置值不需要重启。

## 设置卡片

位置：**Settings → Plugins → dsh-auto-restart**。

| 字段 | 说明 |
|---|---|
| 权限策略 | `workspace-write`：workspace-write 或更高权限下免提权；`danger-full-access`：只有 danger-full-access 下免提权，低权限会话先请求一次提权批准。 |
| 重启前确认 | 达到权限级别后是否仍询问一次。关闭它才是真正的“自行使用”；低权限提权批准不受此开关影响。 |
| 恢复其他活动会话 | 关闭后只恢复调用方；其他会话仍会被打断和记录。 |
| 调用方续跑提示词 | 支持 `{{restartId}}`、`{{reason}}`、`{{time}}`；marker 由宿主自动加。 |
| 其他会话续跑提示词 | 支持 `{{restartId}}`、`{{time}}`；`{{reason}}` 会被替换为“another session requested it”，避免泄露调用方原因。 |

**权限选项是准入/同意策略，不是 OS 沙箱。** helper 必须写 `~/.dsh`、spawn 进程、关闭 Electron/host，因此它始终在宿主进程外运行；这个选项只决定模型在什么会话沙箱级别下可以免“提权批准”调用，不会把 helper 关进工作区。

设置修改通过 DSH 的 `configForms` → `settings` → `config-editor` 写入当前 profile 的 `cordis.patch.yml`；对应 `Config` 字段标记为 `.volatile()`，宿主在每次 request/resume 时现读。修改 `Config` 的字段名/类型/数量仍然需要重启；只改值是热生效的。

## 配置项

`Config` 位于 `lib/index.js`。除设置卡片外，常用字段：

- `resumeCallers`（默认 `true`）：是否恢复调用方。
- `maxResumeSessions`（默认 `0` = 不限）：恢复总数上限。
- `maxResumeConcurrency`（默认 `2`）、`resumeStaggerMs`（默认 `1500`）。
- `startupDelayMs`（默认 `3000`）：新宿主启动后等待再注入。
- `goTimeoutMs`（默认 `30000`）：helper 等 `go` 的上限；超时**不杀**，写 aborted 退出。
- `shutdownGraceMs` / `relaunchDelayMs` / `relaunchWaitMs` / `expiryMs` / `cooldownMs`。
- `windowCheckMs`（默认 `4000`）/ `windowCheckWaitMs`（默认 `7000`）：desktop relaunch 后用 PowerShell 探测主窗口是否可见；`windowCheckMs` 后开始探测，若还是 `hidden`/`unknown` 则每 500 ms 重试到 `windowCheckWaitMs` 用完；仍不可见时在 caller 续跑消息末尾提示手动启动。CLI 模式跳过。
- `journalDir`：默认 `~/.dsh/dsh-auto-restart`（受 `DSH_HOME` 影响）。
- `launch`：打包桌面版自动识别；dev Electron / CLI 需要显式配置 `{mode, executable, args, cwd}`。

## 工作方式

- **journal + helper**：`~/.dsh/dsh-auto-restart/<restartId>/` 下原子写入请求、`go`、`killing`、`results` 等状态；`lib/helper.mjs` 以 `detached + stdio:ignore` 运行，先关 Electron 主进程让 host 优雅退出，host 超时才强杀（**不使用 `taskkill /T`**），再重启应用。
- **续跑**：`resolveAgent()` + `agent.followup(createUserMessage({ source: { kind: 'dsh-auto-restart', form: 'notice' } }))` 注入 notice（与后台 job 完成通知同一形制，不占用户气泡）；注入前读 session log 查 marker，崩溃重试不会重复。缺少相关 API 时回退到 `sessionController.prompt()`。
- **草稿清理**：重启后宿主在只读路由 `GET /plugins/dsh-auto-restart/status.json` 发布 `{ draftHints }`；浏览器半边加载后轮询，把"非空且是最后一条人类消息前缀"的残留草稿清掉（`lib/draft-guard.js`，含 IME 公共前缀规则），真正没发的草稿不动。

## 已知限制

- 打包桌面版是主目标；dev Electron 不自动猜启动命令，必须配置 `launch`。
- 桌面 host 使用 `--port 0`，端口每次变化：外部浏览器标签页不会自动跳转，桌面窗口由 Electron 主进程重新加载。
- 重启会让未加载的空闲会话中的定时提醒在新进程中无法触发，直到手动打开那个会话。
- notice 呈现依赖 Chat 的 `form: 'notice'` 分类（DSH 0.2.1 起）；升级 DSH 后若分类变化，续跑会退回普通注入行/用户消息。
- 草稿清理是**前缀启发式**：极小概率下，一个真正没发、又恰好是上一条消息前缀的草稿会被一并清掉。
- 如果插件自身把宿主启动弄坏，这个工具无法从"宿主起不来"中自救；请用桌面崩溃恢复禁用插件，或回退 profile patch。

## License

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 IThinkItsaName。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
