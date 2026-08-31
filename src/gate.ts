/**
 * Approval gate for the intranet/local debugging browser.
 *
 * Every `intranet_*` tool call passes through `tools/pre-execute` before it can
 * do anything. Because the SSRF guard is deliberately bypassed, the gate is the
 * plugin's primary safety mechanism.
 *
 * Behavior by the CALLING SESSION's approval policy (the host's own fold of
 * `approval/policy` events, default `'ask'`):
 *
 * - `'ask'` (workspace-write, the default) — by default (`approvalMode:
 *   'per-call'`) EACH call asks the user through `ctx.approval`; with
 *   `approvalMode: 'arm'`, one approved `intranet_arm` call arms the current
 *   agent and later calls run without prompting until `intranet_disarm`.
 * - `'never'` (danger-full-access) — the user has already opted out of approval
 *   prompts at the session level, so `intranet_*` calls auto-pass, matching the
 *   trust level every other tool (shell, fs) already runs under. Without this,
 *   full-access sessions would hard-fail every intranet call, which makes the
 *   "full access" preset useless for local/intranet debugging.
 *
 * @module dsh-intranet-browser/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'

export type ApprovalPolicy = 'ask' | 'never'

/** Pure, unit-testable decision: what should the gate do for one tool call? */
export type GateAction =
  | { kind: 'pass' } // not ours, already armed / disarming, or full-access session
  | { kind: 'ask-arm' } // intranet_arm: always ask, then arm on approval
  | { kind: 'ask' } // every other intranet_* call when approval is required
  | { kind: 'disarm' } // intranet_disarm: no approval needed

export function gateAction(
  toolName: string,
  config: Pick<Config, 'approvalMode'>,
  isArmed: boolean,
  policy: ApprovalPolicy = 'ask',
): GateAction {
  if (!toolName.startsWith('intranet_')) return { kind: 'pass' }
  if (toolName === 'intranet_disarm') return { kind: 'disarm' }
  // Full-access sessions auto-approve: the user opted out of approval prompts
  // at the session level (approval policy 'never').
  if (policy === 'never') return { kind: 'pass' }
  if (toolName === 'intranet_arm') return { kind: 'ask-arm' }
  if (config.approvalMode === 'arm' && isArmed) return { kind: 'pass' }
  return { kind: 'ask' }
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Structural subset of the host's approval service (`ctx.approval`). */
interface ApprovalLike {
  config?: { policy?: ApprovalPolicy }
  request(req: {
    agent?: unknown
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * The calling session's effective approval policy: the last `approval/policy`
 * event in the agent's session log, else the host's configured default.
 * Mirrors the host fold (`effectiveApprovalPolicy` in
 * `@deepseek-ai/dsh-user-approval`) with a local duck-typed read, so this
 * plugin has no extra runtime resolution requirements.
 */
export function sessionApprovalPolicy(approval: ApprovalLike | undefined, agent: unknown): ApprovalPolicy {
  const events = (agent as
    | { session?: { events?: ReadonlyArray<{ type?: string; data?: { policy?: string } }> } }
    | undefined)?.session?.events
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'approval/policy') {
        const policy = event.data?.policy
        if (policy === 'ask' || policy === 'never') return policy
      }
    }
  }
  return approval?.config?.policy ?? 'ask'
}

/** A human-readable reason for the approval prompt, including the target URL when present. */
export function approvalReason(toolName: string, args: unknown): string {
  if (toolName === 'intranet_open' || toolName === 'intranet_open_tab') {
    const url = typeof args === 'object' && args !== null ? (args as { url?: unknown }).url : undefined
    if (typeof url === 'string' && url) {
      return `Allow intranet/local access to ${url}? (SSRF guard is bypassed for the intranet browser)`
    }
  }
  return `Allow intranet/local browser action (${toolName})? (SSRF guard is bypassed for the intranet browser)`
}

export interface GateDeps {
  getConfig(): Config
  /** Arm/disarm state shared with the tool layer; agent-id keyed. */
  armState: {
    isArmed(agentId: string): boolean
    arm(agentId: string): void
    disarm(agentId: string): void
  }
}

/** Register the `tools/pre-execute` gate covering every `intranet_*` tool. */
export function registerApprovalGate(ctx: Context, deps: GateDeps): void {
  const { getConfig, armState } = deps
  const approval = ctx.get('approval') as ApprovalLike | undefined

  const ask = async (
    exec: { agent?: unknown; callId?: unknown; signal?: AbortSignal },
    toolName: string,
    args: unknown,
  ): Promise<ApprovalOutcome | undefined> => {
    // Fail closed: without an agent or an approval service there is no way to
    // get user consent, so the call must not run.
    if (!approval || !exec.agent) return undefined
    try {
      return await approval.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason: approvalReason(toolName, args),
        signal: exec.signal,
      })
    } catch {
      return undefined
    }
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const policy = sessionApprovalPolicy(approval, exec.agent)
    const action = gateAction(
      exec.name,
      getConfig(),
      exec.agent?.id ? armState.isArmed(exec.agent.id) : false,
      policy,
    )
    switch (action.kind) {
      case 'pass':
        return next()
      case 'disarm': {
        if (exec.agent?.id) armState.disarm(exec.agent.id)
        return next()
      }
      case 'ask-arm': {
        const outcome = await ask(exec, exec.name, exec.arguments)
        if (outcome === 'allowed-once' && exec.agent?.id) {
          armState.arm(exec.agent.id)
          return next()
        }
        return { kind: 'deny', reason: 'Intranet browser activation was not approved.' }
      }
      case 'ask': {
        const outcome = await ask(exec, exec.name, exec.arguments)
        if (outcome === 'allowed-once') return next()
        return { kind: 'deny', reason: `Access was not approved: ${approvalReason(exec.name, exec.arguments)}` }
      }
    }
  })
}
