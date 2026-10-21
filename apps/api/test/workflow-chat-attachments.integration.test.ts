import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { AgentReferenceService } from '../src/modules/files/references/agentService.js'
import { PostgresAgentReferenceAuthorization } from '../src/modules/files/references/agentAuthorization.js'
import { PostgresReferenceReadRepository } from '../src/modules/files/references/agentProvenance.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('workflow chat attachment delivery', () => {
  it.each(['workflow', 'consultation'] as const)('reads only the immutable attachment admitted to the exact %s subject', async purpose => {
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}))
    const consultationEntered = deferred(), consultationRelease = deferred()
    const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => {
        const manager = provider.connection(context)
        if (context.purpose === 'consultation') {
          const start = manager.startTurn.bind(manager)
          manager.startTurn = async function* (...args) {
            for await (const event of start(...args)) {
              yield event
              if (event.type === 'turn.started') { consultationEntered.resolve(undefined); await consultationRelease.promise }
            }
          }
        }
        return manager
      } })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, purpose === 'workflow' ? 'builder' : 'master')
      const source = (await f.runs.listRepeatExecutions(f.f.run.id))
        .find(row => row.execution.workflowNodeId === target.agent.workflowNodeId)!.execution
      const conversation = await new PostgresAgentChatRepository(f.db.pool).ensureForControls(randomUUID(), {
        context: target.agent, agentConfigurationVersionId: source.agentConfigurationVersionId, harness: 'codex',
        origin: { kind: 'run_execution', runId: source.runId, executionId: source.id,
          sourceNativeSessionId: source.nativeSessionId! }, workingDirectory: f.db.directory, runtimeDirectory: f.db.directory,
      }, async () => {})
      const bytes = new FileByteStorage(join(f.db.directory, 'chat-attachments'), MAX_FILE_BYTES)
      await bytes.initialize()
      const files = new PostgresFileRepository(f.db.pool)
      const storage = new TemporaryFileService(files, bytes, new PostgresFileConversationAuthorization(f.db.pool))
      const conversationTarget = { kind: 'agent' as const, workspaceId: f.f.run.workspaceId, conversationId: conversation.id }
      const content = Buffer.from('Exact execution attachment contents')
      const upload = async () => {
        const requestId = randomUUID()
        await storage.allocate(f.writer.principal, conversationTarget, { requestId, filename: 'notes.md',
          mediaType: 'text/markdown', byteSize: content.length, sha256: createHash('sha256').update(content).digest('hex') })
        await storage.upload(f.writer.principal, conversationTarget, requestId, Readable.from([content]))
        const result = await storage.finalize(f.writer.principal, conversationTarget, requestId)
        return { fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId }
      }
      const admitted = await upload(), unadmitted = await upload()
      await workflowChatCall(f, 'agent_chat_send', { commandId: 'attached-note', target,
        intent: purpose === 'workflow' ? 'interrupt_and_send' : 'next_turn', content: 'Read the attached notes.', attachments: [admitted] })
      if (purpose === 'consultation') await consultationEntered.promise
      const subjectId = async () => (await f.db.pool.query<{ subject_id: string }>(`select
        coalesce(consultation_id,delivered_execution->>'executionId') as subject_id from run_chat_commands
        where run_id=$1 and command_id='attached-note'`, [f.f.run.id])).rows[0]?.subject_id
      await expect.poll(async () => {
        const id = await subjectId()
        return id !== undefined && provider.credentials.has(id)
      }, { timeout: 15_000 }).toBe(true)
      const admittedSubject = await subjectId()
      if (!admittedSubject) throw new Error('The delivered input has no native subject')
      const principal = await f.access.authenticate(provider.credentials.get(admittedSubject)!, ['worker'])
      const reader = new AgentReferenceService({ files, bytes, authorization: new PostgresAgentReferenceAuthorization(f.db.pool),
        reads: new PostgresReferenceReadRepository(f.db.pool) }).forExecution(principal)
      expect(await reader.read({ ...unadmitted, offset: 0, length: 64 })).toMatchObject({ status: 'unavailable', reason: 'not_found' })
      expect(await reader.read({ ...admitted, revisionId: 'different-revision', offset: 0, length: 64 }))
        .toMatchObject({ status: 'unavailable', reason: 'not_found' })
      expect(await reader.read({ ...admitted, offset: 6, length: 9 })).toMatchObject({ status: 'ready', offset: 6,
        byteLength: 9, contentBase64: content.subarray(6, 15).toString('base64'), eof: false })
      expect(await reader.list()).toMatchObject({ items: [] })
      await f.access.revoke(principal.id)
      await expect(reader.read({ ...admitted, offset: 0, length: 64 })).rejects.toThrow()
    } finally {
      consultationRelease.resolve(undefined); provider.releaseAll(); await f.stop(); await drive; await f.close()
    }
  }, 60_000)
})
