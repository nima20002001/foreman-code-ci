import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { describe, expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatDigest } from './repeatResolution.js'
import { admitWorkHandoffLocked } from './workHandoffAdmission.js'

function queryResult(rows: Record<string, unknown>[]) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
}

function fixture() {
  const saved = makeCurrentWorkflowFixture('work-handoff-admission')
  const { executionId, ...identity } = saved.identities[0]!
  const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId, runId: saved.run.id,
    input: {}, state: 'completed', createdAt: saved.createdAt, finishedAt: saved.createdAt,
    result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: 'Ready', remainingFindings: [] } } } })
  const source = { record: execution, accepted: true, work_activation_id: 'source-activation' }
  const receipt = { result_json: canonicalGraphJson(execution.result), result_digest: repeatDigest(execution.result) }
  const query = vi.fn<GraphTransactionSql['query']>()
  const context: Parameters<typeof admitWorkHandoffLocked>[0] = {
    sql: { transaction: true, query: query as GraphTransactionSql['query'] }, scope: saved.scope,
    version: { ...saved.version, definition: { ...saved.version.definition, handoffs: { contractVersion: 1 } } },
    now: saved.createdAt, assertActive: vi.fn(),
    hooks: {
      run: saved.run, assertAuthorityLocked: vi.fn(), assertAdmissionLocked: vi.fn(),
      assertSettlementLocked: vi.fn(), allowTechnicalRetryLocked: vi.fn(), publishLocked: vi.fn(),
      assertPublicationReceiptLocked: vi.fn(), completeRunLocked: vi.fn(),
    },
  }
  return { context, query, execution, source, receipt }
}

describe('work handoff source validation', () => {
  it.each([
    { accepted: false, work_activation_id: 'source-activation' },
    { accepted: true, work_activation_id: null },
  ])('rejects a source without acceptance and an activation: %j', async (overrides) => {
    const f = fixture()
    f.query.mockResolvedValueOnce(queryResult([{ ...f.source, ...overrides }]))
    await expect(admitWorkHandoffLocked(f.context, f.execution.id))
      .rejects.toMatchObject({ code: 'WORK_SOURCE_NOT_ACCEPTED' })
  })

  it('rejects an execution belonging to a different run', async () => {
    const f = fixture()
    f.query.mockResolvedValueOnce(queryResult([{ ...f.source, record: { ...f.execution, runId: 'other-run' } }]))
    await expect(admitWorkHandoffLocked(f.context, f.execution.id))
      .rejects.toMatchObject({ code: 'WORK_SOURCE_PIN_CONFLICT' })
  })

  it.each(['missing', 'digest', 'result'])('rejects a %s accepted result receipt', async (kind) => {
    const f = fixture()
    const receipt = { ...f.receipt }
    if (kind === 'digest') receipt.result_digest = `sha256:${'0'.repeat(64)}`
    if (kind === 'result') receipt.result_json = '{}'
    f.query.mockResolvedValueOnce(queryResult([f.source]))
      .mockResolvedValueOnce(queryResult(kind === 'missing' ? [] : [receipt]))
    await expect(admitWorkHandoffLocked(f.context, f.execution.id))
      .rejects.toMatchObject({ code: 'WORK_RESULT_RECEIPT_MISSING' })
  })

  it('continues to source activation validation when the execution and receipt match', async () => {
    const f = fixture()
    f.query.mockResolvedValueOnce(queryResult([f.source]))
      .mockResolvedValueOnce(queryResult([f.receipt]))
      .mockResolvedValueOnce(queryResult([]))
    await expect(admitWorkHandoffLocked(f.context, f.execution.id))
      .rejects.toMatchObject({ code: 'WORK_SOURCE_ACTIVATION_CONFLICT' })
    expect(f.context.hooks.publishLocked).not.toHaveBeenCalled()
  })
})
