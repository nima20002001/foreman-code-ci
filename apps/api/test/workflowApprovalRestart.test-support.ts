import { randomUUID } from 'node:crypto'
import { afterEach, expect, vi } from 'vitest'
import { WorkActivationInputSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { INTERRUPT } from '@langchain/langgraph'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { readCurrentExecutions } from './helpers/wave25Agent3.js'

export function restartCleanup() {
  const closes: Array<() => Promise<void>> = []
  afterEach(async () => {
    try {
      while (closes.length) await closes.pop()!()
    } finally {
      vi.restoreAllMocks()
    }
  })
  return closes
}

export async function assertJoinCheckpointRestart({ activeInvocation: active, closes }: {
  activeInvocation: boolean
  closes: Array<() => Promise<void>>
}) {
  const definition = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
  definition.version.definition.handoffs = { contractVersion: 1 }
  const joinNode = definition.version.definition.nodes[3]!
  const f = await checkpointRuntimeFixture(1, 1, { fixture: definition, approvalNodeIds: [joinNode.id],
    outputFor: (nodeId) => ({ text: JSON.stringify({ routing: { kind: 'finish' },
      data: { latestDeliverable: { nodeId }, remainingFindings: [] } }) }),
  })
  closes.push(f.close)
  const runId = f.f.run.id
  let releaseWrite!: () => void
  let notifyInterrupt!: () => void
  const heldWrite = new Promise<void>(resolve => { releaseWrite = resolve })
  const committedInterrupt = new Promise<void>(resolve => { notifyInterrupt = resolve })
  class HeldInterruptSaver extends ApprovalPostgresSaver {
    override async putWrites(...args: Parameters<ApprovalPostgresSaver['putWrites']>): Promise<void> {
      await super.putWrites(...args)
      if (args[1].some(([channel]) => channel === INTERRUPT)) {
        notifyInterrupt()
        await heldWrite
      }
    }
  }
  const initial = active ? f.compose(new HeldInterruptSaver(f.db.pool, undefined, { schema: f.db.schema })) : f
  const starting = initial.engine.start(runId)
  const startOutcome = starting.then(() => undefined, (error: unknown) => error)
  if (active) await committedInterrupt
  else await starting
  expect(await f.runs.get(runId)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
  const [pending] = (await f.pending()).filter((item) => item.status === 'pending')
  expect(pending).toBeDefined()
  const executions = await readCurrentExecutions(f.runs, runId)
  const joined = executions.find((item) => item.id === pending!.executionId)!
  const input = WorkActivationInputSchema.parse(joined.input)
  expect(input.work.kind).toBe('join')
  if (input.work.kind !== 'join') throw new Error('Expected a joined work activation')
  expect(input.work.sources).toHaveLength(2)
  const checkpoint = await f.saver.getTuple(f.config)
  expect(checkpoint).toBeDefined()
  const counts = { ...f.provider.counts }
  if (active) {
    const closing = initial.engine.shutdown()
    try {
      await vi.waitFor(() => expect(f.provider.closedSessions.has(pending!.nativeSessionId)).toBe(true),
        { timeout: 10000, interval: 10 })
    } finally { releaseWrite() }
    await closing
    expect(await startOutcome).toMatchObject({ code: 'ENGINE_RESTART' })
  } else await initial.engine.shutdown()
  let runtime = f.compose()
  expect(runtime.engine).not.toBe(f.engine)
  expect(runtime.native).not.toBe(f.native)
  const restoring = runtime.engine.start(runId)
  await runtime.engine.prepareInteraction(pending!)
  await restoring
  expect(await runtime.repository.get(pending!.id)).toEqual(pending)
  expect(await f.saver.getTuple(f.config)).toEqual(checkpoint)
  expect(await runtime.runs.hasPendingCleanup(runId)).toBe(false)
  expect(await f.receipts()).toHaveLength(0)
  expect(f.provider.counts).toEqual({ ...counts, attaches: counts.attaches + 1 })
  // Another restart must use the successor detachment and keep the same business activation.
  await runtime.engine.shutdown()
  runtime = f.compose()
  expect(await readCurrentExecutions(runtime.runs, runId)).toEqual(executions)
  expect(await f.saver.getTuple(f.config)).toEqual(checkpoint)
  const denied = await new PostgresAccessService(f.db.pool).issue({ name: 'Read-only approval caller', audience: 'user',
    expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['interactions:read'],
      scope: { workspaceIds: [f.f.scope.workspaceId], runIds: [runId] } }] })
  await expect(runtime.service.respond({ kind: 'user', principal: denied.principal }, approvalResponse(pending!)))
    .rejects.toMatchObject({ status: 403 })
  expect(await runtime.repository.get(pending!.id)).toEqual(pending)
  expect(f.provider.counts.responses).toBe(0)
  expect(f.provider.counts.attaches).toBe(counts.attaches + 1)
  const response = await runtime.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending!))
  expect(response.interaction).toMatchObject({ id: pending!.id, nativeSessionId: pending!.nativeSessionId,
    nativeRequestId: pending!.nativeRequestId, status: 'delivered', deliveryState: 'delivered' })
  await vi.waitFor(async () => {
    expect(await runtime.runs.get(runId)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
  }, { timeout: 10_000, interval: 10 })
  expect(await runtime.runs.hasPendingCleanup(runId)).toBe(false)
  expect(f.provider.counts).toEqual({ ...counts, attaches: counts.attaches + 2, responses: counts.responses + 1 })
  expect(f.provider.startedExecutions).toHaveLength(executions.length)
  expect(new Set(f.provider.startedExecutions).size).toBe(executions.length)
  const final = await readCurrentExecutions(runtime.runs, runId)
  expect(final.map((item) => item.id).sort()).toEqual(executions.map((item) => item.id).sort())
  expect(final.find((item) => item.id === joined.id)?.input).toEqual(joined.input)
  expect(await f.receipts()).toHaveLength(1)
  const acknowledgements = (await f.db.pool.query<{ state: string; approval_native_ack_id: string | null }>(
    'select state,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [pending!.id])).rows
  expect(acknowledgements).toEqual([{ state: 'resumed', approval_native_ack_id: expect.any(String) }])
}
