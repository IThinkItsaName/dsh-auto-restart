# BUG：`dsh_restart` 重启后只“关掉窗口”，桌面窗口没有自动回来

- 状态：**已修，待真实重启复验**（0.1.1，2026-10-19 23:20；修复见文末）
- 记录时间：2026-10-19 22:47（Asia/Shanghai）
- 插件：`dsh-auto-restart@0.1.0`（复现版本；0.1.1 修复。profile `desktop` 里是 `link:D:\Program Files (x86)\dsh_manner_space\publish\dsh-auto-restart`）
- 宿主：DSH Desktop 0.2.1-rc.2（Electron 44，Windows x64）
- 现场 restartId：`restart-mvfd5tnw-ed2007dd`
- journal 目录：`C:\Users\22936\.dsh\dsh-auto-restart\restart-mvfd5tnw-ed2007dd\`

## 一句话

宿主**确实重启了**（新 host pid、新端口），但**桌面窗口没有重新出现**，用户看到的是"旧窗口消失 → 没有新窗口"，于是判断成"只是关了窗口，DSH 没重启"。

## 复现

1. `dsh_restart`（先 `dryRun: true` 正常：`1 active session(s) would be interrupted. Permission: workspace-write in mode danger-full-access.`）
2. 再调 `dsh_restart`（非 dryRun）：返回 `Restart scheduled: restart-mvfd5tnw-ed2007dd ...`
3. 观察：桌面窗口关闭；随后没有新的应用窗口出现；通过旧的 web 端口也连不上（换了新端口）。

## journal 里实际发生过什么

```
helper.log:
  14:42:41.941 helper started pid=14560 dryRun=false
  14:42:41.944 ack written
  14:42:42.444 killing targets
  14:42:42.445 killed pid 10956           ← 桌面主进程 desktopPid
  14:42:42.597 targets stopped
  14:42:44.132 relaunched pid=21076       ← 新桌面进程确实起来了
  14:42:47.201 new host reported ready

host-ready.json:
  { "at":"14:42:46.969Z", "newHostPid":26660, "webUrl":"http://127.0.0.1:55470", "restartId":"restart-mvfd5tnw-ed2007dd" }

relaunch.log:
  Checking for update
  Update for version 0.2.1-rc.2 is not available ...
  dsh inspector: devtools://...
  dsh web: http://127.0.0.1:55470/?token=…      ← 新宿主已起
  [llm-deepseek-account] model listing … loaded 2 model(s)
```

旁证：`Get-Process` 里当前所有 `DeepSeek Harness` 进程的启动时间都是 **22:42:44**（= `relaunched` 那一刻），说明新桌面进程起得来，宿主与新 web 端口 `55470` 也正常；resume / 会话恢复链路也走通了（调用方会话在新宿主上继续）。

## 根因（高置信）

`lib/helper.mjs` 的 `launchFreshApp()`：

```js
const child = spawn(launch.executable, args, {
  cwd: ...,
  env,                 // 已清掉 ELECTRON_RUN_AS_NODE / ELECTRON_NO_ASAR（这段是对的）
  detached: true,
  windowsHide: true,   // ← 问题在这一行（helper.mjs:131）
  stdio: ['ignore', fd, fd],
})
```

Windows 上 `windowsHide: true` 等价于给子进程套 `CREATE_NO_WINDOW` / `SW_HIDE`。对**GUI 应用（Electron 桌面壳）**用它，结果是：Electron 主进程、宿主、web 端口全部正常起来，但**窗口被隐藏**，用户看不到。

也就是说：helper 自己用 Node 模式跑没问题（`spawnHelper` 里 `windowsHide: true` 是合理的），但**再启动 GUI 的那一支不能继承隐藏窗口**。

## 建议修法

1. **desktop 模式 relaunch 时 `windowsHide: false`**（或直接省略该选项）；CLI 模式可继续隐藏。
   最小改动：`launchFreshApp` 里 `windowsHide: launch.mode === 'desktop' ? false : true`。
2. 顺手加一道**窗口可见性兜底**：relaunch 后若 `host-ready.json` 已到、但桌面进程 5–10 秒内没有可见窗口（可用 Electron 侧上报，或 Windows 上 `EnumWindows` 按 pid 查），在 journal 里写 `warning: window-not-visible`，并在 resume 提示里附一句"窗口可能没弹出来，请手动启动一次"。
3. 如果以后支持 dev Electron（非打包），`detectLaunch` 的 `unsupported-launch` 分支也建议保留同样的隐藏策略区分。
4. （可选）relaunch 成功后写一个 `window-check.json` 或在 `host-ready.json` 里带上 `desktopPid`，方便排查"进程在、窗口没在"这类问题。

## 相关文件

- `lib/helper.mjs:113-149`（`launchFreshApp`，第 131 行 `windowsHide: true`）
- `lib/launch.js:107-121`（`spawnHelper`：这里隐藏 helper 本身是对的）
- `lib/launch.js:30-38`（`sanitizeRelaunchEnv`：清理 Node 模式的逻辑正确，可保持）
- journal 样本：`%USERPROFILE%\.dsh\dsh-auto-restart\restart-mvfd5tnw-ed2007dd\`

## 备注

- 本次测试由调用方 session `session-16c94123-…` 发起，宿主 pid 9044、桌面主进程 10956、新桌面 pid 21076、新 host pid 26660。
- 记录写入时应用仍由新实例在跑（GUI 地址 `http://127.0.0.1:55470`）；用户计划稍后手动重启一次。
- 该记录留给负责修这个插件的会话；修完请把本条标为已处理并在 CHANGELOG 里留一行。

## 修复（0.1.1，2026-10-19 23:20）

- `lib/helper.mjs` 新增 `relaunchWindowsHide(mode)`：desktop 返回 `false`，CLI 返回 `true`；`launchFreshApp()` 改为 `windowsHide: relaunchWindowsHide(launch.mode)`。GUI 窗口不再被 `CREATE_NO_WINDOW` 隐藏；helper 自身的 `spawn` 仍保持隐藏。
- 新增窗口兜底：desktop relaunch 后等待 `windowCheckMs`（默认 4s），用 Windows PowerShell `Get-Process` 探测主窗口标题/句柄，写 `window-check.json`（`visible`/`state`/`title`）；hidden/unknown 都会进 journal。
- 新宿主 resume 在注入 caller 前最多等 `windowCheckWaitMs`（默认 7s）读该 marker；若 `visible === false`，在 caller 续跑消息末尾附一句“窗口可能没弹出来，请手动启动 DSH”。不影响 other 会话。
- 增加 `windowCheckMs` / `windowCheckWaitMs` 两个 volatile 配置。
- 同时修一个 journal 旁证暴露的问题：0.1.0 只有 `host-ready`、没有 `results.jsonl`，怀疑 `resumeJournal` 用 `this.ctx.get('sessionController')` 在 sibling group 下解析不到而静默跳过。coordinator 现在把运行时服务查找切到 `ctx.inject` 给的子 scope（`runtime()`），并把这个 scope 传给 `resumeJournal`；新宿主加载后生效。
- 测试：`tests/window.test.mjs` 2 个用例（desktop/CLI hide split、probe 输出解析）通过；`tests/helper.test.mjs` dry-run 通过；`node --check` 通过。用当前可见进程实测 probe 输出 `visible|查看评审反馈问题 — DeepSeek Harness`。
- 生效说明：helper 每次重启都是重新从磁盘加载的，所以**下一次 `dsh_restart` 就使用新的 `windowsHide`**；`resume.js` 的窗口提示与 runtime scope 修复由重启后的新宿主加载，也在同一次重启生效。
