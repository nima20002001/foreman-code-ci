import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, canonicalGraphJson, WorkActivationInputSchema,
  type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import type { RemoteWorkflowPhysicalReadout } from '@foreman-code/contracts/remote-workflow-physical'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { PostgresWorkflowPhysicalArtifacts } from '../src/modules/runs/remote/workflowPhysicalArtifacts.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { beforeGraphCommit, ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import type { AcceptedArtifactPublication } from '../src/modules/files/distributed/publication.js'
import { repeatDigest, repeatExecutionIdentity, repeatId, workActivationSlotId } from '../src/modules/runs/repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../src/modules/runs/workflowNativeProof.js'
import { NativeArtifactOutputSchema } from '../src/modules/runs/remote/nativeArtifactOutputs.js'
import { PostgresNativeArtifactOutputRepository } from '../src/modules/runs/remote/nativeArtifactOutputPostgres.js'
import { createWorkflowArtifactOutputsGate } from '../src/modules/runs/remote/workflowArtifactAcceptance.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { FileQuery } from '../src/modules/files/repository.js'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { completeResultRepair } from '../src/modules/runs/remote/workflowRepair.test-support.js'
const text = (value: unknown) => canonicalGraphJson(value, 4 * 1024 * 1024)
// Explicit SQL-boundary facts only. No host qualification, provider process,
// native byte production or physical publication is established by this fixture.
function facts(handoff = false) {

  const principalId = 'sql-owner-'+randomUUID(), nativeSessionId = 'sql-native-'+randomUUID()
  const f = makeCurrentWorkflowFixture('artifact-acceptance-'+randomUUID(), 'single'), node = f.version.definition.nodes[0]!
  node.artifactOutputs = { version: 1, outputKeys: ['z', 'a'] }
  const run = { ...f.run, authorizationPrincipalId: principalId } as AcceptedWorkflowRunV3
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), digest = 'a'.repeat(64)
  const execution: HarnessExecution = { id: randomUUID(), runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId]!, attempt: 1, state: 'completed',
    nativeSessionId: nativeSessionId, input: { executionSemanticsVersion: 3, runInput: run.input, occurrence: null, entry: null, predecessors: [] }, createdAt: f.createdAt, finishedAt: f.createdAt,
    result: { outcome: 'succeeded', output: { text: JSON.stringify({ data: null, artifactOutputs: { version: 1,
      outputs: ['z', 'a'].map(outputKey => ({ outputKey, commandId: `original-command-${outputKey}` })) } }) } } }
  if (handoff) {
    f.version.definition.handoffs = { contractVersion: 1 }
    execution.input = HarnessExecutionSchema.parse({ ...execution, input: WorkActivationInputSchema.parse({
      ...execution.input as object,
      work: { kind: 'entry', activation: { scope: f.scope, activationId: repeatId('work-entry', run.id),
        workflowNodeId: node.id, lineageId: run.id, cause: { kind: 'entry' } } },
    }) }).input
    const envelope = JSON.parse((execution.result!.output as { text: string }).text)
    execution.result = { outcome: 'succeeded', output: { text: JSON.stringify({ ...envelope,
      routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
    }) } }
  }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: run.id, nodeId: node.id,
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest,
      rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
    source: { kind: 'pending', approvedSourceId: randomUUID(), snapshotId: randomUUID(), rootId: randomUUID(), bindingRevision: 1,
      revisionId: 'source', manifestDigest: digest, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: node.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
      artifactOutputs: node.artifactOutputs, driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: execution.id, attemptId: randomUUID(), operationId: randomUUID(),
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, inputDigest: repeatDigest(execution.input), owner: { grantId: 'grant', epoch: '1' } })
  const transferContext = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const context: FileToolContext = { ownerPrincipalId: principalId, scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: randomUUID(),
    workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, executionId: execution.id, agentId: node.agentId } },
    nativeSessionId: nativeSessionId, turnId: 'original-turn', allowMutation: true, allowedTools: ['files.list', 'files.publish_result'] }
  const producer = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, nodeId: node.id,
    executionId: execution.id, attemptId: intent.attemptId, placementHash: intent.bindingHash }
  const accepted: AcceptedArtifactPublication = { attempt: producer, context, transferContext }
  const records = ['z', 'a'].map((outputKey, index) => {
    const sha256 = (index ? 'b' : 'c').repeat(64), transferId = randomUUID()
    return NativeArtifactOutputSchema.parse({ version: 1, producer, outputKey, commandId: `original-command-${outputKey}`,
      nativeIdentity: { nativeSessionId: context.nativeSessionId, turnId: context.turnId }, scope: context.scope,
      publication: { ownerPrincipalId: principalId, requestId: `fil05:remote:${createHash('sha256').update(`original-command-${outputKey}`).digest('hex')}`, binding: bindingIdentity(context) },
      pins: { fileId: randomUUID(), revisionId: randomUUID(), sha256, byteSize: 12 },
      transferReceipt: { version: 1, receiptId: randomUUID(), transferId, sha256, byteSize: 12, verifiedAt: f.createdAt,
        intent: { version: 1, ...transferContext, transferId, operationId: intent.operationId, executionId: execution.id, attemptId: intent.attemptId,
          placementHash: intent.bindingHash, rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact',
          sha256, byteSize: 12, manifestDigest: workflowArtifactTransferManifestDigest({ commandId: `original-command-${outputKey}`, sha256, byteSize: 12 }), chunkBytes: 1024, expiresAt: '2099-01-01T00:00:00.000Z' } } })
  })
  const proof: WorkflowNativeProofRecord = { proofId: randomUUID(), scope: f.scope, ref: { nodeId: node.id, occurrence: null },
    execution: repeatExecutionIdentity(execution), inputDigest: repeatDigest(execution.input), commandId: `execution:${execution.id}`,
    session: { harness: 'codex', providerVersion: 'unit-no-provider', nativeSessionId: nativeSessionId },
    original: { type: 'history', history: { correlationId: `execution:${execution.id}`, nativeTurnId: 'original-turn',
      events: [{ sequence: 1, type: 'turn.completed', occurredAt: f.createdAt, payload: { threadId: nativeSessionId, turnId: 'original-turn', status: 'completed' } }],
      pendingInteractions: [], terminalTurn: { correlationId: `execution:${execution.id}`, providerId: 'original-turn', result: execution.result! } } },
    observedAt: f.createdAt, ownerId: 'unit-owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1',
    lane: { id: 'unit-lane', token: 'unit-token', connectionGeneration: 1, providerId: 'original-turn' } }
  const remote = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
    connection: { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: transferContext.bootId, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 3, phase: 'confirmed_terminal', native: { sessionId: nativeSessionId, turnId: 'original-turn', processIdentityDigest: digest },
    entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [],
    terminal: { kind: 'completed', closureEvidenceDigest: digest, result: execution.result, artifactDigests: ['b'.repeat(64), 'c'.repeat(64)] } })
  return { f, run, node, mainId, principalId, execution, placement, intent, context, accepted, records, proof, remote }
}
const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `artifact_gate_${randomUUID().replaceAll('-', '')}`
describe.skipIf(!databaseUrl)('durable artifact completeness gate on real PostgreSQL facts', () => {
  let admin: pg.Pool, pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/test/.test(url.pathname)) throw new Error('Owned loopback test database required')
    admin = new pg.Pool({ connectionString: databaseUrl })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    await pool.query('create table fixture_gate_commits(execution_id text primary key, visits integer not null)')
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await dropFixtureSchema(admin, schema) } finally { await admin.end() } }
  })
  async function seed(bindKeys = ['z', 'a'], handoff = false, repairCount = 0) {
    const x = facts(handoff), { run, node, execution, placement, intent, proof, context } = x
    for (let attempt = 1; attempt <= repairCount; attempt++) {
      const correlationId = completeResultRepair(x.remote, `corrective-${attempt}`)
      if (proof.original.type !== 'history') throw new Error('Expected terminal history')
      const turnId = x.remote.native!.turnId!
      proof.original.history.correlationId = correlationId
      proof.original.history.nativeTurnId = turnId
      proof.original.history.terminalTurn = { ...proof.original.history.terminalTurn!, correlationId, providerId: turnId }
      proof.original.history.events[0]!.payload = { threadId: execution.nativeSessionId, turnId, status: 'completed', clientCorrelationId: correlationId }
      proof.lane!.providerId = turnId
    }
    const client = await pool.connect()
    try {
      // Actual owner lock/backend fence required by dispatch admission triggers.
      // This is SQL fixture admission, not a device/native launch grant.
      await client.query('select pg_advisory_lock(810002,hashtext($1))', [run.id])
      await beginTransaction(client)
      const owner = (await client.query<{ owner_id: string; fence: string }>(`select pg_backend_pid()::text as owner_id,
        (extract(epoch from backend_start)*1000000)::bigint::text as fence from pg_stat_activity where pid=pg_backend_pid()`)).rows[0]!
      await client.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
        values($1,'SQL boundary owner','operator',$2,$3::jsonb,clock_timestamp()+interval '1 hour')`,
      [x.principalId, createHash('sha256').update(randomUUID()).digest('hex'), text([{ actions: ['agent_chat:write'], scope: { workspaceIds: [run.workspaceId] } }])])
      await client.query("insert into workspaces(id,record) values($1,'{}')", [run.workspaceId])
      await client.query("insert into workflows(id,workspace_id,record) values($1,$2,'{}')", [run.workflowId, run.workspaceId])
      for (const config of x.f.configurations) {
        await client.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [config.agentId, run.workspaceId, text({ id: config.agentId })])
        await client.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)', [config.id, run.workspaceId, config.agentId, text(config)])
      }
      await client.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
        values($1,$2,$3,1,$4,3,$5::jsonb)`, [x.f.version.id, run.workspaceId, run.workflowId, node.id, text(x.f.version)])
      await client.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
        values($1,$2,$3,$4,'queued',$5::jsonb)`, [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, text({ ...run, executionState: 'queued' })])
      await client.query('insert into run_node_placements(run_id,node_id,binding_hash,record) values($1,$2,$3,$4::jsonb)', [run.id, node.id, placement.bindingHash, text(placement)])
      const activation = handoff ? WorkActivationInputSchema.parse(execution.input).work.activation : undefined
      if (activation) await client.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,
        workflow_node_id,cause_kind,cause_id,state,record) values($1,$2,$3,$4,'entry',$2,'queued',$5::jsonb)`,
      [activation.activationId, run.id, x.f.version.id, node.id, text(activation)])
      const slotId = activation ? workActivationSlotId(run.id, activation.activationId) : randomUUID()
      await client.query(`insert into run_repeat_slots(slot_id,run_id,workflow_node_id,input_json,input_digest,
        work_activation_id) values($1,$2,$3,$4,$5,$6)`,
      [slotId, run.id, node.id, text(execution.input), repeatDigest(execution.input), activation?.activationId ?? null])
      await client.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record,
        work_activation_id) values($1,$2,$3,$4,1,$5::jsonb,$6)`,
      [execution.id, run.id, node.id, execution.agentId, text(execution), activation?.activationId ?? null])
      await client.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,technical_attempt,identity,
        work_activation_id) values($1,$2,$3,1,$4::jsonb,$5)`,
      [execution.id, run.id, slotId, text(repeatExecutionIdentity(execution)), activation?.activationId ?? null])
      await client.query(`insert into execution_dispatch_intents(operation_id,execution_id,run_id,node_id,binding_hash,attempt_id,record,scheduler_owner_id,scheduler_owner_fence)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [intent.operationId, execution.id, run.id, node.id, intent.bindingHash, intent.attemptId, text(intent), owner.owner_id, owner.fence])
      for (const [index, repair] of (x.remote.resultRepairs ?? []).entries()) {
        await client.query('insert into execution_work_result_repairs(execution_id,attempt,rejected_provider_id) values($1,$2,$3)',
          [execution.id, index + 1, repair.previousTurnId])
      }
      await client.query('insert into remote_execution_receipts(operation_id,sequence,receipt) values($1,$2,$3::jsonb)', [intent.operationId, x.remote.sequence, text(x.remote)])
      await client.query("insert into run_graph_heads(run_id,protocol_version,head_sequence,history_coverage) values($1,1,1,'from_admission')", [run.id])
      await client.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'native_event',$2,1,$3,$3,1)`, [run.id, proof.proofId, repeatDigest(proof, 4 * 1024 * 1024)])
      await client.query(`insert into workflow_native_proofs(proof_id,run_id,execution_id,identity_digest,source_digest,record,record_json)
        values($1,$2,$3,$4,$5,$6::text::jsonb,$6::text)`, [proof.proofId, run.id, execution.id, repeatDigest(proof.execution), repeatDigest(proof, 4 * 1024 * 1024), text(proof)])
      const chat = context.scope.chat
      if (chat.kind !== 'agent') throw new Error('Agent fixture required')
      await client.query(`insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,agent_configuration_version_id,harness,provider_version,native_session_id,origin_run_id,origin_execution_id,record)
        values($1,'agent',$1,$2,$3,$4,$5,$6,'codex','SQL-boundary-provider',$7,$8,$9,'{}')`, [chat.conversationId, run.workspaceId, run.workflowId, node.id, node.agentId, execution.agentConfigurationVersionId, context.nativeSessionId, run.id, execution.id])
      for (const record of x.records) {
        const pins = record.pins
        await client.query(`insert into files(file_id,owner_principal_id,current_revision_id,scope_kind,chat_kind,conversation_id,agent_id,workspace_id,workflow_id,run_id,execution_id,state,created_at,retention_duration_seconds,expires_at)
          values($1,$2,$3,'temporary','agent',$4,$5,$6,$7,$8,$9,'ready',now(),3600,now()+interval '1 hour')`, [pins.fileId, x.principalId, pins.revisionId, chat.conversationId, node.agentId, run.workspaceId, run.workflowId, run.id, execution.id])
        await client.query(`insert into file_revisions(revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key)
          values($1,$2,'fixture.md','text/markdown',$3,$4,'agent_output',now(),$5)`, [pins.revisionId, pins.fileId, pins.byteSize, pins.sha256, randomUUID()])
        await client.query(`insert into file_allocations(allocation_id,owner_principal_id,request_id,input_hash,file_id,revision_id,state,created_at)
          values($1,$2,$3,$4,$5,$6,'finalized',now())`, [randomUUID(), x.principalId, record.publication.requestId, 'a'.repeat(64), pins.fileId, pins.revisionId])
        const link = { ...record.publication, context, publicationInputHash: 'a'.repeat(64), ref: { fileId: pins.fileId, revisionId: pins.revisionId }, transferReceipt: record.transferReceipt, createdAt: new Date().toISOString() }
        await client.query('insert into file_tool_publications(owner_principal_id,request_id,binding,file_id,revision_id,record) values($1,$2,$3,$4,$5,$6::jsonb)', [x.principalId, record.publication.requestId, record.publication.binding, pins.fileId, pins.revisionId, text(link)])
        const declaration = { commandId: record.commandId, sha256: pins.sha256, byteSize: pins.byteSize }
        const admitted = { workerPrincipalId: x.principalId, accepted: x.accepted, declaration, intent: record.transferReceipt.intent }
        await client.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
          values($1,'remote.artifact-transfer.admit',$2,$3,$4,$5::jsonb)`, [x.principalId, record.commandId,
          `workflow-artifact:${x.principalId}`, commandInputHash(declaration), text(admitted)])
      }
      await commitTransaction(client)
    } catch (error) { await rollbackTransaction(client); throw error }
    finally { await client.query('select pg_advisory_unlock(810002,hashtext($1))', [run.id]); client.release() }
    const authorize = async (sql: FileQuery, nativeContext = context) => {
      const principal = await readLiveManagementPrincipal(sql, x.principalId)
      requireAuthorization(principal, 'agent_chat:write', { workspaceId: run.workspaceId })
      return { principal, context: nativeContext, binding: bindingIdentity(nativeContext) }
    }
    const repository = new PostgresNativeArtifactOutputRepository(pool, x.mainId)
    for (const record of x.records) if (bindKeys.includes(record.outputKey)) await repository.bind(record, async sql => { await authorize(sql) })
    // Native source/current placement authority is a boundary double. Current
    // principal grants, canonical SQL receipt/metadata and mappings are real.
    const currentContext = { ...context, turnId: x.remote.native!.turnId! }
    const authority = {
      resolveWorkflowContext: async () => ({ ...x.accepted, context: currentContext }),
      authorize: async (accepted: AcceptedArtifactPublication, sql?: FileQuery) => {
        if (!sql) throw new Error('Same SQL required')
        return authorize(sql, accepted.context)
      },
      authorizePublication: async (accepted: AcceptedArtifactPublication, sql?: FileQuery) => {
        if (!sql) throw new Error('Same SQL required')
        return authorize(sql, accepted.context)
      },
      resolvePublicationContext: async (accepted: AcceptedArtifactPublication, commandId: string, sql?: FileQuery) => {
        if (!sql) throw new Error('Same SQL required')
        const row = (await sql.query<{ record: { context: FileToolContext } }>(
          'select record from file_tool_publications where owner_principal_id=$1 and request_id=$2',
          [x.principalId, `fil05:remote:${createHash('sha256').update(commandId).digest('hex')}`])).rows[0]
        if (!row) throw new Error('Missing fixture publication')
        return { ...accepted, context: row.record.context }
      },
      assertSourceLive: async (_accepted: AcceptedArtifactPublication, _receipt: unknown, sql: FileQuery) => { await authorize(sql) },
    }
    const gate = createWorkflowArtifactOutputsGate(x.mainId, authority)
    const check = async (after: (sql: FileQuery) => Promise<void> = async () => {}) => {
      const current = await pool.connect(), connection = new ExclusiveGraphConnection(current, () => {})
      try { await connection.transaction(async sql => {
        await gate(sql, run, x.f.version, execution)
        await sql.query('insert into fixture_gate_commits(execution_id,visits) values($1,1) on conflict(execution_id) do update set visits=fixture_gate_commits.visits+1', [execution.id])
        await after(sql)
      }) } finally { await connection.close(); current.release(connection.unusable) }
    }
    const visits = async () => (await pool.query<{ visits: number }>('select visits from fixture_gate_commits where execution_id=$1', [execution.id])).rows[0]?.visits ?? 0
    // Only the metadata-facing fields of the physical readout are supplied.
    // This is a SQL companion boundary double, never a qualified physical DTO.
    const readout = { receipt: x.remote, output: { kind: 'published-artifacts', result: execution.result,
      artifactOutputs: JSON.parse((execution.result!.output as { text: string }).text).artifactOutputs } } as RemoteWorkflowPhysicalReadout
    const binding: DeviceSessionBinding = { ...x.accepted.transferContext, connectionGeneration: 1 }
    const metadata = new PostgresWorkflowPhysicalArtifacts(x.mainId, { files: new PostgresFileRepository(pool), authority })
    const checkMetadata = async (adopted: boolean, after: (sql: FileQuery) => Promise<void> = async () => {}) => {
      const current = await pool.connect(), connection = new ExclusiveGraphConnection(current, () => {})
      try { await connection.transaction(async sql => {
        const verify = () => adopted ? metadata.assertAdopted(sql, readout, binding) : metadata.assertPublications(sql, readout, binding)
        await verify(); beforeGraphCommit(sql, verify)
        await sql.query('insert into fixture_gate_commits(execution_id,visits) values($1,1) on conflict(execution_id) do update set visits=fixture_gate_commits.visits+1', [execution.id])
        await after(sql)
      }) } finally { await connection.close(); current.release(connection.unusable) }
    }
    return { ...x, check, checkMetadata, visits, repository }
  }
  it.each([1, 2])('preserves earlier publications when accepting a handoff after %s corrections', async count => {
    const x = await seed(['z', 'a'], true, count)
    const original = structuredClone(x.records)
    await x.check()
    await x.checkMetadata(true)
    expect(await x.visits()).toBe(2)
    for (const record of original) {
      expect(await x.repository.read(record.producer, record.outputKey)).toEqual(record)
      expect(record.nativeIdentity.turnId).toBe('original-turn')
    }
    const remote = (await pool.query<{ receipt: typeof x.remote }>(
      'select receipt from remote_execution_receipts where operation_id=$1', [x.intent.operationId])).rows[0]!.receipt
    expect(remote.native!.turnId).toBe(`corrective-${count}`)
    expect(remote.resultRepairs).toHaveLength(count)
  })
  it('accepts and rechecks combined handoff artifacts through fresh SQL connections', async () => {
    const x = await seed(['z', 'a'], true)
    await x.check()
    const original = structuredClone(x.execution.result)
    // Each call opens a fresh transaction/connection after the accepted marker commits.
    await x.checkMetadata(true)
    await x.check()
    expect(await x.visits()).toBe(3)
    expect(x.execution.result).toEqual(original)
    for (const record of x.records) expect(await x.repository.read(record.producer, record.outputKey)).toEqual(record)
  })
  it('refuses unpublished required artifacts in a combined handoff result before acceptance', async () => {
    const x = await seed(['z'], true)
    await expect(x.check()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_PENDING' })
    expect(await x.visits()).toBe(0)
  })
  it('allows original canonical publications before adoption and requires complete immutable maps afterward', async () => {
    const x = await seed([]); await x.checkMetadata(false); expect(await x.visits()).toBe(1)
    await expect(x.checkMetadata(true)).rejects.toMatchObject({ code: 'REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE' })
    for (const record of x.records) await x.repository.bind(record, async sql => {
      requireAuthorization(await readLiveManagementPrincipal(sql, x.principalId), 'agent_chat:write', { workspaceId: x.run.workspaceId })
    })
    await x.checkMetadata(true); await x.checkMetadata(true); expect(await x.visits()).toBe(3)
  })
  it.each(['authority', 'retention'] as const)('resamples adopted SQL metadata and %s in a COMMIT finalizer', async reason => {
    const x = await seed()
    await expect(x.checkMetadata(true, async sql => {
      if (reason === 'authority') await sql.query('update management_principals set revoked_at=now() where id=$1', [x.principalId])
      else await sql.query("update files set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where file_id=$1", [x.records[0]!.pins.fileId])
    })).rejects.toMatchObject({ code: reason === 'authority' ? 'AUTH_REVOKED' : 'REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE' })
    expect(await x.visits()).toBe(0); await x.checkMetadata(true)
  })
  it('commits the complete original mapping, rereads on replay and rejects current grant revocation', async () => {
    const x = await seed(); await x.check(); await x.check(); expect(await x.visits()).toBe(2)
    await pool.query('update management_principals set revoked_at=now() where id=$1', [x.principalId])
    await expect(x.check()).rejects.toMatchObject({ code: 'AUTH_REVOKED' }); expect(await x.visits()).toBe(2)
    for (const record of x.records) expect(await x.repository.read(record.producer, record.outputKey)).toEqual(record)
  })
  it('rejects an incomplete output set without committing an acceptance marker', async () => {
    const x = await seed(['z'])
    await expect(x.check()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_PENDING' }); expect(await x.visits()).toBe(0)
  })
  it.each(['authority', 'retention'] as const)('rolls back success and the awaited %s mutation at the COMMIT fence', async reason => {
    const x = await seed()
    await expect(x.check(async sql => {
      if (reason === 'authority') await sql.query('update management_principals set revoked_at=now() where id=$1', [x.principalId])
      else await sql.query("update files set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where file_id=$1", [x.records[0]!.pins.fileId])
    })).rejects.toMatchObject({ code: reason === 'authority' ? 'AUTH_REVOKED' : 'FILE_BYTES_UNAVAILABLE' })
    expect(await x.visits()).toBe(0); await x.check(); expect(await x.visits()).toBe(1)
  })
  it('rejects a changed terminal digest order rather than accepting the same unordered hash set', async () => {
    const x = await seed()
    const changed = { ...x.remote, terminal: { ...x.remote.terminal!, artifactDigests: [...(x.remote.terminal!.artifactDigests ?? [])].reverse() } }
    await pool.query('update remote_execution_receipts set receipt=$2::jsonb where operation_id=$1', [x.intent.operationId, text(changed)])
    await expect(x.check()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' }); expect(await x.visits()).toBe(0)
  })
  it.each(['invalid_result', 'missing_publication'] as const)(
    'retains a terminal %s failure and rejects acceptance through fresh connections', async reason => {
      const x = await seed()
      const original = structuredClone(x.execution.result)
      const failed = { ...x.remote, terminal: { ...x.remote.terminal!, artifactDigests: [],
        artifactValidationError: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', reason } } }
      await pool.query('update remote_execution_receipts set receipt=$2::jsonb where operation_id=$1',
        [x.intent.operationId, text(failed)])
      await expect(x.check()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' })
      await expect(x.check()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' })
      expect(await x.visits()).toBe(0)
      const retained = (await pool.query<{ receipt: typeof failed }>(
        'select receipt from remote_execution_receipts where operation_id=$1', [x.intent.operationId])).rows[0]!.receipt
      expect(retained.terminal.result).toEqual(original)
      expect(retained.terminal.artifactValidationError).toEqual(failed.terminal.artifactValidationError)
      expect((await pool.query<{ record: HarnessExecution }>('select record from harness_executions where id=$1',
        [x.execution.id])).rows[0]!.record.result).toEqual(original)
    })
})
