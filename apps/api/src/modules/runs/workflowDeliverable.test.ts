import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { deliverableRepairPrompt, deliverableVerdict } from '../interactions/deliverable.js'
import { referencesCreatedByExecution, workflowDeliverableContract, workflowDeliverableFailure } from './workflowDeliverable.js'

const known = '7d1c9a52-3f0e-4c41-9a43-3c7a8f1f2b10'
const foreign = '2f1c9a52-3f0e-4c41-9a43-3c7a8f1f2b11'

function fixture(tickets = [known, foreign, known, 'invalid-ticket']) {
  const saved = makeCurrentWorkflowFixture('deliverable-references')
  const node = saved.version.definition.nodes[0]!
  node.outputSchema = { type: 'array', items: { type: 'string', 'x-foreman-reference': 'ciTicket' } }
  const execution: HarnessExecution = { id: 'execution', runId: saved.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId]!,
    attempt: 1, input: {}, state: 'completed', createdAt: saved.version.createdAt,
    finishedAt: saved.version.createdAt, result: { outcome: 'succeeded', output: { text: JSON.stringify(tickets) } } }
  const lookup = vi.fn(async (_query: string, values: unknown[]) => {
    const ids = Array.isArray(values[0]) ? values[0] : [values[0] ?? known]
    return { rows: ids.includes(known) && values[1] === saved.version.workspaceId && values[2] === execution.id
      ? [{ id: known }] : [] }
  })
  return { version: saved.version, execution, lookup }
}

describe('workflow deliverable reference lookups', () => {
  it('provides repair candidates from this execution even when every submitted ID is unknown', async () => {
    const f = fixture([foreign, 'mistyped-ticket'])
    const contract = workflowDeliverableContract(f.version, f.execution,
      (kind, values) => referencesCreatedByExecution({ query: f.lookup }, kind, values, f.version.workspaceId, f.execution.id))!
    const verdict = await deliverableVerdict(f.execution.result!, contract)
    expect(verdict).toMatchObject({ code: 'OUTPUT_REFERENCE_UNKNOWN' })
    const prompt = deliverableRepairPrompt(verdict!, contract.outputSchema)
    expect(prompt).toContain(`Valid ciTicket IDs (closest match first): ${JSON.stringify([known])}`)
    expect(prompt).not.toContain(`Valid ciTicket IDs (closest match first): ${JSON.stringify([foreign])}`)
    expect(f.lookup.mock.calls.every(([, values]) =>
      values[1] === f.version.workspaceId && values[2] === f.execution.id)).toBe(true)
  })

  it('batches unique ticket IDs and reports every unknown reference path', async () => {
    const f = fixture()
    const failure = await workflowDeliverableFailure({ query: f.lookup }, f.version, f.execution)
    expect(failure).toMatchObject({ outcome: 'failed', error: { code: 'OUTPUT_REFERENCE_UNKNOWN', retryable: false } })
    expect(failure?.error?.message).toContain('/1:')
    expect(failure?.error?.message).toContain('/3:')
    expect(f.lookup).toHaveBeenCalledTimes(2)
    expect(f.lookup.mock.calls[0]![1]).toEqual([[known, foreign], f.version.workspaceId, f.execution.id])
  })

  it('reuses the verdict inside a terminal transaction and reads again in the next transaction', async () => {
    const f = fixture([known, foreign])
    const query = async (text: string, values?: unknown[]) => values ? f.lookup(text, values) : { rows: [] }
    const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
    try {
      await connection.transaction(async sql => {
        const first = await workflowDeliverableFailure(sql, f.version, f.execution)
        const second = await workflowDeliverableFailure(sql, f.version, structuredClone(f.execution))
        expect(second).toEqual(first)
        expect(f.lookup).toHaveBeenCalledTimes(2)
      })
      await connection.transaction(sql => workflowDeliverableFailure(sql, f.version, f.execution))
      expect(f.lookup).toHaveBeenCalledTimes(4)
    } finally {
      await connection.close()
    }
  })

  it('does not reuse a verdict for a changed result in the same transaction', async () => {
    const f = fixture([foreign])
    const query = async (text: string, values?: unknown[]) => values ? f.lookup(text, values) : { rows: [] }
    const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
    try {
      await connection.transaction(async sql => {
        expect(await workflowDeliverableFailure(sql, f.version, f.execution)).toBeDefined()
        const corrected = { ...f.execution, result: { outcome: 'succeeded' as const,
          output: { text: JSON.stringify([known]) } } }
        expect(await workflowDeliverableFailure(sql, f.version, corrected)).toBeUndefined()
        expect(f.lookup).toHaveBeenCalledTimes(3)
      })
    } finally {
      await connection.close()
    }
  })
})
