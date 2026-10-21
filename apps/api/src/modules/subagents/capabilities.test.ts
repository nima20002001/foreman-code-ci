import { describe, expect, it } from 'vitest'
import { subagentCapabilities, type RunSubagent } from '@foreman-code/contracts/subagents'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { subagentAvailableActions } from './capabilities.js'
const principal: ManagementPrincipal = { id: 'p', name: 'Scoped', audience: 'operator', grants: [{ actions: ['runs:read', 'runs:subagents:input', 'runs:stop'], scope: { runIds: ['r'] } }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
const child = { id: 'child', workspaceId: 'w', workflowId: 'wf', runId: 'r', status: 'running', evidence: 'confirmed', provider: 'codex', nativeMode: 'codex-multi-agent-v2',
  capabilities: subagentCapabilities('codex-multi-agent-v2') } as RunSubagent
const lease = { generation: 'g', nativeTurnId: 't', matches: () => true, assertCurrent: () => {}, sendInput: async () => {}, interrupt: async () => {} }
describe('native mode and current child action gates', () => {
  it('keeps retired children readable without allowing their recorded controls to execute', () => {
    const retired = { ...child, provider: 'opencode' as const, nativeMode: 'opencode-task' as const,
      capabilities: { ...child.capabilities,
        sendInput: { support: 'supported' as const, qualification: 'passed' as const },
        interrupt: { support: 'supported' as const, qualification: 'passed' as const },
        inputTiming: 'active' as const,
      } }
    const saved = structuredClone(retired)
    expect(subagentAvailableActions(retired, principal, false, lease)).toEqual({
      sendInput: false, interrupt: false, blockedReason: 'SUBAGENT_CONTROL_UNAVAILABLE',
    })
    expect(retired).toEqual(saved)
  })
  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('requires qualified owned %s controls and separate grants', nativeMode => {
    const qualified = { ...child, nativeMode, native: { ...child.native, currentTurnId: 't' }, capabilities: {
      ...child.capabilities, sendInput: { support: 'supported' as const, qualification: 'passed' as const },
      interrupt: { support: 'supported' as const, qualification: 'passed' as const }, inputTiming: 'active' as const,
    } }
    expect(subagentAvailableActions(qualified, principal, false, lease)).toEqual({
      sendInput: true, interrupt: true, blockedReason: null,
    })
    expect(subagentAvailableActions(qualified, principal, false)).toEqual({
      sendInput: false, interrupt: false, blockedReason: 'SUBAGENT_CONTROL_UNAVAILABLE',
    })
    expect(subagentAvailableActions(qualified, { ...principal, grants: [{ actions: ['runs:read'], scope: {} }] },
      false, lease)).toMatchObject({ sendInput: false, interrupt: false })
    expect(subagentAvailableActions(qualified, principal, true, lease)).toMatchObject({ sendInput: false, interrupt: false })
  })
  it('requires exact live lease, scoped permission and a clear Run-stop fence', () => {
    const qualified = { ...child, provider: 'codex' as const, nativeMode: 'codex-collab' as const, status: 'waiting' as const,
      capabilities: { ...subagentCapabilities('codex-collab'), inputTiming: 'idle' as const, sendInput: { support: 'supported' as const, qualification: 'passed' as const } } }
    expect(subagentAvailableActions(qualified, principal, false, { ...lease, nativeTurnId: null }).sendInput).toBe(true)
    expect(subagentAvailableActions(qualified, principal, false, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, true, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, false).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, { ...principal, grants: [{ actions: ['runs:read'], scope: {} }] }, false, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, false, { ...lease, matches: () => false }).sendInput).toBe(false)
  })
})
