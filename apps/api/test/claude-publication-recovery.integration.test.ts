import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { readClaudeMessagePublicationReceipts, readClaudeMessagePublications } from '../src/modules/harnesses/claudeSdk/publications.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

describe('Claude persisted publication recovery', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  beforeAll(async () => { database = await migratedDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  async function conversation() {
    const id = randomUUID()
    const { operator, configuration } = await new PostgresOperatorRepository(database.pool).ensure()
    const operatorId = operator.id
    const ownerId = (await new PostgresAccessService(database.pool).issue({
      name: 'Publication owner', audience: 'operator', grants: [], expiresAt: new Date(Date.now() + 60_000),
    })).principal.id
    const messageId = randomUUID()
    await database.pool.query(`insert into operator_conversations(id,operator_id,operator_configuration_version_id,owner_principal_id,harness,record)
      values($1,$2,$4,$3,'claude','{}')`, [id, operatorId, ownerId, configuration.id])
    await database.pool.query(`insert into operator_conversation_messages(id,conversation_id,role,content,client_request_id,record)
      values($1,$2,'user','Publish output','request','{}')`, [messageId, id])
    const nativeSubmission = { kind: 'message', nativeSessionId: `session-${id}`, nativeMessageId: `native-${messageId}`,
      clientCorrelationId: 'correlation' }
    await database.pool.query(`insert into operator_conversation_turns(conversation_id,request_id,payload,input_hash,message_id)
      values($1,'request',$2::jsonb,'hash',$3)`, [id, JSON.stringify({ nativeSubmission }), messageId])
    const binding = bindingIdentity({ ownerPrincipalId: ownerId, nativeSessionId: nativeSubmission.nativeSessionId,
      nativeMessageId: nativeSubmission.nativeMessageId, messageId, allowMutation: false, allowedTools: [],
      scope: { kind: 'temporary', chat: { kind: 'operator', conversationId: id, ownerPrincipalId: ownerId, operatorId } } })
    return { id, ownerId, messageId, binding, nativeSubmission }
  }

  async function publication(owner: Awaited<ReturnType<typeof conversation>>, state: string, mismatch = false) {
    const fileId = randomUUID()
    const revisionId = randomUUID()
    const requestId = randomUUID()
    await withTransaction(database.pool, async client => {
      await client.query(`insert into files(file_id,owner_principal_id,current_revision_id,scope_kind,workspace_id,state,created_at)
        values($1,$2,$3,'workspace_reference','fixture-workspace','ready',now())`, [fileId, owner.ownerId, revisionId])
      for (const revision of mismatch ? [revisionId, `${revisionId}-other`] : [revisionId]) {
        await client.query(`insert into file_revisions(revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key)
          values($1,$2,'output.md','text/markdown',4,$3,'agent_output',now(),$4)`,
        [revision, fileId, 'a'.repeat(64), randomUUID()])
      }
      await client.query(`insert into file_allocations(allocation_id,owner_principal_id,request_id,input_hash,file_id,revision_id,state,created_at)
        values($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), owner.ownerId, requestId, 'b'.repeat(64), fileId,
        mismatch ? `${revisionId}-other` : revisionId, state])
      await client.query(`insert into file_tool_publications(owner_principal_id,request_id,binding,file_id,revision_id,record)
        values($1,$2,$3,$4,$5,'{}')`, [owner.ownerId, requestId, owner.binding, fileId, revisionId])
    })
    return { fileId, revisionId, requestId }
  }

  it('recovers only the finalized allocation for the admitted message and conversation', async () => {
    const owner = await conversation()
    const other = await conversation()
    const valid = await publication(owner, 'finalized')
    await publication(owner, 'allocated')
    await publication(owner, 'staged')
    await publication(owner, 'canceled')
    await publication(owner, 'finalized', true)
    await publication(other, 'finalized')
    const receipts = await readClaudeMessagePublicationReceipts(database.pool, owner.id, [owner.messageId, other.messageId])
    expect(receipts).toEqual([{ receiptId: valid.requestId, messageId: owner.messageId, fileId: valid.fileId,
      fileRevisionId: valid.revisionId, nativeSessionId: owner.nativeSubmission.nativeSessionId,
      nativeMessageId: owner.nativeSubmission.nativeMessageId, fileActivityRevision: '0', fileState: 'ready' }])
    expect(await readClaudeMessagePublications(database.pool, owner.id, [owner.messageId]))
      .toEqual(new Map([[owner.messageId, [{ fileId: valid.fileId, revisionId: valid.revisionId }]]]))
    expect(await readClaudeMessagePublications(database.pool, other.id, [owner.messageId])).toEqual(new Map())
  })
})
