import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  RUN_INSPECTION_TOOLS, RunExecutionsListInputSchema, RunExecutionDetailSchema, RunExecutionsPageSchema, RunExecutionBindingsPageSchema, RunVersionDetailSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  requestScope, reader, allExecutions, parity, denied, terminal, resaveChangingRepeat,
} from './helpers/runInspection.js'

describe.skipIf(!postgresEnabled)('PostgreSQL authenticated Run inspection: repeat', () => {
  it('retains two real occurrences, attempt identities, exact text-carrier result and carry ancestry after removing repeat', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'repeat'), exitId = fixture.version.definition.nodes[1]!.id
    let exits = 0
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], outputFor: (nodeId) => nodeId !== exitId ? { nodeId }
      : { text: JSON.stringify({ routing: { outcome: ++exits === 1 ? 'issues' : 'pass' },
        data: { latestDeliverable: { occurrence: exits }, remainingFindings: exits === 1 ? [{ id: 'finding-1' }] : [] } }) } })
    try {
      await f.engine.start(f.f.run.id); await terminal(f)
      const r = await reader(f), args = requestScope(f), items = await allExecutions(f, r)
      expect(exits).toBe(2); expect(items).toHaveLength(4)
      expect(new Set(items.map((item) => item.executionId)).size).toBe(4)
      expect(new Set(items.map((item) => item.occurrence?.occurrenceIndex))).toEqual(new Set([1, 2]))
      expect(items.every((item) => item.attempt === 1)).toBe(true)
      const entry = f.f.version.entryNodeId, secondEntry = items.find((item) => item.workflowNodeId === entry && item.occurrence?.occurrenceIndex === 2)!
      const local = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions,
        { ...args, workflowNodeId: entry, occurrenceId: secondEntry.occurrence!.occurrenceId }))
      expect(local.items.map((item) => item.executionId)).toEqual([secondEntry.executionId])
      const across = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, workflowNodeId: entry }))
      expect(across.items).toHaveLength(2)
      const beforeReads = (await f.db.pool.query(
        'select record from harness_executions where run_id=$1 order by id', [args.runId])).rows
      for (const limit of [1, 25, 100]) {
        for (const workflowNodeId of [undefined, entry]) {
          for (const occurrenceId of [undefined, secondEntry.occurrence!.occurrenceId]) {
            const filter = { ...args, limit, ...(workflowNodeId ? { workflowNodeId } : {}),
              ...(occurrenceId ? { occurrenceId } : {}) }
            const expected = items.filter(item => (!workflowNodeId || item.workflowNodeId === workflowNodeId)
              && (!occurrenceId || item.occurrence?.occurrenceId === occurrenceId))
            const received: typeof items = []
            let cursor: string | undefined
            do {
              const page = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token,
                RUN_INSPECTION_TOOLS.executions, { ...filter, ...(cursor ? { cursor } : {}) }))
              expect(page.items.length).toBeLessThanOrEqual(limit)
              expect(page.items.length).toBeGreaterThan(0)
              if (page.pageInfo.nextCursor) expect(page.items).toHaveLength(limit)
              received.push(...page.items)
              expect(received.length).toBeLessThanOrEqual(expected.length)
              cursor = page.pageInfo.nextCursor ?? undefined
            } while (cursor)
            expect(received).toEqual(expected)
          }
        }
      }
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions,
        { ...args, workflowNodeId: 'missing-node' }, 404, 'WORKFLOW_NODE_NOT_FOUND')
      expect(RunExecutionsListInputSchema.safeParse({
        ...args, workflowNodeId: "node' OR true --",
      }).success).toBe(false)
      expect((await f.db.pool.query(
        'select record from harness_executions where run_id=$1 order by id', [args.runId])).rows).toEqual(beforeReads)
      const detailArgs = { ...args, executionId: secondEntry.executionId }
      const detail = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, detailArgs))
      const bindings = RunExecutionBindingsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, { ...detailArgs, limit: 1 }))
      expect(bindings.items).toHaveLength(1); expect(bindings.pageInfo.nextCursor).toBeNull()
      const carry = bindings.items[0]!
      expect(carry.kind).toBe('carry')
      if (carry.kind !== 'carry') throw new Error('Expected the exact second-occurrence carry')
      expect(carry.recipientOccurrence?.occurrenceIndex).toBe(2)
      expect(carry.source.execution.occurrence.occurrenceIndex).toBe(1)
      expect(carry.source.execution.occurrence.blockId).toBe(carry.recipientOccurrence?.blockId)
      expect(carry.source).toEqual(detail.acceptedInput.value.entry?.carry)
      const source = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution,
        { ...args, executionId: carry.source.execution.executionId }))
      expect(source.acceptedResult.status).toBe('accepted')
      if (source.acceptedResult.status !== 'accepted') throw new Error('Missing accepted source')
      expect(source.acceptedResult.value).toEqual(carry.source.acceptedResult)
      expect(source.acceptedResult.digest).toBe(carry.source.acceptedResultDigest)
      expect(source.acceptedResult.value.output).toEqual({ text: expect.any(String) })
      const persisted = (await f.db.pool.query<{ result_json: string; result_digest: string }>(
        'select result_json,result_digest from run_repeat_results where run_id=$1 and execution_id=$2', [args.runId, carry.source.execution.executionId])).rows[0]!
      expect(source.acceptedResult.value).toEqual(JSON.parse(persisted.result_json))
      expect(source.acceptedResult.digest).toBe(persisted.result_digest)
      expect((await f.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [args.runId])).rows).toHaveLength(2)
      const counts = { ...f.provider.counts }
      await resaveChangingRepeat(f)
      expect(f.provider.counts).toEqual(counts)
      const old = RunVersionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.version, args))
      expect(old.version.definition.repeat?.blocks).toHaveLength(1)
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, detailArgs)).toEqual(detail)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
