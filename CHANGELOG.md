# Changelog

## 0.1.8

- Simplify the settings card to a single-level list: removed the three section headings (重启 / 页面刷新 / 续跑提示词) and the two footer notes. Each row keeps only its label, the field hint and the control; the reload switch now sits with the other switches above the two resume prompts.

## 0.1.7

- `dsh_reload` is now opt-in: new `reloadEnabled` setting (default **off**) in the plugins settings card. While off the tool refuses with a message pointing at the switch; the value is read live through a gate, so toggling it needs no restart.
- The reload result now carries evidence instead of just "requested": the browser sends a per-page `boot` id on every status poll; `dsh_reload` waits up to 4 s for a **new** page instance, then reports whether the reload landed, the elapsed time, the new boot id and host uptime — or, on timeout, the last heartbeat age so a disconnected/paused window is distinguishable from a slow one.
- Settings card redesigned to match dsh-lore's settings page: uppercase section titles (重启 / 页面刷新 / 续跑提示词), label+hint on the left / control on the right rows with 0.5 px separators, `--dsw-alias-label-*` tokens, and the official `Switch` primitive (with a plain-checkbox fallback if a host lacks it).

## 0.1.6

- Add `dsh_reload`: refresh the DSH web UI without restarting the backend. The host records a reload request on a read-only status route (`GET /plugins/dsh-auto-restart/status.json`); the browser half polls it, reloads the page once, and the host/agent turn keeps running.
- Fix the post-restart stale draft: after a resume the host now publishes, per resumed session, the last human message it found in the session log; the browser half clears a persisted draft that is a non-empty prefix of that message (the killed renderer can leave a stale throttled snapshot), while genuinely unsent drafts are left alone.
- Both consumers share one status route; the browser half polls every 1.2 s while the page is alive.

## 0.1.5

- Fix: the window probe ran once, `windowCheckMs` after relaunch, and wrote `hidden` if the Electron window had not got its title yet — observed on the 21:55 restart: process 6132 had a visible window moments later, but the caller still received the "start DSH manually" note. The probe now retries every 500 ms until `windowCheckWaitMs` is spent or the window becomes visible.

## 0.1.4

- Docs: `dsh_restart` now states the admission rule explicitly — only after confirming a restart is required to reach the goal and no simpler alternative exists (reload, config edit, new session, retry). Behaviour unchanged.

## 0.1.3

- Change: the post-restart continuation is delivered as an injected **notice** (`user/message` with `source.kind = dsh-auto-restart`, `form = notice`) via `sessionController.resolveAgent()` + `agent.followup()`, matching background-job completion notices, instead of `sessionController.prompt()` which renders in the user's message bubble. The Agent still receives the text as a user turn.
- Fallback: when the host exposes neither `resolveAgent` nor `@deepseek-ai/dsh-llm`'s `createUserMessage`, the resume keeps the 0.1.x prompt path; the journal records `delivery: "prompt"` instead of `"notice"`.
- Dedup now also recognizes the notice source, so a crash between delivery and result write cannot duplicate the resume.

## 0.1.2

- Fix: the window probe joined `if` / `elseif` / `else` with `; `, so PowerShell parsed `elseif` as a new command and exited 1 on every run; every restart recorded `probe-failed` and the "window not visible" resume note could never fire. The chain is now built as one statement by `buildWindowProbeScript()`.
- Add a Windows live regression test (`window probe actually runs on Windows`) plus a shape guard against `; elseif`; suite 31/31.

## 0.1.1

- Fix: desktop relaunch no longer passes `windowsHide: true`, which hid the Electron GUI window while the host and web server were healthy.
- Add a best-effort visible-window probe (`window-check.json`) and a caller resume note when the relaunched desktop process has no visible main window.
- Add `windowCheckMs` / `windowCheckWaitMs` config and tests for the desktop/CLI hide split and probe output parsing.

## 0.1.0

- Initial creation-mode `dsh_restart` tool with caller/other active-session journal.
- Detached helper: graceful Electron-main shutdown, host IPC disconnect, relaunch, host-ready wait.
- Startup resume with caller/other user-role notices, idempotent markers, expiry, single-flight, watchdog.
- Permission admission policy (`workspace-write` / `danger-full-access`) and editable resume prompts.
- Settings card through `ctx.configForms` / `plugins.bundle.config`; volatile values apply without restart.
- Generated `preset-cordis` override plus drift checker.
