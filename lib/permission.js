/**
 * Admission policy for the restart tool.
 *
 * This is intentionally *not* an OS sandbox. The host-side helper always runs
 * with the host process's own file/process access; the policy only decides when
 * the model may use the privileged action without an extra approval.
 */

export const MODE_RANK = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
})

export const PERMISSION_POLICIES = Object.freeze(['workspace-write', 'danger-full-access'])

export function rankOf(mode) {
  return Object.prototype.hasOwnProperty.call(MODE_RANK, mode) ? MODE_RANK[mode] : -1
}

export function normalizePolicy(policy) {
  return policy === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'
}

/**
 * Resolve the approval requirement for one call.
 *
 * `escalationRequired` is true when the current session mode is below the mode
 * selected in settings. `approvalRequired` also covers the independent
 * "confirm every restart" switch. A false `confirm` never bypasses escalation.
 */
export function permissionDecision({ policy, confirm, currentMode } = {}) {
  const normalizedPolicy = normalizePolicy(policy)
  const requiredRank = normalizedPolicy === 'danger-full-access' ? 2 : 1
  const currentRank = rankOf(currentMode)
  return {
    policy: normalizedPolicy,
    currentMode: typeof currentMode === 'string' ? currentMode : 'unknown',
    requiredRank,
    escalationRequired: currentRank < requiredRank,
    approvalRequired: currentRank < requiredRank || confirm === true,
  }
}

function boundReason(reason) {
  const text = String(reason ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= 400 ? text : `${text.slice(0, 399)}…`
}

/**
 * Human-readable approval reason. It states both the admission mode and the
 * destructive effect, so the user can decide with the actual context.
 */
export function approvalReason({ policy, currentMode, escalationRequired, reason, activeSessions, runningJobs, reminders } = {}) {
  const parts = []
  if (escalationRequired) {
    parts.push(`当前会话权限是 ${currentMode ?? 'unknown'}，设置要求 ${policy}，因此这次需要一次提权批准。`)
  } else {
    parts.push(`当前会话权限是 ${currentMode ?? 'unknown'}，按设置可以直接执行，但重启前仍需确认。`)
  }
  parts.push(`将中断 ${Number(activeSessions) || 0} 个活动会话、${Number(runningJobs) || 0} 个运行中任务、${Number(reminders) || 0} 个已装载提醒。`)
  if (reason) parts.push(`原因：${boundReason(reason)}`)
  parts.push('此批准只授权本次重启；辅助进程在宿主进程外运行。')
  return parts.join(' ')
}

export function permissionSummary(decision) {
  if (!decision) return ''
  return `${decision.policy} (mode=${decision.currentMode}, escalation=${decision.escalationRequired ? 'yes' : 'no'})`
}
