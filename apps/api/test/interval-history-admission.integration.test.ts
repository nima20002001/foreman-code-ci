import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { readRunIntervalChecks } from '../src/modules/runs/intervalChecks.js'
import { repeatNativeObserver } from '../src/modules/runs/repeatRuntime.js'
import { repeatDigest, repeatExecutionIdentity, tickSlotId } from '../src/modules/runs/repeatResolution.js'
import { repeatNativeStartStore } from '../src/modules/runs/repeatStartComposition.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { readUntil } from './helpers/observableCondition.js'

it('admits and executes check 1001 from persisted history and recovers its queued admission after restart', async () => {
  const f = makeCurrentWorkflowFixture(randomUUID(), 'single')
  const node = f.version.definition.nodes[0]!
  node.interval = { everySeconds: 10 }
  const nativeChecks: string[] = []
  const fixture = await codexApprovalRuntime('user', { fixture: f, approvalPolicy: 'never',
    workflowOutput: async executionId => {
      nativeChecks.push(executionId)
      return 'Check complete'
    } })
  const started = Promise.allSettled([fixture.engine.start(f.run.id)])
  let owner: Awaited<ReturnType<typeof fixture.runs.acquireOwnership>> = undefined
  try {
    await readUntil(async () => (await fixture.db.pool.query(
      'select workflow_node_id from run_repeat_resolutions where run_id=$1', [f.run.id])).rows,
    rows => rows.length === 1, { timeoutMs: 10_000, description: 'ordinary graph completion' })
    await fixture.engine.shutdown()
    await started
    const history = Array.from({ length: 1000 }, (_, index) => {
      const tickIndex = index + 1
      const execution = HarnessExecutionSchema.parse({ id: `historical-check-${tickIndex}`, runId: f.run.id,
        workflowNodeId: node.id, agentId: node.agentId, agentConfigurationVersionId: f.configurations[0]!.id,
        attempt: 1, state: 'completed', createdAt: f.createdAt, finishedAt: f.createdAt,
        input: { executionSemanticsVersion: 3, runInput: f.run.input, occurrence: null, entry: null,
          predecessors: [], tick: { index: tickIndex, everySeconds: 10 } }, result: { outcome: 'succeeded' } })
      return { id: execution.id, slot: tickSlotId(f.run.id, node.id, tickIndex), tick: tickIndex,
        input: canonicalGraphJson(execution.input), digest: repeatDigest(execution.input),
        record: execution, identity: repeatExecutionIdentity(execution) }
    })
    await withTransaction(fixture.db.pool, async sql => {
      await sql.query(`insert into run_repeat_slots(slot_id,run_id,workflow_node_id,input_json,input_digest,tick_index)
        select h.slot,$2,$3,h.input,h.digest,h.tick from jsonb_to_recordset($1::jsonb)
          as h(slot text,input text,digest text,tick integer)`, [JSON.stringify(history), f.run.id, node.id])
      await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,tick_index,record)
        select h.id,$2,$3,$4,1,h.tick,h.record from jsonb_to_recordset($1::jsonb)
          as h(id text,tick integer,record jsonb)`, [JSON.stringify(history), f.run.id, node.id, node.agentId])
      await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,technical_attempt,identity)
        select h.id,$2,h.slot,1,h.identity from jsonb_to_recordset($1::jsonb)
          as h(id text,slot text,identity jsonb)`, [JSON.stringify(history), f.run.id])
    })
    const runtime = fixture.compose()
    owner = await runtime.runs.acquireOwnership(f.run.id, () => { throw new Error('Run ownership lost') })
    if (!owner) throw new Error('Expected an unowned Run')
    const store = await runtime.runs.repeat(owner)
    const candidate = () => HarnessExecutionSchema.parse({ id: 'check-after-history', runId: f.run.id,
      workflowNodeId: node.id, agentId: node.agentId, agentConfigurationVersionId: f.configurations[0]!.id,
      attempt: 1, state: 'queued', input: {}, createdAt: new Date().toISOString() })
    const admission = await readUntil(() => store.admitTick(node.id, candidate, 'historical-check-1000'),
      result => result.kind === 'admitted', { timeoutMs: 15_000, description: 'check 1001 admission' })
    expect(admission.kind).toBe('admitted')
    if (admission.kind !== 'admitted') throw new Error('Expected a new check')
    expect(admission.execution.input).toMatchObject({ tick: { index: 1001, everySeconds: 10 } })
    await owner.release()
    owner = await runtime.runs.acquireOwnership(f.run.id, () => { throw new Error('Recovered ownership lost') })
    if (!owner) throw new Error('Expected ownership after restart')
    const recovered = await runtime.runs.repeat(owner)
    const busy = await recovered.admitTick(node.id, () => { throw new Error('Queued check must be reused') },
      'historical-check-1000')
    expect(busy).toMatchObject({ kind: 'busy', execution: admission.execution })
    const snapshot = await runtime.runs.getRepeatSnapshot(f.run.id, owner)
    const { run, version } = snapshot
    const bridge = repeatNativeStartStore({ owner, runtimeRoot: fixture.db.directory,
      nativeBoundaryEvidence: id => runtime.native.nativeBoundaryEvidence(id, owner!),
    }, snapshot, recovered)
    await repeatNativeObserver({ run, version, owner, store: bridge.store, native: runtime.native,
      admission: new RunnerAdmission(), workflows: runtime.workflows, locations: runtime.locations,
      directory: bridge.directory,
    })(admission.execution, new AbortController().signal)
    expect(nativeChecks.filter(id => id === admission.execution.id)).toHaveLength(1)
    expect(await runtime.runs.getExecution(admission.execution.id)).toMatchObject({
      state: 'completed', input: { tick: { index: 1001 } }, result: { outcome: 'succeeded' } })
    expect(await readRunIntervalChecks(fixture.db.pool, f.run.id, 'running', version)).toEqual([
      { nodeId: node.id, everySeconds: 10, checks: 1001, running: false, nextCheckAt: expect.any(String) },
    ])
  } finally {
    await owner?.release()
    await fixture.close()
    await started
  }
}, 60_000)
