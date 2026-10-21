import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import {
  WorkActivationInputSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture, parseWorkHandoffResult,
} from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { workResultRepairPrompt } from '../interactions/workResultRepair.js'
import { currentInitialPrompt } from './currentRouting.js'
import { normalizeRepeatTerminal } from './repeatNode.js'
import { parseWorkResultForInput } from './workHandoffResult.js'
import { assertWorkHandoffDeliveryLocked } from './workHandoffDelivery.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'

function fixture() {
  const saved = makeCurrentWorkflowFixture('received-work-return')
  const version = WorkflowVersionV3Schema.parse({ ...saved.version,
    definition: { ...saved.version.definition, handoffs: { contractVersion: 1 } } })
  const [requester, receiver] = saved.version.definition.nodes
  const requestId = `work-request-${'abcd1234'.repeat(8)}`
  const activationId = 'received-work-activation'
  const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: {},
    occurrence: null, entry: null, predecessors: [], work: {
      kind: 'work_request', activation: { scope: saved.scope, activationId,
        workflowNodeId: receiver!.id, lineageId: saved.run.id, cause: { kind: 'work_request', requestId } },
      request: { scope: saved.scope, requestId, relationshipId: saved.version.definition.edges[0]!.id,
        requesterActivationId: 'requester-activation', requesterExecutionId: 'requester-execution',
        destinationActivationId: activationId, requesterNodeId: requester!.id, destinationNodeId: receiver!.id,
        payloadDigest: `sha256:${'1'.repeat(64)}`, acceptedAt: saved.createdAt, ordinal: 1 },
      acceptedSourceResult: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
        data: { latestDeliverable: 'Check the deliverable.', remainingFindings: [] } } },
    } })
  const { executionId, ...identity } = saved.identities[1]!
  const execution = HarnessExecutionSchema.parse({ ...identity, id: executionId, runId: saved.run.id,
    input, state: 'completed', createdAt: saved.createdAt, finishedAt: saved.createdAt,
    result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: 'Done', remainingFindings: [] } } } })
  const answer = (id: string | undefined, outcome: 'accepted' | 'needs_changes'): ExecutionResult => ({
    outcome: 'succeeded', output: { text: JSON.stringify({ routing: { kind: 'return', requestId: id, outcome },
      data: { latestDeliverable: { summary: 'Checked' }, remainingFindings: [] } }) },
  })
  return { ...saved, version, execution, input, requestId, answer,
    ref: { nodeId: receiver!.id, occurrence: null }, contract: currentInitialPrompt({}, false, true)! }
}

function joinedInput(f: ReturnType<typeof fixture>, count: number) {
  if (f.input.work.kind !== 'work_request') throw new Error('Expected received work')
  const { activation, request, acceptedSourceResult } = f.input.work
  return WorkActivationInputSchema.parse({ ...f.input, work: {
    kind: 'join', activation: { ...activation, cause: { kind: 'join', joinId: activation.activationId } },
    sources: Array.from({ length: count }, (_, index) => ({
      request: { ...request, requestId: `${request.requestId}-${index}`, relationshipId: `edge-${index}` },
      acceptedSourceResult,
    })),
  } })
}

function reactivatedInput(f: ReturnType<typeof fixture>) {
  if (f.input.work.kind !== 'work_request') throw new Error('Expected received work')
  const { activation, request, acceptedSourceResult } = f.input.work
  return WorkActivationInputSchema.parse({ ...f.input, parentRequest: request, work: {
    kind: 'work_return', activation: { ...activation, cause: { kind: 'work_return', returnId: 'review-return' } },
    returned: { scope: f.scope, returnId: 'review-return', requestId: 'downstream-request',
      sourceActivationId: 'review-activation', sourceExecutionId: 'review-execution',
      requesterActivationId: 'requester-activation', continuationActivationId: activation.activationId,
      acceptedResultDigest: `sha256:${'2'.repeat(64)}`, outcome: 'needs_changes',
      latestDeliverable: 'Revise', remainingFindings: ['Revise'], returnedAt: f.createdAt },
    acceptedSourceResult,
  } })
}

describe('received work return identity', () => {
  it.each(['accepted', 'needs_changes'] as const)('resolves an omitted %s ID without changing the native result', outcome => {
    const f = fixture()
    const result = f.answer(undefined, outcome)
    const before = structuredClone(result)
    expect(parseWorkResultForInput(result, f.input).routing)
      .toEqual({ kind: 'return', requestId: f.requestId, outcome })
    expect(workResultRepairPrompt(result, f.contract, f.input)).toBeUndefined()
    const execution = { ...f.execution, result }
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution)).toEqual(execution)
    expect(result).toEqual(before)
  })

  it('resolves the single parent request after a downstream review reactivates the Agent', () => {
    const f = fixture()
    const input = reactivatedInput(f)
    expect(parseWorkResultForInput(f.answer(undefined, 'accepted'), input).routing)
      .toEqual({ kind: 'return', requestId: f.requestId, outcome: 'accepted' })
    expect(workResultRepairPrompt(f.answer('mistyped-request', 'accepted'), f.contract, input))
      .toContain(`Valid open request IDs: ${JSON.stringify([f.requestId])}`)
  })

  it.each([undefined, 'saved-caller'])('uses trusted context for a frozen continuation without parentRequest (ID: %s)', id => {
    const f = fixture()
    const input = reactivatedInput(f)
    delete input.parentRequest
    const executionContext = { parentRequest: { requestId: f.requestId,
      requesterNodeId: f.version.entryNodeId } }
    const result = f.answer(id === undefined ? undefined : f.requestId, 'accepted')
    const execution = { ...f.execution, input: input as typeof f.execution.input, result }
    expect(parseWorkResultForInput(result, input, executionContext).routing)
      .toEqual({ kind: 'return', requestId: f.requestId, outcome: 'accepted' })
    expect(workResultRepairPrompt(result, f.contract, input, executionContext)).toBeUndefined()
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution, { executionContext })).toEqual(execution)
    expect(input).not.toHaveProperty('parentRequest')
  })

  it('resolves an omitted ID for a join with one received request', () => {
    const f = fixture()
    const input = joinedInput(f, 1)
    expect(parseWorkResultForInput(f.answer(undefined, 'accepted'), input).routing)
      .toEqual({ kind: 'return', requestId: `${f.requestId}-0`, outcome: 'accepted' })
  })

  it('validates delivery with the resolved ID while retaining the original result', async () => {
    const f = fixture()
    if (f.input.work.kind !== 'work_request') throw new Error('Expected received work')
    const request = f.input.work.request
    const result = f.answer(undefined, 'accepted')
    const execution = { ...f.execution, result }
    const sql = { query: async (_text: string, values: unknown[]) => {
      if (values.length === 3) {
        return { rows: values[1] === f.requestId ? [{ record: request, parent_id: f.requestId }] : [], rowCount: 1 }
      }
      return { rows: [{ bytes: 1000 }], rowCount: 1 }
    } } as unknown as GraphTransactionSql
    await expect(assertWorkHandoffDeliveryLocked({ sql, scope: f.scope, version: f.version, now: f.createdAt },
      execution, request.destinationActivationId, parseWorkHandoffResult(result))).resolves.toBeUndefined()
    expect(execution.result).toEqual(result)
  })

  it.each([undefined, 'mistyped-request'])('rejects an ambiguous or wrong ID %s and lists every valid ID', id => {
    const f = fixture()
    const input = joinedInput(f, 2)
    const ids = [`${f.requestId}-0`, `${f.requestId}-1`]
    const result = f.answer(id, 'accepted')
    const before = structuredClone(input)
    expect(() => parseWorkResultForInput(result, input)).toThrow()
    expect(workResultRepairPrompt(result, f.contract, input))
      .toContain(`Valid open request IDs: ${JSON.stringify(ids)}`)
    const execution = HarnessExecutionSchema.parse({ ...f.execution, input, result })
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution).result)
      .toMatchObject({ outcome: 'failed', error: { code: 'WORK_RESULT_INVALID' } })
    expect(input).toEqual(before)
  })

  it('accepts an explicit matching ID when several received requests are open', () => {
    const f = fixture()
    const result = f.answer(`${f.requestId}-1`, 'accepted')
    expect(parseWorkResultForInput(result, joinedInput(f, 2)).routing)
      .toEqual({ kind: 'return', requestId: `${f.requestId}-1`, outcome: 'accepted' })
  })

  it.each([undefined, 'unrelated-request'])('rejects a return with ID %s when no request was received', id => {
    const f = fixture()
    const input = WorkActivationInputSchema.parse({ ...f.input, work: {
      kind: 'entry', activation: { ...f.input.work.activation, cause: { kind: 'entry' } },
    } })
    expect(workResultRepairPrompt(f.answer(id, 'accepted'), f.contract, input))
      .toContain('Valid open request IDs: []')
  })

  it.each(['accepted', 'needs_changes'] as const)('repairs a mistyped %s request ID before terminal publication', outcome => {
    const f = fixture()
    const wrong = f.answer(f.requestId.slice(0, -6), outcome)
    const before = structuredClone(wrong)
    const prompt = workResultRepairPrompt(wrong, f.contract, f.input)
    expect(prompt).toContain('Validation issues:')
    expect(prompt).toContain(f.requestId)
    expect(prompt).toContain(`Valid open request IDs: ${JSON.stringify([f.requestId])}`)
    expect(() => parseWorkResultForInput(wrong, f.input)).toThrow()
    expect(prompt).toContain(f.contract)
    expect(wrong).toEqual(before)
  })

  it.each(['accepted', 'needs_changes'] as const)('fails an uncorrected %s return instead of storing success', outcome => {
    const f = fixture()
    const result = f.answer(f.requestId.slice(0, -6), outcome)
    const normalized = normalizeRepeatTerminal(f.version, f.scope, f.ref, { ...f.execution, result })
    expect(normalized.result).toMatchObject({ outcome: 'failed',
      error: { code: 'WORK_RESULT_INVALID', retryable: false } })
    expect(result.outcome).toBe('succeeded')
  })

  it.each(['accepted', 'needs_changes'] as const)('preserves a valid %s return and its original text', outcome => {
    const f = fixture()
    const result = f.answer(f.requestId, outcome)
    const execution = { ...f.execution, result }
    expect(workResultRepairPrompt(result, f.contract, f.input)).toBeUndefined()
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution)).toEqual(execution)
  })

  it('allows the receiver to finish along its saved downstream routes', () => {
    const f = fixture()
    const result: ExecutionResult = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: 'Done', remainingFindings: [] } } }
    expect(workResultRepairPrompt(result, f.contract, f.input)).toBeUndefined()
    const execution = { ...f.execution, result }
    expect(normalizeRepeatTerminal(f.version, f.scope, f.ref, execution)).toEqual(execution)
  })
})
