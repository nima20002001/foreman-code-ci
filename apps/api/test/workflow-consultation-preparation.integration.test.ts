import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { WorkflowExecutionChatResolutionSchema } from '@foreman-code/contracts'
import { WorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatService.js'
import { workflowChatInputPrompt } from '../src/modules/interactions/workflowChatInput.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { CheckpointTestProvider } from './helpers/wave25Br1003Provider.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('coordinator consultation preparation', () => {
  it.each(['preflight', 'attach'] as const)(
    'disposes an unsubmitted cold manager and dispatches the promoted queued reply after %s failure', async phase => {
    const preparing = deferred()
    const release = deferred()
    const consultationManagers = new WeakSet<object>()
    const disposed: string[] = []
    let preparations = 0
    const provider = new CheckpointTestProvider(new Set(['build']), 1, true, false,
      (node, request) => coordinationOutput(node, request, node === 'master' ? { select: ['build'] } : {}))
    const f = await checkpointRuntimeFixture(1, 1, {
      fixture: hierarchyRuntimeFixture(), collaborationPorts: {}, approvalNodeIds: ['build'],
      managerFactory: context => {
        const manager = provider.connection()
        if (context.purpose === 'consultation') {
          consultationManagers.add(manager)
          if (phase === 'attach') manager.attachSession = async () => {
            preparations++
            if (preparations === 1) {
              preparing.resolve()
              await release.promise
            }
            throw new DomainError('NATIVE_SESSION_ATTACH_FAILED', 'The provider rejected attachment.', 409)
          }
          const dispose = manager.dispose!.bind(manager)
          manager.dispose = async signal => {
            disposed.push(context.consultation!.consultationId)
            await dispose(signal)
          }
        }
        return manager
      },
      mcpInspector: manager => ({ async inspect(input) {
        if (consultationManagers.has(manager) && phase === 'preflight') {
          preparations++
          if (preparations === 1) {
            preparing.resolve()
            await release.promise
          }
          throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'The provider rejected consultation setup.', 409)
        }
        return { harness: input.harness, providerVersion: '0.154.0', runnerId: input.runnerId,
          workingDirectory: input.workingDirectory, inspectedAt: new Date().toISOString(),
          entry: { name: input.serverName, transport: 'streamable-http', endpoint: 'http://127.0.0.1:4100/mcp/app',
            enabled: true, credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', status: 'connected' } }
      } }),
    })
    let first: Promise<unknown> | undefined
    try {
      const caller = await new PostgresAccessService(f.db.pool).issue({ name: 'Consultation Operator', audience: 'operator',
        grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.f.run.workspaceId] } }] })
      const chat = new WorkflowExecutionChatService(f.db.pool, {
        owner: f.native.workflowChatOwner(f.db.pool, async (_context, request) => ({ nativePrompt: workflowChatInputPrompt(request) })),
        assertAttachments: async (_principal, request) => {
          if (request.attachments.length) throw new Error('This text-only fixture has no uploaded files.')
        },
      })
      await f.engine.start(f.f.run.id)
      const selected = WorkflowExecutionChatResolutionSchema.parse(await chat.resolve(caller.principal, {
        workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId,
        workflowNodeId: 'master', runId: f.f.run.id,
      }))
      expect(selected.kind).toBe('selected')
      if (selected.kind !== 'selected') throw new Error('Expected the waiting coordinator')
      expect(selected.target.kind).toBe('workflow_coordinator')
      const original = (await f.runs.listRepeatExecutions(f.f.run.id)).map(row => row.execution)
      first = chat.deliver(caller.principal, { commandId: 'first-reply', target: selected.target,
        intent: 'next_turn', content: 'Explain current progress', attachments: [] })
      await preparing.promise
      const queued = await chat.deliver(caller.principal, { commandId: 'next-reply', target: selected.target,
        intent: 'next_turn', content: 'Explain the remaining work', attachments: [] })
      expect(queued.state).toBe('queued')
      release.resolve()
      await first
      const readback = await chat.read(caller.principal, { target: selected.target })
      expect(readback.receipts.map(receipt => ({ commandId: receipt.commandId, state: receipt.state })))
        .toEqual([{ commandId: 'first-reply', state: 'failed' }, { commandId: 'next-reply', state: 'failed' }])
      expect(preparations).toBe(2)
      expect(new Set(disposed).size).toBe(2)
      expect((await f.db.pool.query("select principal_id from worker_credential_bindings where run_id=$1 and purpose='consultation' and revoked_at is null",
        [f.f.run.id])).rows).toEqual([])
      expect((await f.runs.listRepeatExecutions(f.f.run.id)).map(row => row.execution)).toEqual(original)
      expect((await f.db.pool.query('select state,active_consultation_id from run_coordinator_mailboxes where run_id=$1',
        [f.f.run.id])).rows).toEqual([{ state: 'idle', active_consultation_id: null }])
    } finally {
      release.resolve()
      await first
      await f.close()
    }
  }, 60_000)
})
