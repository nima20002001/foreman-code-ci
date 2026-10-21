import { describe, expect, it } from 'vitest'
import type { HarnessMcpPlan } from '@foreman-code/contracts/management'
import { managedMcpFailed, managedMcpSucceeded, reserveManagedMcpOperation } from './managedMcpOperation'
const input = { harness: 'codex' as const, preset: 'graphql' as const, installed: true,
  commandId: 'original-command-identity', expectedRevision: `sha256:${'a'.repeat(64)}` }
const plan = { id: 'original-plan', harness: 'codex', status: 'pending', error: 'Another change is busy.' } as HarnessMcpPlan

describe('managed MCP operation lifetime', () => {
  it('retains accepted plan and command identity through a busy decision and retry', () => {
    const accepted = managedMcpSucceeded(reserveManagedMcpOperation(input), plan)!
    const retry = managedMcpFailed(accepted, Object.assign(new Error('Busy'), { status: 409, code: 'MCP_SETTINGS_BUSY' }))!
    expect(retry.input).toEqual(input)
    expect(retry.plan?.id).toBe(plan.id)
    expect(retry.phase).toBe('retry')
  })
  it('keeps an unknown request immutable even after a later structured 4xx', () => {
    const lost = managedMcpFailed(reserveManagedMcpOperation(input), new TypeError('Network lost'))!
    const again = managedMcpFailed(lost, Object.assign(new Error('Conflict'), { status: 409, code: 'REVISION_CONFLICT' }))!
    expect(again.input).toEqual(input)
    expect(again.uncertainDelivery).toBe(true)
  })
  it('only clears a first pre-plan rejection or a terminal accepted result', () => {
    expect(managedMcpFailed(reserveManagedMcpOperation(input), { status: 409, code: 'MCP_PRESET_CUSTOMIZED' })).toBeNull()
    for (const status of ['pending', 'submitting', 'uncertain'] as const) {
      expect(managedMcpSucceeded(reserveManagedMcpOperation(input), { ...plan, status })).not.toBeNull()
    }
    for (const status of ['applied', 'rejected', 'failed', 'reconciled'] as const) {
      expect(managedMcpSucceeded(reserveManagedMcpOperation(input), { ...plan, status })).toBeNull()
    }
  })
})
