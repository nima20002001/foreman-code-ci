import type pg from 'pg'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { MessageAttachmentRefsSchema, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { PostgresAccessService } from '../../access/postgres.js'
import { PostgresFileConversationAuthorization } from '../../files/authorization.js'
import type { TemporaryFileService } from '../../files/service.js'
import { bindingIdentity } from '../../files/tools/context.js'
import { fileScopeIdentity } from '../../files/requests.js'
import { PostgresWorkflowRepository } from '../../workflows/postgres.js'
import { DomainError } from '../../errors.js'
import { MessagePublicationRefsSchema } from '../../conversations/messagePublications.js'
import { codexChatFileTools } from './declarations.js'
import type { CodexFileHostLease } from './port.js'
import type { ProductionCodexChatFiles } from './production.js'

interface AdmissionRow {
  request_id: string
  message_id: string
  native_turn_id: string | null
  payload: { ownerPrincipalId?: string }
  record: { attachmentRefs?: MessageAttachmentRef[] }
  native_session_id: string | null
  provider_version: string | null
  workspace_id: string
  agent_id: string
  agent_configuration_version_id: string
  harness: string
  conversation_record: { workingDirectory: string }
}

/** Resolve only the exact persisted receipt, message and native session. */
export function postgresCodexChatFiles(pool: pg.Pool, files: () => TemporaryFileService,
  host: (conversationId: string) => Promise<CodexFileHostLease>,
  hostRoot: string | { assertCurrent(): Promise<void> }): ProductionCodexChatFiles {
  const access = new PostgresAccessService(pool)
  const authorization = new PostgresFileConversationAuthorization(pool)
  const workflows = new PostgresWorkflowRepository(pool)
  return { async resolve(input) {
    input.signal.throwIfAborted()
    const prefix = `agent-chat:${input.conversationId}:`
    if (!input.clientCorrelationId.startsWith(prefix)) throw new DomainError(
      'CODEX_FILE_ADMISSION_MISMATCH', 'The native correlation does not address this conversation.', 409)
    const requestId = input.clientCorrelationId.slice(prefix.length)
    const row = (await pool.query<AdmissionRow>(`select t.request_id,t.message_id,t.native_turn_id,t.payload,m.record,
      c.native_session_id,c.provider_version,c.workspace_id,c.agent_id,c.agent_configuration_version_id,c.harness,
      c.record as conversation_record
      from operator_conversation_turns t join operator_conversations c on c.id=t.conversation_id
      join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id and m.role='user'
      where c.id=$1 and c.kind='agent' and c.deleted_at is null and t.intent<>'steer' and t.request_id=$2`,
    [input.conversationId, requestId])).rows[0]
    if (!row || row.harness !== 'codex' || row.native_session_id !== input.session.nativeSessionId
      || row.provider_version !== input.session.providerVersion) throw new DomainError(
      'CODEX_FILE_ADMISSION_MISMATCH', 'The native turn has no matching persisted chat admission.', 409)
    const attachments = MessageAttachmentRefsSchema.parse(row.record.attachmentRefs ?? [])
    // Inherited references use the same scoped tools even without temporary inputs.
    if (!row.payload.ownerPrincipalId) throw new DomainError(
      'CODEX_FILE_ADMISSION_OWNER_MISSING', 'The persisted file turn has no authenticated sender.', 409)
    const ownerPrincipalId = row.payload.ownerPrincipalId
    const owner = await access.currentOperator(ownerPrincipalId)
    const scope = await authorization.resolve(owner, { kind: 'agent', workspaceId: row.workspace_id,
      conversationId: input.conversationId }, 'read')
    const configuration = await workflows.getAgentConfiguration(row.agent_configuration_version_id)
    if (!configuration || configuration.agentId !== row.agent_id || configuration.harness.harness !== 'codex'
      || configuration.harness.sandbox === 'danger-full-access') throw new DomainError(
      'CODEX_FILE_HOST_UNAVAILABLE', 'This Codex configuration cannot safely receive local file paths.', 409)
    const allowMutation = configuration.harness.sandbox === 'workspace-write'
    if (typeof hostRoot === 'string') {
      const writableRoots = await Promise.all([row.conversation_record.workingDirectory,
        ...(configuration.harness.advanced?.additionalWritableDirectories ?? [])].map((path) => realpath(path)))
      await mkdir(hostRoot, { recursive: true, mode: 0o700 })
      const canonicalHostRoot = await realpath(hostRoot)
      const inside = (parent: string, child: string) => {
        const path = relative(resolve(parent), resolve(child))
        return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
      }
      if (writableRoots.some((root) => inside(root, canonicalHostRoot) || inside(canonicalHostRoot, root))
        || (allowMutation && ['/tmp', '/var/tmp'].some((root) => inside(root, canonicalHostRoot)))) throw new DomainError(
        'CODEX_FILE_HOST_UNAVAILABLE', 'The file host overlaps a Codex writable root.', 409)
    } else {
      await hostRoot.assertCurrent()
    }
    const allowedTools = codexChatFileTools(configuration.harness)
    if (allowMutation) await authorization.resolve(owner, { kind: 'agent', workspaceId: row.workspace_id,
      conversationId: input.conversationId }, 'write')
    const lease = await host(input.conversationId)
    const accepted = {
      ownerPrincipalId, scope, nativeSessionId: row.native_session_id, messageId: row.message_id,
      admissionId: row.request_id, executionHostId: lease.executionHostId,
      projectMode: allowMutation ? 'write' as const : 'read' as const,
      allowMutation, allowedTools, expiresAt: new Date(owner.expiresAt), attachments,
    }
    const target = { kind: 'agent' as const, workspaceId: row.workspace_id, conversationId: input.conversationId }
    const recheck = async (ref: MessageAttachmentRef) => {
      const principal = await access.currentOperator(ownerPrincipalId)
      await authorization.resolve(principal, target, 'read')
      const pinned = await pool.query(`select 1 from operator_conversations c
        join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=$2
        join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id
        where c.id=$1 and c.kind='agent' and c.deleted_at is null and c.native_session_id=$3
          and t.message_id=$4 and m.record->'attachmentRefs' @> $5::jsonb`,
      [input.conversationId, row.request_id, row.native_session_id, row.message_id, JSON.stringify([ref])])
      if (!pinned.rowCount) throw new DomainError('CODEX_FILE_ADMISSION_MISMATCH',
        'The pinned attachment no longer belongs to this persisted message.', 409)
      const stored = await files().repository.read(ref.fileId, ref.revisionId)
      if (!stored || stored.value.file.scope.kind !== 'temporary'
        || fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(scope)) throw new DomainError(
        'CODEX_FILE_UNAVAILABLE', 'The pinned attachment is unavailable in this conversation.', 410)
      return stored.value
    }
    return {
      clientCorrelationId: input.clientCorrelationId, accepted,
      dependencies: { host: lease, source: {
        async open(ref) {
          await recheck(ref)
          const downloaded = await files().download(await access.currentOperator(ownerPrincipalId), target, ref)
          try { return { value: await recheck(ref), stream: downloaded.stream } }
          catch (error) { downloaded.stream.destroy(); throw error }
        }, recheck,
      } },
      async adoptPublished(nativeTurnId, refs) {
        await withTransaction(pool, async (client) => {
          const current = (await client.query<{ native_session_id: string; native_turn_id: string; message_id: string }>(`
            select c.native_session_id,t.native_turn_id,t.message_id from operator_conversations c
            join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=$2
            where c.id=$1 and c.kind='agent' and c.deleted_at is null for update of c,t`,
          [input.conversationId, row.request_id])).rows[0]
          if (!current || current.native_session_id !== row.native_session_id || current.native_turn_id !== nativeTurnId
            || current.message_id !== row.message_id) throw new DomainError(
            'CODEX_FILE_PUBLICATION_MISMATCH', 'The publication does not belong to this persisted turn.', 409)
          const binding = bindingIdentity({ ownerPrincipalId, scope, nativeSessionId: row.native_session_id!,
            turnId: nativeTurnId, messageId: row.message_id, allowMutation, allowedTools: [...allowedTools] })
          const published = (await client.query<{ file_id: string; revision_id: string }>(`select p.file_id,p.revision_id
            from file_tool_publications p join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
            where p.binding=$1 and a.state='finalized'`, [binding])).rows
          for (const ref of refs) if (!published.some((pin) => pin.file_id === ref.fileId && pin.revision_id === ref.revisionId)) {
            throw new DomainError('CODEX_FILE_PUBLICATION_MISMATCH', 'The publication is not finalized for this turn.', 409)
          }
          const message = (await client.query<{ record: { attachmentRefs?: MessageAttachmentRef[]; publicationRefs?: MessageAttachmentRef[] } }>(`
            select record from operator_conversation_messages where id=$1 and conversation_id=$2 and role='user' for update`,
          [row.message_id, input.conversationId])).rows[0]
          if (!message) throw new DomainError('CODEX_FILE_MESSAGE_MISSING', 'The originating message is unavailable.', 409)
          const originals = message.record.attachmentRefs ?? []
          const byFile = new Map([...originals, ...(message.record.publicationRefs ?? [])].map((ref) => [ref.fileId, ref]))
          for (const pin of published) {
            const ref = { fileId: pin.file_id, revisionId: pin.revision_id }
            const prior = byFile.get(ref.fileId)
            if (prior && prior.revisionId !== ref.revisionId) throw new DomainError(
              'CODEX_FILE_PUBLICATION_CONFLICT', 'A different revision is already pinned to this message.', 409)
            byFile.set(ref.fileId, ref)
          }
          const output = MessagePublicationRefsSchema.parse([...byFile.values()]
            .filter((ref) => !originals.some((input) => input.fileId === ref.fileId)))
          await client.query(`update operator_conversation_messages set record=jsonb_set(record,'{publicationRefs}',$2::jsonb)
            where id=$1`, [row.message_id, JSON.stringify(output)])
        })
      },
    }
  } }
}
