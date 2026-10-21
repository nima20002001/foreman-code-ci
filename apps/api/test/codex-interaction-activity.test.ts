import { describe, expect, it } from 'vitest'
import { CODEX_UNSUPPORTED_INTERACTION_ERRORS } from '@foreman-code/contracts'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

describe('unsupported Codex interaction Run activity', () => {
  it.each(Object.entries(CODEX_UNSUPPORTED_INTERACTION_ERRORS))('shows %s without exposing native input', (code, message) => {
    const f = currentUnitSnapshot('interaction-error')
    const row: ActivityReadRow = { sequence: '1', source: 'harness', kind: 'harness_output',
      occurred_at: new Date('2026-10-04T00:00:00Z'), harness_execution_id: null,
      execution_node_id: null, execution_agent_id: null, execution_attempt: null,
      work_activation_id: null, result_outcome: null, safe_payload: {}, native: {
        type: 'interaction.unsupported', unsupportedInteractionCode: code, message: 'private native request',
      } }
    const activity = publicRunActivity(row, f.version, f.run.id, f.run.outcome)
    expect(activity).toMatchObject({ kind: 'error', status: 'failed', severity: 'error', summary: message })
    expect(JSON.stringify(activity)).not.toContain('private native request')
    expect(publicRunActivity({ ...row, native: { ...row.native, unsupportedInteractionCode: 'private text' } },
      f.version, f.run.id, f.run.outcome).summary).toBe('Native activity recorded; details unavailable')
  })
})
