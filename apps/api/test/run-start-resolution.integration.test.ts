import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentMutationResultSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowSaveResultSchema, RunStartV3InputSchema, RunStartV3ResultSchema,
  makeCurrentWorkflowFixture, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import * as startLocks from '../src/modules/runs/startLocks.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

type Runtime = Awaited<ReturnType<typeof currentOperatorIntegration>>

describe.runIf(postgresEnabled)('authenticated Start command resolution', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  beforeAll(async () => { database = await migratedDatabase() }, 60_000)
  afterAll(async () => { await database?.close() }, 60_000)

  async function setup() {
    const runtime = await currentOperatorIntegration({ database, insertRun: false, agentManagement: true,
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    await call(runtime, 'workspace_location_set', { workspaceId: runtime.f.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1, runnerId: LOCAL_RUNNER_ID, rootPath: database.directory })
    const save = await runtime.create()
    const saved = CurrentWorkflowSaveResultSchema.parse(await call(runtime, 'workflow_save_v3', save)).value
    const input = RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId, workflowId: saved.workflowId,
      workflowVersionId: saved.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 2, input: {} })
    return { runtime, save, saved, input }
  }

  async function call(runtime: Runtime, name: string, args: Record<string, unknown>) {
    const reply = await runtime.client.callTool({ name, arguments: args })
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true)
    return decodeMcpToolResult(reply)
  }

  function http(runtime: Runtime, input: RunStartV3Input, suffix = '', token = runtime.writer.token) {
    return runtime.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs${suffix}`,
      headers: { authorization: `Bearer ${token}` }, payload: input })
  }

  it.each(['workflow', 'agent', 'location'] as const)(
    'closes a stale %s command before a delayed Start can admit it', async kind => {
      const { runtime, save, saved, input } = await setup()
      const entered = deferred<void>()
      const release = deferred<void>()
      const snapshot = runtime.locations.snapshot.bind(runtime.locations)
      const pause = vi.spyOn(runtime.locations, 'snapshot').mockImplementation(async (...args) => {
        const result = await snapshot(...args)
        entered.resolve()
        await release.promise
        return result
      })
      const pending = http(runtime, input)
      let latest = saved
      let pins = saved.version.agentConfigurationVersionIds
      let locationRevision = 2
      try {
        await entered.promise
        if (kind === 'workflow') {
          latest = CurrentWorkflowSaveResultSchema.parse(await call(runtime, 'workflow_save_v3', { ...save, commandId: randomUUID(), expectedRevision: saved.revision,
            expectedWorkflowVersionId: saved.version.id, graph: { ...saved.version.definition,
              nodes: saved.version.definition.nodes.map(node => ({ ...node, initialPrompt: 'Changed instruction' })) } })).value
        } else if (kind === 'agent') {
          const agentId = Object.keys(input.expectedAgentConfigurationVersionIds)[0]!
          const agent = ManagedAgentDetailSchema.parse(await call(runtime, 'agent_get', { workspaceId: input.workspaceId, agentId }))
          const updated = AgentMutationResultSchema.parse(await call(runtime, 'agent_update', { workspaceId: input.workspaceId, agentId, commandId: randomUUID(),
            expectedRevision: agent.metadataRevision, expectedConfigurationVersionId: agent.agent.configurationVersionId,
            prompt: { system: 'Changed shared instruction' } })).value
          pins = { ...pins, [agentId]: updated.agent.configurationVersionId! }
        } else {
          await call(runtime, 'workspace_location_set', { workspaceId: input.workspaceId, commandId: randomUUID(),
            expectedLocationRevision: 2, runnerId: LOCAL_RUNNER_ID, rootPath: database.directory })
          locationRevision = 3
        }
        release.resolve()
        const rejected = await pending
        expect(rejected.statusCode).toBe(409)
        const canceled = await call(runtime, 'run_start_resolve', input)
        expect(canceled).toEqual({ status: 'canceled' })
        expect((await http(runtime, input, '/start-resolution')).json()).toEqual(canceled)
        expect((await http(runtime, input)).json()).toMatchObject({ error: { code: 'RUN_START_CANCELED' } })
        expect((await database.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
        const receipts = await database.pool.query('select result from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
          [runtime.writer.principal.id, 'run.start', input.commandId])
        expect(receipts.rows).toEqual([{ result: { status: 'canceled' } }])
        pause.mockRestore()
        if (kind !== 'workflow') {
          latest = CurrentWorkflowSaveResultSchema.parse(await call(runtime, 'workflow_save_v3', { ...save,
            commandId: randomUUID(), expectedRevision: saved.revision, expectedWorkflowVersionId: saved.version.id,
            expectedAgentConfigurationVersionIds: pins,
            graph: saved.version.definition,
          })).value
        }
        const fresh = { ...input, commandId: randomUUID(), workflowVersionId: latest.version.id,
          expectedWorkflowRevision: latest.revision, expectedAgentConfigurationVersionIds: pins,
          expectedLocationRevision: locationRevision }
        expect((await http(runtime, fresh)).statusCode).toBe(202)
        expect((await database.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toHaveLength(1)
      } finally {
        release.resolve()
        await pending
        pause.mockRestore()
        await runtime.close()
      }
    }, 120_000)

  it('returns a committed Run after a lost reply and never permits its command to be canceled', async () => {
    const { runtime, input } = await setup()
    try {
      const accepted = RunStartV3ResultSchema.parse((await http(runtime, input)).json())
      const resolved = await call(runtime, 'run_start_resolve', input)
      expect(resolved).toMatchObject({ status: 'accepted', run: { id: accepted.run.id } })
      expect((await http(runtime, input, '/start-resolution')).json()).toEqual(resolved)
      expect(RunStartV3ResultSchema.parse((await http(runtime, input)).json())).toMatchObject({
        replayed: true, run: { id: accepted.run.id } })
      expect((await database.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toHaveLength(1)
      const reader = await runtime.access.issue({ name: 'Read-only caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'], scope: {} }] })
      expect((await http(runtime, input, '/start-resolution', reader.token)).statusCode).toBe(403)
      const denied = await (await runtime.connect(reader.token)).callTool({ name: 'run_start_resolve', arguments: input })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    } finally { await runtime.close() }
  }, 120_000)

  it('serializes cancellation with a Start still preparing its original command', async () => {
    const { runtime, input } = await setup()
    const entered = deferred<void>()
    const release = deferred<void>()
    const snapshot = runtime.locations.snapshot.bind(runtime.locations)
    const pause = vi.spyOn(runtime.locations, 'snapshot').mockImplementation(async (...args) => {
      const result = await snapshot(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const pending = http(runtime, input)
    try {
      await entered.promise
      expect(await call(runtime, 'run_start_resolve', input)).toEqual({ status: 'canceled' })
      release.resolve()
      expect((await pending).json()).toMatchObject({ error: { code: 'RUN_START_CANCELED' } })
      expect((await database.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
    } finally {
      release.resolve()
      await pending
      pause.mockRestore()
      await runtime.close()
    }
  }, 120_000)

  it('returns the original Run when another tab completes Start while recovery waits on its command lock', async () => {
    const { runtime, input } = await setup()
    const entered = deferred<void>()
    const release = deferred<void>()
    const lock = startLocks.waitForRunStartLock
    let starts = 0
    let recoveryWaiting = false
    const pause = vi.spyOn(startLocks, 'waitForRunStartLock').mockImplementation(async (...args) => {
      const command = args[1].startsWith('command:')
      const attempt = command ? ++starts : 0
      if (attempt === 3) recoveryWaiting = true
      await lock(...args)
      if (attempt === 2) {
        entered.resolve()
        await release.promise
      }
    })
    const pending = http(runtime, input)
    try {
      await entered.promise
      const resolution = runtime.client.callTool({ name: 'run_start_resolve', arguments: input })
      await vi.waitFor(() => expect(recoveryWaiting).toBe(true), { timeout: 5_000 })
      release.resolve()
      const [accepted, resolved] = await Promise.all([pending, resolution])
      const run = RunStartV3ResultSchema.parse(accepted.json()).run
      expect(resolved.isError).not.toBe(true)
      expect(decodeMcpToolResult(resolved)).toMatchObject({ status: 'accepted', run: { id: run.id } })
      expect((await database.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toHaveLength(1)
    } finally {
      release.resolve()
      await pending
      pause.mockRestore()
      await runtime.close()
    }
  }, 120_000)

})
