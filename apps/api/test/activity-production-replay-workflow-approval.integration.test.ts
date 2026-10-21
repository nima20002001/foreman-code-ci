import { GetInteractionResponseSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, admittedRun, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: workflow-approval', { timeout: 120000 }, () => {
  it('publishes approval from the same isolated database as the accepted Run', async () => {
    const f = await setup()
    const started = await admittedRun(f, 'approval')
    const { workspaceId, id: runId } = started.run
    const detail = await eventually(async () => {
      const response = await f.http('GET', `/api/management/workspaces/${workspaceId}/runs/${runId}`)
      expect(response.statusCode, response.body).toBe(200)
      return SavedRunDetailsSchema.parse(response.json())
    }, value => value.run.executionState === 'waiting')
    expect(detail.run.workflowVersionId).toBe(started.run.workflowVersionId)
    expect(detail.activitySnapshot!.pendingInteractions).toHaveLength(1)
    const interactionId = detail.activitySnapshot!.pendingInteractions[0]!.id
    const response = await f.http('GET', `/api/user/interactions/${interactionId}`, undefined, '')
    expect(response.statusCode, response.body).toBe(200)
    const { interaction } = GetInteractionResponseSchema.parse(response.json())
    expect(f.replay.starts).toHaveLength(1)
    expect(interaction).toMatchObject({
      runId,
      graphThreadId: runId,
      graphInterruptId: expect.any(String),
      nativeSessionId: f.replay.starts[0]!.sessionId,
      status: 'pending',
      deliveryState: 'not_started',
    })
    const readback = await f.call('run_get', { workspaceId, runId, detail: 'full' })
    expect(readback.isError).not.toBe(true)
    const persisted = SavedRunDetailsSchema.parse(decodeMcpToolResult(readback))
    expect(persisted.run).toEqual(detail.run)
    expect(persisted.activitySnapshot!.pendingInteractions).toEqual(detail.activitySnapshot!.pendingInteractions)
    const denied = await f.call('run_get', { workspaceId, runId }, f.denied.token)
    expect(denied.isError).toBe(true)
    expect(f.replay.responses).toHaveLength(0)
  })

  it('publishes a checkpoint-bound approval wait through HTTP and authenticated MCP', async () => {
    const f = await setup()
    const started = await admittedRun(f, 'approval')
    const workspaceId = started.run.workspaceId
    const runId = started.run.id
    const detail = await eventually(async () => {
      const response = await f.http('GET', `/api/management/workspaces/${workspaceId}/runs/${runId}`)
      expect(response.statusCode, response.body).toBe(200)
      return SavedRunDetailsSchema.parse(response.json())
    }, value => value.run.executionState === 'waiting')
    expect(detail.activitySnapshot!.pendingInteractions).toHaveLength(1)
    const interactionId = detail.activitySnapshot!.pendingInteractions[0]!.id
    const interaction = await f.http('GET', `/api/user/interactions/${interactionId}`, undefined, '')
    expect(interaction.statusCode, interaction.body).toBe(200)
    expect(GetInteractionResponseSchema.parse(interaction.json()).interaction.graphInterruptId).toBeTruthy()

    const readback = await f.call('run_get', { workspaceId, runId, detail: 'full' })
    expect(readback.isError).not.toBe(true)
    const persisted = SavedRunDetailsSchema.parse(decodeMcpToolResult(readback))
    expect(persisted.run).toEqual(detail.run)
    expect(persisted.activitySnapshot!.pendingInteractions).toEqual(detail.activitySnapshot!.pendingInteractions)
    const denied = await f.call('run_get', { workspaceId, runId }, f.denied.token)
    expect(denied.isError).toBe(true)
    expect(f.replay.responses).toHaveLength(0)
  })

  it('Workflow approval: live callback is qualified; recorded choice and provider/worker acknowledgment remain distinct', async () => {
    const f = await setup(), started = await admittedRun(f, 'approval'), workspaceId = started.run.workspaceId
    const detail = await eventually(async () => SavedRunDetailsSchema.parse((await f.http('GET',
      `/api/management/workspaces/${workspaceId}/runs/${started.run.id}`)).json()),
    (value) => value.activitySnapshot!.pendingInteractions.length > 0)
    const interaction = detail.activitySnapshot!.pendingInteractions[0]!
    // Request publication precedes the checkpoint binding, which advances its public revision.
    const read = async () => {
      const response = await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')
      expect(response.statusCode, response.body).toBe(200)
      return GetInteractionResponseSchema.parse(response.json())
    }
    const view = await eventually(read, (value) => !!value.interaction.graphInterruptId)
    const current = view.interaction
    expect(current.revision).toBeGreaterThan(0)
    expect(view).toMatchObject({ canRespond: true, activity: { phase: 'needs_answer', answerRecorded: false,
      nativeDelivery: 'not_started', workerAcknowledgment: 'unknown', response: { available: true, path: 'live_callback' } } })
    const choice = current.responseOptions.find((option) => option.semantic === 'approve_once')!
    const stale = await f.http('POST', `/api/user/interactions/${interaction.id}/respond`, {
      interactionId: interaction.id, expectedRevision: current.revision - 1, optionId: choice.optionId,
    }, '')
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('REVISION_CONFLICT')
    expect(f.replay.responses).toHaveLength(0)
    const unchanged = GetInteractionResponseSchema.parse((await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, '')).json())
    expect(unchanged.interaction).toMatchObject({ revision: current.revision, status: 'pending',
      graphInterruptId: current.graphInterruptId, nativeSessionId: current.nativeSessionId, nativeRequestId: current.nativeRequestId })
    const authoritative = (await f.db.pool.query<{ revision: string; graph_interrupt_id: string }>(`
      select revision::text,record->>'graphInterruptId' as graph_interrupt_id from durable_interactions where id=$1`, [interaction.id])).rows[0]!
    expect(authoritative).toEqual({ revision: String(current.revision), graph_interrupt_id: current.graphInterruptId })
    const nativeSessionId = current.nativeSessionId
    const nativeTurnId = f.replay.starts.find((entry) => entry.sessionId === nativeSessionId)!.nativeTurnId
    f.replay.nextResponse = 'unacknowledged'
    const [answer] = await Promise.all([
      f.http('POST', `/api/user/interactions/${interaction.id}/respond`, {
        interactionId: interaction.id, expectedRevision: current.revision, optionId: choice.optionId,
      }, ''),
      (async () => {
        const recorded = await eventually(read, (value) => value.activity?.answerRecorded === true
          && f.replay.responses.length === 1)
        expect(recorded.interaction.deliveryState).not.toBe('delivered')
        expect(recorded.activity).toMatchObject({ answerRecorded: true, workerAcknowledgment: 'unknown',
          response: { available: false } })
        expect(f.replay.responses).toHaveLength(1)
        const nativeResponse = f.replay.responses[0]!
        expect(nativeResponse.sessionId).toBe(nativeSessionId)
        f.replay.channels.get(nativeSessionId)!.notify('serverRequest/resolved', {
          threadId: nativeSessionId, requestId: nativeResponse.rpcId,
        })
        const delivered = await eventually(read, (value) => value.interaction.deliveryState === 'delivered')
        expect(delivered.activity).toMatchObject({ answerRecorded: true, nativeDelivery: 'delivered',
          workerAcknowledgment: 'unknown', response: { available: false } })
        f.replay.commandCompleted(nativeSessionId, nativeTurnId)
        f.replay.complete(nativeSessionId, nativeTurnId, JSON.stringify({ data: 'recorded post-approval final',
          summary: 'Completed after approval.', board: { kind: 'none', reason: 'no_access' } }))
      })(),
    ])
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json().interaction.deliveryState).toBe('delivered')
    expect(f.replay.responses).toHaveLength(1)
    await f.reconcile()
    await eventually(read, (value) => value.activity?.workerAcknowledgment === 'confirmed')
    const persisted = (await f.db.pool.query('select record from durable_interactions where id=$1', [interaction.id])).rows[0]!.record
    expect(persisted.id).toBe(current.id)
    expect(persisted.nativeSessionId).toBe(nativeSessionId)
    expect(persisted.nativeRequestId).toBe(current.nativeRequestId)
    expect(f.replay.responses).toHaveLength(1)
  })
})
