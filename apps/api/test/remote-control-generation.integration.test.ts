import { afterEach, expect, it, vi } from 'vitest'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import * as nativeProcess from '../src/modules/harnesses/process.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

afterEach(() => vi.restoreAllMocks())

async function remoteControlDatabase() {
  const spawnProcess = vi.spyOn(nativeProcess, 'spawnOwnedStdioProcess').mockImplementation(() => {
    throw new Error('Remote snapshot checks must use protocol replay without native processes')
  })
  const database = await migratedDatabase()
  let runtime: Awaited<ReturnType<typeof codexApprovalRuntime>> | undefined
  try {
    runtime = await codexApprovalRuntime('user', { database })
    const approvalRuntime = runtime
    await runtime.engine.start(runtime.f.run.id)
    const [interaction] = await runtime.pending()
    if (!interaction) throw new Error('Expected an original workflow approval request')
    return {
      pool: runtime.db.pool,
      async close() {
        try { await approvalRuntime.close() }
        finally { await database.close() }
      },
      interaction,
      repository: runtime.repository,
      spawnProcess,
    }
  } catch (error) {
    try { await runtime?.close() }
    finally { await database.close() }
    throw error
  }
}

it('persists a pending remote interaction and its run activity without native processes', async () => {
  const f = await remoteControlDatabase()
  try {
    expect(await f.repository.get(f.interaction.id)).toEqual(f.interaction)
    const activity = await f.pool.query(`select kind, payload from run_activity where run_id=$1`,
      [f.interaction.runId])
    expect(activity.rows).toContainEqual({
      kind: 'interaction_pending',
      payload: expect.objectContaining({ interactionId: f.interaction.id, status: 'pending' }),
    })
    expect(f.spawnProcess).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
}, 30_000)

it('reads back a checkpoint-bound approval from its original workflow execution', async () => {
  const f = await remoteControlDatabase()
  try {
    const persisted = await f.repository.get(f.interaction.id)
    expect(persisted).toMatchObject({
      runId: f.interaction.runId,
      workflowId: f.interaction.workflowId,
      executionId: f.interaction.executionId,
      nativeSessionId: f.interaction.nativeSessionId,
      nativeRequestId: f.interaction.nativeRequestId,
      status: 'pending',
      deliveryState: 'not_started',
      approval: { handler: 'user' },
    })
    expect(persisted?.graphThreadId).toBe(f.interaction.runId)
    expect(persisted?.graphInterruptId).toEqual(expect.any(String))
    expect(persisted?.graphInterruptId).not.toBe('')
  } finally {
    await f.close()
  }
}, 30_000)

it('persists generation-zero remote admission and keeps its original snapshot immutable', async () => {
  const f = await remoteControlDatabase()
  try {
    const interaction = f.interaction
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
      commandId: 'original-response', operationId: 'original-operation', attemptId: 'original-attempt',
      executionId: interaction.executionId, bindingHash: 'a'.repeat(64), owner: { grantId: 'original-grant', epoch: '1' },
      native: { sessionId: interaction.nativeSessionId, turnId: 'original-turn', processIdentityDigest: 'b'.repeat(64) },
      action: { kind: 'respond', interactionId: interaction.id, interactionRevision: String(interaction.revision),
        nativeInteractionId: interaction.nativeRequestId, response: interaction.responseOptions[0] } })
    await f.pool.query(`insert into interaction_delivery_attempts(interaction_id,attempt,state,native_session_id,
      native_request_id,correlation_id,remote_owner_control,remote_owner_control_token,
      remote_owner_control_fence,remote_owner_control_generation)
      values($1,1,'submitted',$2,$3,'original-correlation',$4::jsonb,'original-owner',1,0)`,
    [interaction.id, interaction.nativeSessionId, interaction.nativeRequestId, JSON.stringify(command)])
    const stored = (await f.pool.query(`select remote_owner_control,remote_owner_control_generation::text as generation
      from interaction_delivery_attempts where interaction_id=$1`, [interaction.id])).rows
    expect(stored).toEqual([{ remote_owner_control: command, generation: '0' }])
    await expect(f.pool.query(`update interaction_delivery_attempts set remote_owner_control_generation=1
      where interaction_id=$1`, [interaction.id])).rejects.toThrow('immutable')
    const unchanged = (await f.pool.query(`select remote_owner_control,remote_owner_control_generation::text as generation
      from interaction_delivery_attempts where interaction_id=$1`, [interaction.id])).rows
    expect(unchanged).toEqual([{ remote_owner_control: command, generation: '0' }])
    await expect(f.pool.query(`delete from interaction_delivery_attempts where interaction_id=$1`,
      [interaction.id])).rejects.toThrow('retained')
    await expect(f.pool.query(`insert into interaction_delivery_attempts(interaction_id,attempt,state,native_session_id,
      native_request_id,correlation_id,remote_owner_control,remote_owner_control_token,
      remote_owner_control_fence,remote_owner_control_generation)
      values($1,2,'submitted',$2,$3,'other-correlation',$4::jsonb,'original-owner',1,-1)`,
    [interaction.id, interaction.nativeSessionId, interaction.nativeRequestId, JSON.stringify(command)]))
      .rejects.toMatchObject({ code: '23514' })
    expect(f.spawnProcess).not.toHaveBeenCalled()
  } finally { await f.close() }
}, 30_000)
