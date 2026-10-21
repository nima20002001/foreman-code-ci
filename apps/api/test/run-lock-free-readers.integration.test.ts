import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { sourceOperationSelectionHash } from '../src/modules/sources/operationDigests.js'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { deriveDispatch, freezePlacement } from '../src/modules/placement/binding.js'
import { AgentSourceAttemptAuthority } from '../src/modules/sources/agentSourceAuthority.js'
import { PostgresSourceOperationAuthority } from '../src/modules/sources/operationAuthority.js'
import { RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createTestPool } from './helpers/testPool.mjs'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

// Readers of committed Run facts must answer while the Run owner holds its row locks.
describe.skipIf(!postgresEnabled)('Run readers that do not queue behind the Run owner', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool
  const schema = `run_readers_${randomUUID().replaceAll('-', '')}`
  const mainId = randomUUID()
  const rootId = randomUUID()
  const source = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'main', mainId }, registration: null,
    destination: { canonicalProjectRoot: '/private/project', canonicalCwd: '/private/project', managedRuntimeRoot: '/private/runtime',
      directoryIdentityHash: 'a'.repeat(64), rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: 'a'.repeat(64) },
    source: { kind: 'pending', ...source, revisionId: 'revision', rootId, bindingRevision: 1,
      materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: randomUUID(), instanceRevision: '1', harnessInstallationId: 'installed-codex',
      installationFingerprint: 'a'.repeat(64), runtimeContractVersion: 1, protocolRevision: 'codex-native-adapter-v1',
      credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', attemptId: randomUUID(), operationId: randomUUID(),
    technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${'b'.repeat(64)}`,
    owner: { grantId: randomUUID(), epoch: '1' } })
  const worker: ManagementPrincipal = { id: 'worker-principal', name: 'Worker', audience: 'worker', agentId: 'agent',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const root = SourceRootRecordSchema.parse({
    version: 1, source,
    selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId: 'workspace',
      rootId, bindingRevision: 1, locationRevision: 1, canonicalPath: '/private/materialized',
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
      snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: 'operator', authorizedByPrincipalId: 'operator', registration: null,
    attestationId: 'attestation', attestationDigest: 'd'.repeat(64), boundAt: new Date().toISOString(),
  })
  const attempt = { executionId: intent.executionId, attemptId: intent.attemptId, placementHash: '',
    keyRevision: null, authorizationRevision: null }
  attempt.placementHash = sourceOperationSelectionHash(root, attempt, intent.operationId)

  const run = AcceptedWorkflowRunV3Schema.parse({ ...makeCurrentWorkflowFixture('source-reader', 'single').run,
    id: intent.runId, workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
    agentConfigurationVersionIds: { agent: 'configuration' }, authorizationPrincipalId: 'operator',
    executionLocation: { runnerId: 'runner-local', rootPath: '/private/project', locationRevision: 1,
      identityHash: `sha256:${'a'.repeat(64)}` } })

  beforeAll(async () => {
    database = await agent3Database()
    await createFixtureSchema(database.pool, schema)
    const tables = [
      'runs(id text primary key,workspace_id text,workflow_version_id text,record jsonb,stop_requested_at timestamptz)',
      `execution_dispatch_intents(operation_id text primary key,run_id text,record jsonb,execution_id text,node_id text,
        binding_hash text,attempt_id text)`,
      'harness_executions(id text primary key,run_id text,workflow_node_id text,agent_id text)',
      'remote_execution_owner_reconciliations(operation_id text,ordinal integer,transition jsonb)',
      `worker_credential_bindings(principal_id text,agent_id text,purpose text,revoked_at timestamptz,run_id text,
        workspace_id text,workflow_id text,execution_id text,environment_variable text,approval_connection_generation bigint,
        approval_review_lease_fence bigint,approval_review_job_id text,approval_native_session_id text)`,
      `management_principals(id text primary key,name text,audience text,agent_id text,grants jsonb,expires_at timestamptz,
        revoked_at timestamptz,delegated_from text)`,
      'execution_dispatch_owner_grants(execution_id text,operation_id text,grant_id text,epoch text,revoked boolean)',
      'job_preparations(execution_id text,attempt_id text,operation_id text,principal_id text)',
      'workflow_job_preparations(preparation jsonb)',
      'source_storage_reservations(owner_kind text,owner_id text,record jsonb,state text)',
      'source_preparation_reconciliations(operation_id text)',
      'run_cleanup_intents(run_id text,pending boolean)',
      'workflow_versions(id text primary key,execution_semantics_version integer)',
      'run_node_placements(run_id text,node_id text,record jsonb)',
    ]
    for (const table of tables) await database.pool.query(`create table ${schema}.${table}`)
    await database.pool.query(`insert into ${schema}.runs values($1,'workspace','version',$2::jsonb,null)`,
      [intent.runId, JSON.stringify(run)])
    // The execution exists but its dispatch owner grant was revoked: source admission must be denied, not left waiting.
    await database.pool.query(`insert into ${schema}.harness_executions values($1,$2,$3,'agent')`,
      [intent.executionId, intent.runId, intent.nodeId])
    await database.pool.query(`insert into ${schema}.execution_dispatch_intents values($1,$2,$3::jsonb,$4,$5,$6,$7)`,
      [intent.operationId, intent.runId, JSON.stringify(intent), intent.executionId, intent.nodeId, intent.bindingHash, intent.attemptId])
    await database.pool.query(`insert into ${schema}.worker_credential_bindings values($1,$2,'workflow',null,$3,'workspace','workflow',
      $4,'GRAPHQL_MCP_TOKEN',null,null,null,null)`, [worker.id, worker.agentId, intent.runId, intent.executionId])
    // The worker credential was revoked; its CI request must be denied, not left waiting.
    await database.pool.query(`insert into ${schema}.management_principals values($1,'Worker','worker',$2,'[]','2099-01-01',now(),null),
      ('operator','Operator','operator',null,'[]','2099-01-01',null,null)`, [worker.id, worker.agentId])
    await database.pool.query(`update ${schema}.management_principals set grants=$1::jsonb where id='operator'`,
      [JSON.stringify([{ actions: ['runs:start', 'sources:read', 'source_roots:read'],
        scope: { workspaceIds: ['workspace'] } }])])
    await database.pool.query(`insert into ${schema}.workflow_versions values('version',3)`)
    await database.pool.query(`insert into ${schema}.run_node_placements values($1,$2,$3::jsonb)`,
      [placement.runId, placement.nodeId, JSON.stringify(placement)])
    pool = createTestPool({ connectionString: database.databaseUrl, max: 4,
      options: `-c search_path=${schema} -c lock_timeout=500 -c statement_timeout=5000` })
  })
  afterAll(async () => {
    await pool?.end()
    if (!database) return
    try { await dropFixtureSchema(database.pool, schema) } finally { await database.close() }
  })

  /** The Run owner's transaction: the Run row and its dispatch intent stay locked until the check returns. */
  const whileRunOwnerHoldsLocks = (check: () => Promise<void>) => withTransaction(pool, async owner => {
    await owner.query('select id from runs where id=$1 for update', [intent.runId])
    await owner.query('select record from execution_dispatch_intents where operation_id=$1 for update', [intent.operationId])
    await check()
  })
  const whileTablesAreLocked = (check: () => Promise<void>) => withTransaction(pool, async owner => {
    await owner.query('lock table execution_dispatch_intents, worker_credential_bindings in access exclusive mode')
    await check()
  })

  it('answers an Agent source revalidation from committed facts while the Run owner holds the Run', async () => {
    const authority = new AgentSourceAttemptAuthority(pool, async () => {
      throw new Error('A missing allocation cannot reach root authorization')
    })
    await whileRunOwnerHoldsLocks(async () => {
      await expect(authority.revalidate(root, attempt)).rejects.toMatchObject({ code: 'AGENT_SOURCE_OWNER_REVOKED' })
    })
  })

  it('answers a source preparation identity check from committed facts while the Run owner holds the Run', async () => {
    const owners = new PostgresSourceOperationAuthority(pool, new AgentSourceAttemptAuthority(pool, async () => undefined),
      async () => false)
    await whileRunOwnerHoldsLocks(async () => {
      await expect(owners.prepareIdentity(root, attempt)).rejects.toMatchObject({ code: 'AGENT_SOURCE_OWNER_REVOKED' })
    })
  })

  it('revalidates an authorized source and prepares its identity while the Run remains locked', async () => {
    await pool.query('insert into execution_dispatch_owner_grants values($1,$2,$3,$4,false)',
      [intent.executionId, intent.operationId, intent.owner.grantId, intent.owner.epoch])
    try {
      const authority = new AgentSourceAttemptAuthority(pool, async () => undefined)
      const owners = new PostgresSourceOperationAuthority(pool, authority, async () => false)
      await whileRunOwnerHoldsLocks(async () => {
        await expect(authority.revalidate(root, attempt)).resolves.toBeUndefined()
        await expect(owners.prepareIdentity(root, attempt)).resolves.toEqual({
          operationId: intent.operationId, ownerPrincipalId: 'operator', expiresAt: '2099-01-01T00:00:00.000Z',
        })
      })
    } finally {
      await pool.query('delete from execution_dispatch_owner_grants where execution_id=$1', [intent.executionId])
    }
  })

  it('reports a still-blocked Agent source revalidation as a retryable read timeout', async () => {
    const authority = new AgentSourceAttemptAuthority(pool, async () => undefined)
    await whileTablesAreLocked(async () => {
      await expect(authority.revalidate(root, attempt)).rejects.toMatchObject({
        code: 'DATABASE_READ_TIMEOUT', details: { retryable: true } })
    })
  })

  it('resolves CI authority for an Agent while the Run owner holds the Run', async () => {
    const authority = new RunCiAuthority(pool)
    await whileRunOwnerHoldsLocks(async () => {
      await expect(authority.resolve(worker, undefined, ['ci'])).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    })
  })

  it('reports a still-blocked CI authority read as a retryable read timeout', async () => {
    const authority = new RunCiAuthority(pool)
    await whileTablesAreLocked(async () => {
      await expect(authority.resolve(worker, undefined, ['ci'])).rejects.toMatchObject({
        code: 'DATABASE_READ_TIMEOUT', details: { retryable: true } })
    })
  })
})
