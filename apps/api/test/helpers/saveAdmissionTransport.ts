import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { readCurrentExecutions } from './wave25Agent3.js'
import { assertSettled, versionCount, type SaveFixture } from './eng07SaveAdmission.testSupport.js'

export async function nativeFacts(f: SaveFixture) {
  const runId = f.f.run.id
  const entries = (await f.db.pool.query('select to_jsonb(n) as record from workflow_native_entries n where run_id=$1 order by execution_id', [runId])).rows
  const closures = (await f.db.pool.query(`select to_jsonb(n) as record from execution_native_closures n
    join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.generation`, [runId])).rows
  const recoveries = (await f.db.pool.query(`select to_jsonb(n) as record from execution_native_recoveries n
    join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.generation`, [runId])).rows
  const sessions = (await f.db.pool.query(`select to_jsonb(n) as record from execution_native_sessions n
    join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.execution_id`, [runId])).rows
  return { entries, closures, recoveries, sessions }
}
export async function assertNewVersionOnly(f: SaveFixture, count: number, originalVersion: string) {
  expect(await versionCount(f)).toBe(count + 1)
  const workflow = (await f.db.pool.query('select current_version_id from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!
  expect(workflow.current_version_id).not.toBe(originalVersion)
  const run = await f.runs.get(f.f.run.id)
  expect(run?.workflowVersionId).toBe(originalVersion)
}

/** Real owner/checkpoint/coordinator/SQL settlement and authenticated transports;
 * only the external provider port and timing are deterministic. No native binary
 * or kernel process registry is claimed by this fixture. */
export async function recoveredFixture(form: 'single' | 'repeat') {
  const shape = makeCurrentWorkflowFixture(randomUUID(), form)
  const disposed = new Set<string>()
  const f = await currentOperatorIntegration({ fixture: shape, approvalNodeIds: [shape.version.entryNodeId],
    recoverNativeProcesses: async (executionId, signal) => { signal.throwIfAborted(); return disposed.has(executionId) } })
  try {
    await f.engine.start(f.f.run.id)
    expect((await f.pending()).filter((interaction) => interaction.status === 'pending')).toHaveLength(1)
    const executions = await readCurrentExecutions(f.runs, f.f.run.id)
    expect(executions).toHaveLength(1)
    const execution = executions[0]!
    expect(execution.nativeSessionId).toBeDefined()
    const session = NativeSessionReferenceSchema.parse((await f.db.pool.query<{ reference: unknown }>(
      'select reference from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]?.reference)
    const counts = { ...f.provider.counts }
    await f.engine.shutdown()
    // A positive close acknowledgement from this exact deterministic provider
    // lifetime, NOT absence in a new resolver/registry. No create/attach/replay.
    await f.provider.close(session)
    disposed.add(execution.id)
    // Restart preserves pending approvals; settlement needs an explicit Stop.
    await f.stop()
    const cold = f.compose()
    await cold.engine.start(f.f.run.id)
    await assertSettled(f)
    const proof = (await f.db.pool.query(`select p.generation,c.closed_at from execution_native_recoveries p
      join execution_native_closures c on c.generation=p.generation and c.execution_id=p.execution_id
      where p.execution_id=$1`, [execution.id])).rows
    expect(proof).toHaveLength(1)
    expect(proof[0]!.closed_at).toBeNull() // Exercise the recovered reader, not the old closed_at predicate.
    expect(f.provider.counts).toEqual(counts)
    return { f, executionId: execution.id }
  } catch (error) { await f.close(); throw error }
}
