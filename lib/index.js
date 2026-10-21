import z from '@deepseek-ai/schemastery'
import { AutoRestartService } from './coordinator.js'
import { DEFAULT_CALLER_PROMPT, DEFAULT_OTHER_PROMPT } from './messages.js'
import { createStatusState } from './status-state.js'
import { mountStatusRoute } from './status-route.js'

export const name = 'dsh-auto-restart'

/**
 * Runtime configuration.
 *
 * The settings card edits the volatile fields only. Values are references
 * inside `apply()`; every consumer must dereference them at use time.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  permissionPolicy: z.union(['workspace-write', 'danger-full-access']).default('workspace-write').volatile(),
  confirm: z.boolean().default(true).volatile(),
  resumeCallers: z.boolean().default(true).volatile(),
  resumeOthers: z.boolean().default(true).volatile(),
  maxResumeSessions: z.number().default(0).volatile(),
  maxResumeConcurrency: z.number().default(2).volatile(),
  resumeStaggerMs: z.number().default(1500).volatile(),
  startupDelayMs: z.number().default(3000).volatile(),
  goTimeoutMs: z.number().default(30000).volatile(),
  shutdownGraceMs: z.number().default(10000).volatile(),
  windowCheckMs: z.number().default(4000).volatile(),
  windowCheckWaitMs: z.number().default(7000).volatile(),
  relaunchDelayMs: z.number().default(1500).volatile(),
  relaunchWaitMs: z.number().default(60000).volatile(),
  expiryMs: z.number().default(600000).volatile(),
  cooldownMs: z.number().default(60000).volatile(),
  callerResumePrompt: z.string().default(DEFAULT_CALLER_PROMPT).volatile(),
  otherResumePrompt: z.string().default(DEFAULT_OTHER_PROMPT).volatile(),
  journalDir: z.string().default(''),
  launch: z.object({
    mode: z.union(['desktop', 'cli']).default('desktop'),
    executable: z.string().default(''),
    args: z.array(z.string()).default([]),
    cwd: z.string().default(''),
  }).default({}),
})

/**
 * Host plugin entry.
 *
 * The coordinator is constructed even when optional session services are not
 * ready yet; it waits through its own `ctx.inject`. A broken restart plugin
 * therefore only loses the restart capability, never the whole profile.
 */
export function apply(ctx, config) {
  const status = createStatusState()
  // The tool row reads this service; a profile that mounts the tool without the
  // host row gets the documented "unavailable" answer instead of a crash.
  try {
    ctx.provide('autoRestartStatus', status)
  } catch {
    // A host without the service registry still keeps the restart coordinator.
  }
  const report = (message) => {
    try {
      ctx.logger?.('dsh-auto-restart')?.warn?.(message)
    } catch {
      // Logging must never take the plugin down.
    }
  }
  ctx.effect(() => mountStatusRoute(ctx, status, report), 'dsh-auto-restart: status route')

  new AutoRestartService(ctx, config, status)

  ctx.inject(['settings'], (scope) => {
    scope.effect(
      () => scope.settings.configure({ auto: false }, ctx.fiber),
      'dsh-auto-restart: settings presentation',
    )
  })
}
