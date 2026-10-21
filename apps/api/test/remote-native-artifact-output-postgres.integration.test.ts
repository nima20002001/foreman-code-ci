import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NativeArtifactOutputSchema } from '../src/modules/runs/remote/nativeArtifactOutputs.js'
import { PostgresNativeArtifactOutputRepository } from '../src/modules/runs/remote/nativeArtifactOutputPostgres.js'
import { findRunChatConversation, runChatStorageKey } from '../src/modules/conversations/selectedRunChat.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `native_output_${randomUUID().replaceAll('-', '')}`
const operation = 'remote.native-artifact.output'

/** SQL receipt guards only; this does not manufacture a native artifact or qualify a host. */
describe.skipIf(!databaseUrl)('original native artifact output receipt SQL guards', () => {
  let admin: pg.Pool, pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/test/i.test(url.pathname)) throw new Error('Owned loopback TEST_DATABASE_URL required.')
    admin = new pg.Pool({ connectionString: databaseUrl })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    await applyApplicationMigrations(pool)
    await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
      values ('owner-a','SQL fixture','operator',$1,'[]',clock_timestamp()+interval '1 hour'),
             ('owner-b','SQL fixture','operator',$2,'[]',clock_timestamp()+interval '1 hour')`, ['a'.repeat(64), 'b'.repeat(64)])
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await dropFixtureSchema(admin, schema) } finally { await admin.end() } }
  })
  const insert = (principal: string, command: string, target: string, result: unknown, op = operation) => pool.query(`
    insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
    values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`, [principal, op, command, target, 'c'.repeat(64), JSON.stringify(result)])
  it('keeps one original slot across retries and principals, with distinct Main namespaces', async () => {
    const target = JSON.stringify(['main-a', 'execution', 'attempt', 'output'])
    await insert('owner-a', 'first', target, { fixture: 'original' })
    await Promise.all([insert('owner-a', 'retry', target, { fixture: 'changed' }), insert('owner-b', 'foreign', target, { fixture: 'foreign' })])
    const stored = await pool.query('select principal_id,result from management_command_receipts where operation=$1 and target_key=$2', [operation, target])
    expect(stored.rows).toEqual([{ principal_id: 'owner-a', result: { fixture: 'original' } }])
    expect((await insert('owner-a', 'other-main', JSON.stringify(['main-b', 'execution', 'attempt', 'output']), { fixture: 'other namespace' })).rowCount).toBe(1)
    expect((await pool.query('select count(*)::int as count from application_migrations where version=285205')).rows[0].count).toBe(1)
  })
  it('rejects mutation, deletion and retrofitting an ordinary receipt into a native output', async () => {
    const target = JSON.stringify(['main-a', 'execution', 'attempt', 'immutable'])
    await insert('owner-a', 'immutable', target, { fixture: 'original' })
    await expect(pool.query('update management_command_receipts set result=$1 where operation=$2 and target_key=$3', ['{}', operation, target])).rejects.toThrow('immutable')
    await expect(pool.query('delete from management_command_receipts where operation=$1 and target_key=$2', [operation, target])).rejects.toThrow('immutable')
    await insert('owner-a', 'ordinary', 'ordinary', { fixture: 'ordinary' }, 'fixture.ordinary')
    await expect(pool.query("update management_command_receipts set operation=$1 where operation='fixture.ordinary'", [operation])).rejects.toThrow('original command insertion')
    expect((await pool.query("update management_command_receipts set result='{}' where operation='fixture.ordinary'")).rowCount).toBe(1)
  })
  async function outputFixture(internalContext = false, nativeSessionId?: string) {
    // Explicit SQL-boundary facts. These rows are not native qualification or a physical publication.
    const suffix = randomUUID(), principalId = `sql-output-${suffix}`, mainId = randomUUID()
    const workspaceId = `workspace-${suffix}`, agentId = `agent-${suffix}`, configurationId = randomUUID(), conversationId = randomUUID()
    const producer = { workspaceId, workflowId: `workflow-${suffix}`, runId: `run-${suffix}`, nodeId: 'sql-node', executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'b'.repeat(64) }
    const scope = { kind: 'temporary' as const, chat: { kind: 'agent' as const, conversationId, agentId, workspaceId, workflowId: producer.workflowId, runId: producer.runId, executionId: producer.executionId } }
    const context: FileToolContext = { ownerPrincipalId: principalId, scope, nativeSessionId: nativeSessionId ?? `sql-native-${suffix}`, turnId: 'sql-turn', allowMutation: true, allowedTools: ['files.publish_result'] }
    const fileId = randomUUID(), revisionId = randomUUID(), transferId = randomUUID(), body = Buffer.from('SQL boundary fixture'), sha256 = createHash('sha256').update(body).digest('hex')
    const record = NativeArtifactOutputSchema.parse({ version: 1, producer, outputKey: 'report', commandId: 'sql-original-command', nativeIdentity: { nativeSessionId: context.nativeSessionId, turnId: context.turnId },
      publication: { ownerPrincipalId: principalId, requestId: randomUUID(), binding: bindingIdentity(context) }, pins: { fileId, revisionId, sha256, byteSize: body.length }, scope,
      transferReceipt: { version: 1, receiptId: randomUUID(), transferId, sha256, byteSize: body.length, verifiedAt: new Date().toISOString(), intent: { version: 1, mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), transferId, operationId: randomUUID(), executionId: producer.executionId, attemptId: producer.attemptId, placementHash: producer.placementHash, rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact', sha256, byteSize: body.length, manifestDigest: 'c'.repeat(64), chunkBytes: 1024, expiresAt: '2099-01-01T00:00:00.000Z' } } })
    const chatContext = { workspaceId, workflowId: producer.workflowId, runId: producer.runId, workflowNodeId: producer.nodeId, agentId }
    const agentKey = internalContext ? 'workflow-native-files:v1:' + JSON.stringify([mainId, producer.executionId, producer.attemptId]) : runChatStorageKey(chatContext, producer.executionId)
    const conversationRecord = { origin: { kind: 'run_execution', runId: producer.runId, executionId: producer.executionId, sourceNativeSessionId: context.nativeSessionId }, workingDirectory: '/sql-fixture/source', runtimeDirectory: '/sql-fixture/runtime', workflowFileContext: { fixture: 'original admission' } }
    await withTransaction(pool, async client => {
      await client.query("insert into management_principals(id,name,audience,token_hash,grants,expires_at) values($1,'SQL fixture','operator',$2,$3::jsonb,clock_timestamp()+interval '1 hour')", [principalId, createHash('sha256').update(suffix).digest('hex'), JSON.stringify([{ actions: ['agent_chat:write'], scope: { workspaceIds: [workspaceId] } }])])
      await client.query("insert into workspaces(id,record) values($1,'{}')", [workspaceId])
      await client.query("insert into agents(id,workspace_id,record) values($1,$2,'{}')", [agentId, workspaceId])
      await client.query("insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,'{}')", [configurationId, workspaceId, agentId])
      const workflowVersionId = randomUUID()
      await client.query("insert into workflows(id,workspace_id,record) values($1,$2,'{}')", [producer.workflowId, workspaceId])
      await client.query("insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record) values($1,$2,$3,1,'sql-node',$4::jsonb)", [workflowVersionId, workspaceId, producer.workflowId, JSON.stringify({ id: workflowVersionId, workspaceId, workflowId: producer.workflowId, executionSemanticsVersion: 3, agentConfigurationVersionIds: { [agentId]: configurationId }, definition: { executionSemanticsVersion: 3, nodes: [{ id: producer.nodeId, agentId }] } })])
      await client.query("insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,'completed',$5::jsonb)", [producer.runId, workspaceId, producer.workflowId, workflowVersionId, JSON.stringify({ id: producer.runId, workspaceId, workflowId: producer.workflowId, workflowVersionId, executionSemanticsVersion: 3, executionState: 'completed', agentConfigurationVersionIds: { [agentId]: configurationId } })])
      await client.query("insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,'sql-node',$3,1,$4::jsonb)", [producer.executionId, producer.runId, agentId, JSON.stringify({ id: producer.executionId, runId: producer.runId, workflowNodeId: producer.nodeId, agentId, attempt: 1, agentConfigurationVersionId: configurationId })])
      await client.query("insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,harness,provider_version,native_session_id,origin_run_id,origin_execution_id,record) values($1,'agent',$2,$3,$4,'sql-node',$5,$6,'codex','sql-provider',$7,$8,$9,$10::jsonb)", [conversationId, agentKey, workspaceId, producer.workflowId, agentId, configurationId, context.nativeSessionId, producer.runId, producer.executionId, JSON.stringify(conversationRecord)])
      await client.query("insert into files(file_id,owner_principal_id,current_revision_id,scope_kind,chat_kind,conversation_id,agent_id,workspace_id,workflow_id,run_id,execution_id,state,created_at,retention_duration_seconds,expires_at) values($1,$2,$3,'temporary','agent',$4,$5,$6,$7,$8,$9,'ready',now(),3600,now()+interval '1 hour')", [fileId, principalId, revisionId, conversationId, agentId, workspaceId, producer.workflowId, producer.runId, producer.executionId])
      await client.query("insert into file_revisions(revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key) values($1,$2,'fixture.md','text/markdown',$3,$4,'agent_output',now(),$5)", [revisionId, fileId, body.length, sha256, randomUUID()])
      await client.query("insert into file_allocations(allocation_id,owner_principal_id,request_id,input_hash,file_id,revision_id,state,created_at) values($1,$2,$3,$4,$5,$6,'finalized',now())", [randomUUID(), principalId, record.publication.requestId, 'a'.repeat(64), fileId, revisionId])
      const link = { ...record.publication, context, ref: { fileId, revisionId }, transferReceipt: record.transferReceipt, publicationInputHash: 'a'.repeat(64), createdAt: new Date().toISOString() }
      await client.query('insert into file_tool_publications(owner_principal_id,request_id,binding,file_id,revision_id,record) values($1,$2,$3,$4,$5,$6::jsonb)', [principalId, record.publication.requestId, record.publication.binding, fileId, revisionId, JSON.stringify(link)])
    })
    const authorize = async (query: import('../src/modules/files/repository.js').FileQuery) => {
      requireAuthorization(await readLiveManagementPrincipal(query, principalId), 'agent_chat:write', { workspaceId })
    }
    return { record, mainId, principalId, conversationId, chatContext, authorize, repository: new PostgresNativeArtifactOutputRepository(pool, mainId) }
  }
  it('binds once with one audit, exact SQL retry and persisted readback, and rejects changed pins', async () => {
    const f = await outputFixture()
    expect(await f.repository.bind(f.record, f.authorize)).toEqual(f.record)
    expect(await new PostgresNativeArtifactOutputRepository(pool, f.mainId).bind(f.record, f.authorize)).toEqual(f.record)
    expect(await new PostgresNativeArtifactOutputRepository(pool, f.mainId).read(f.record.producer, f.record.outputKey)).toEqual(f.record)
    const target = JSON.stringify([f.mainId, f.record.producer.executionId, f.record.producer.attemptId, f.record.outputKey])
    expect((await pool.query('select count(*)::int as count from management_audit where action=$1 and target_key=$2', [operation, target])).rows[0].count).toBe(1)
    await expect(f.repository.bind({ ...f.record, commandId: 'changed-command' }, f.authorize)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(await f.repository.read(f.record.producer, f.record.outputKey)).toEqual(f.record)
  })
  it('keeps separate immutable workflow file contexts for one continued native thread while fencing ordinary chat ownership', async () => {
    const first = await outputFixture(true)
    const nativeSessionId = first.record.nativeIdentity.nativeSessionId
    await first.repository.bind(first.record, first.authorize)
    const next = await outputFixture(true, nativeSessionId)
    await next.repository.bind(next.record, next.authorize)
    expect(next.conversationId).not.toBe(first.conversationId)
    expect(await first.repository.read(first.record.producer, first.record.outputKey)).toEqual(first.record)
    expect(await next.repository.read(next.record.producer, next.record.outputKey)).toEqual(next.record)
    const contexts = (await pool.query<{ id: string; execution_id: string; native_session_id: string }>(
      `select id,origin_execution_id as execution_id,native_session_id from operator_conversations
        where id=any($1::text[]) order by id`, [[first.conversationId, next.conversationId]])).rows
    expect(contexts).toEqual([
      { id: first.conversationId, execution_id: first.record.producer.executionId, native_session_id: nativeSessionId },
      { id: next.conversationId, execution_id: next.record.producer.executionId, native_session_id: nativeSessionId },
    ].sort((a, b) => a.id.localeCompare(b.id)))
    await expect(pool.query("update operator_conversations set native_session_id='replacement' where id=$1",
      [first.conversationId])).rejects.toThrow('identity is immutable')
    const chat = await outputFixture(false, nativeSessionId)
    await expect(outputFixture(false, nativeSessionId)).rejects.toMatchObject({ code: '23505' })
    expect((await pool.query('select native_session_id from operator_conversations where id=$1',
      [chat.conversationId])).rows[0].native_session_id).toBe(nativeSessionId)
  })
  it('cancels a blocked binding, releases its file lock and reconstructs the same output', async () => {
    const f = await outputFixture()
    const controller = new AbortController()
    const stopped = new Error('Owned artifact adoption stopped')
    let binding: Promise<unknown> | undefined
    try {
      await withTransaction(pool, async barrier => {
        await barrier.query('lock table management_command_receipts in share mode')
        let resolvePid!: (pid: number) => void
        const pid = new Promise<number>(resolve => { resolvePid = resolve })
        binding = f.repository.bind(f.record, async query => {
          await f.authorize(query)
          resolvePid((await query.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
        }, controller.signal)
        const rejected = expect(binding).rejects.toBe(stopped)
        const backend = await pid
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
          "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1", [backend])).rows[0]?.waiting)
          .toBe(true)
        controller.abort(stopped)
        await rejected
        await barrier.query("set local lock_timeout='1s'")
        await barrier.query('select file_id from files where file_id=$1 for update', [f.record.pins.fileId])
      })
      expect(await f.repository.read(f.record.producer, f.record.outputKey)).toBeUndefined()
      const recovered = new PostgresNativeArtifactOutputRepository(pool, f.mainId)
      expect(await recovered.bind(f.record, f.authorize)).toEqual(f.record)
      expect(await recovered.read(f.record.producer, f.record.outputKey)).toEqual(f.record)
    } finally {
      controller.abort(stopped)
      if (binding) await Promise.allSettled([binding])
    }
  })
  it('rejects revoked SQL authority on retries and rolls back a newly inserted mapping at the commit fence', async () => {
    const f = await outputFixture()
    let calls = 0
    const revokeAtCommit: typeof f.authorize = async query => {
      if (++calls === 2) await query.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.principalId])
      await f.authorize(query)
    }
    await expect(f.repository.bind(f.record, revokeAtCommit)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(await f.repository.read(f.record.producer, f.record.outputKey)).toBeUndefined()
    expect((await pool.query('select count(*)::int as count from management_audit where principal_id=$1', [f.principalId])).rows[0].count).toBe(0)
    await f.repository.bind(f.record, f.authorize)
    await pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.principalId])
    await expect(f.repository.bind(f.record, f.authorize)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })
  it('rejects expired canonical retention on retries while retaining original output history', async () => {
    const f = await outputFixture()
    await f.repository.bind(f.record, f.authorize)
    await pool.query("update files set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where file_id=$1", [f.record.pins.fileId])
    await expect(f.repository.bind(f.record, f.authorize)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    expect(await f.repository.read(f.record.producer, f.record.outputKey)).toEqual(f.record)
  })

  it('keeps one original context receipt through retries, freezes it, and rejects retrofitting', async () => {
    const op = 'remote.native-artifact.context', target = JSON.stringify(['main','execution','attempt','session','turn'])
    await insert('owner-a', 'context-first', target, { proofId: 'original' }, op)
    await Promise.all([insert('owner-b', 'context-foreign', target, { proofId: 'replacement' }, op), insert('owner-a', 'context-retry', target, { proofId: 'replacement' }, op)])
    expect((await pool.query('select principal_id,result from management_command_receipts where operation=$1 and target_key=$2', [op, target])).rows).toEqual([{ principal_id: 'owner-a', result: { proofId: 'original' } }])
    await expect(pool.query('update management_command_receipts set result=$1 where operation=$2 and target_key=$3', ['{}', op, target])).rejects.toThrow('immutable')
    await expect(pool.query('delete from management_command_receipts where operation=$1 and target_key=$2', [op, target])).rejects.toThrow('immutable')
    await expect(pool.query("update management_command_receipts set operation=$1 where operation='fixture.ordinary'", [op])).rejects.toThrow('original command insertion')
  })
  it('isolates internal contexts from human Run chat selection, while retaining the ordinary fork', async () => {
    const f = await outputFixture(true)
    expect(await findRunChatConversation(pool, f.chatContext, f.record.producer.executionId)).toBeUndefined()
    const humanId = randomUUID(), humanKey = runChatStorageKey(f.chatContext, f.record.producer.executionId)
    await pool.query(`insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,harness,provider_version,native_session_id,origin_run_id,origin_execution_id,record)
      select $2,kind,$3,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,harness,provider_version,'sql-human-fork',origin_run_id,origin_execution_id,record from operator_conversations where id=$1`, [f.conversationId, humanId, humanKey])
    const human = await findRunChatConversation(pool, f.chatContext, f.record.producer.executionId)
    expect(human?.id).toBe(humanId); expect(human?.native_session_id).toBe('sql-human-fork')
    expect((await pool.query('select native_session_id from operator_conversations where id=$1', [f.conversationId])).rows[0].native_session_id).toBe(f.record.nativeIdentity.nativeSessionId)
    await expect(pool.query("update operator_conversations set agent_key='workflow-native-files:v1:replacement' where id=$1", [humanId])).rejects.toThrow('original Main admission insertion')
    for (const replacement of ["native_session_id='replacement'", "provider_version='replacement'", "agent_key='replacement'", "record=jsonb_set(record,'{workingDirectory}','\"/replacement\"')", "record=jsonb_set(record,'{runtimeDirectory}','\"/replacement\"')", "record=jsonb_set(record,'{origin}','{}')", "record=jsonb_set(record,'{workflowFileContext}','{}')"]) {
      await expect(pool.query(`update operator_conversations set ${replacement} where id=$1`, [f.conversationId])).rejects.toThrow('identity is immutable')
    }
    await expect(pool.query('delete from operator_conversations where id=$1', [f.conversationId])).rejects.toThrow('must be retained')
    await pool.query('update operator_conversations set deleted_at=now() where id=$1', [f.conversationId])
    expect((await pool.query('select deleted_at from operator_conversations where id=$1', [f.conversationId])).rows[0].deleted_at).not.toBeNull()
    expect((await findRunChatConversation(pool, f.chatContext, f.record.producer.executionId))?.id).toBe(humanId)
  })

})
