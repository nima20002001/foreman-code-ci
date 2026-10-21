import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { deriveDispatch, freezePlacement } from '../src/modules/placement/binding.js'
import { createExecutionAuthorityExtension } from '../src/modules/placement/executionAuthority.js'
import { MainWorkerMcpRelay } from '../src/modules/placement/workerMcpRelay.js'
import type { AgentPlacementProducer } from '../src/modules/placement/agentProducer.js'
import type { DeviceExtensionRegistration } from '../src/modules/devices/deviceApplicationChannel.js'
import { deviceApplicationFailure } from '../src/modules/devices/deviceApplicationError.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

// Placement, device registration and Operator authority are other domains; this file holds real
// PostgreSQL row locks on the Run's own rows, exactly where a busy Run owner holds them.
const ports = vi.hoisted(() => ({ placement: vi.fn(), host: vi.fn(), principal: vi.fn(), owner: vi.fn() }))
vi.mock('../src/modules/placement/persistence.js', () => ({ readExecutionPlacement: ports.placement,
  readAcceptedPlacement: ports.placement, readNativePlacement: vi.fn(async () => ({})) }))
vi.mock('../src/modules/devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: ports.host }))
vi.mock('../src/modules/access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: ports.principal }))
vi.mock('../src/modules/access/runAuthority.js', () => ({ currentOperatorAuthority: ports.owner }))

const digest = 'a'.repeat(64)
const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID()
const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: 'run', nodeId: 'node',
  hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
  destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
    directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
    attestationId: 'attestation', attestationHash: digest },
  source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
  payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
    driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
    installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
const intent = deriveDispatch(placement, { executionId: 'execution', operationId: randomUUID(), attemptId: 'attempt',
  technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${digest}`,
  owner: { grantId: 'grant', epoch: '1' } })
const connection: DeviceConnectionIdentity = { mainId, deviceId, workerInstallationId, keyRevision: 1,
  authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1 }
const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
const worker: ManagementPrincipal = { id: 'worker-principal', name: 'Workflow worker', audience: 'worker', agentId: 'agent',
  grants: [{ actions: ['interactions:read'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }],
  expiresAt, revokedAt: null }
const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', expiresAt, revokedAt: null,
  grants: [{ actions: ['runs:start'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } }] }
const applicationAccess = { kind: 'scoped-worker-mcp' as const, token: 'original-worker-bearer', executionId: intent.executionId,
  agentId: 'agent', operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash }

describe.skipIf(!postgresEnabled)('Worker device requests while the Run is busy', () => {
  const schema = `busy_run_${randomUUID().replaceAll('-', '')}`
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool
  let authority: DeviceExtensionRegistration
  let relay: MainWorkerMcpRelay

  beforeAll(async () => {
    database = await agent3Database()
    await createFixtureSchema(database.pool, schema)
    const tables = [
      'runs(id text primary key,workspace_id text,workflow_id text,execution_state text,stop_requested_at timestamptz,record jsonb)',
      'harness_executions(id text primary key,run_id text,record jsonb)',
      'run_cleanup_intents(run_id text,pending boolean)',
      `execution_dispatch_intents(operation_id text primary key,run_id text,execution_id text,node_id text,
        binding_hash text,attempt_id text,record jsonb)`,
      'run_node_placements(run_id text,node_id text,record jsonb)',
      'remote_execution_owner_reconciliations(operation_id text,ordinal integer,transition jsonb)',
      'execution_dispatch_owner_grants(execution_id text,operation_id text,grant_id text,epoch text,revoked boolean)',
      'remote_dispatch_origins(operation_id text primary key,connection jsonb)',
      'remote_execution_receipts(operation_id text primary key,receipt jsonb)',
      'workflow_native_entries(execution_id text,run_id text,phase text)',
      `worker_credential_bindings(principal_id text,execution_id text,run_id text,workspace_id text,workflow_id text,
        agent_id text,purpose text,revoked_at timestamptz)`,
    ]
    for (const table of tables) await database.pool.query(`create table ${schema}.${table}`)
    const insert = (sql: string, values: unknown[]) => database.pool.query(`insert into ${schema}.${sql}`, values)
    await insert(`runs values('run','workspace','workflow','running',null,$1::jsonb)`, [JSON.stringify({ authorizationPrincipalId: owner.id })])
    await insert(`harness_executions values($1,'run',$2::jsonb)`, [intent.executionId, JSON.stringify({ state: 'running' })])
    await insert('execution_dispatch_intents values($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [intent.operationId, intent.runId, intent.executionId, intent.nodeId, intent.bindingHash,
        intent.attemptId, JSON.stringify(intent)])
    await insert('run_node_placements values($1,$2,$3::jsonb)', [intent.runId, intent.nodeId, JSON.stringify(placement)])
    await insert('execution_dispatch_owner_grants values($1,$2,$3,$4,false)',
      [intent.executionId, intent.operationId, intent.owner.grantId, intent.owner.epoch])
    await insert('remote_dispatch_origins values($1,$2::jsonb)', [intent.operationId, JSON.stringify(connection)])
    await insert(`workflow_native_entries values($1,'run','entered')`, [intent.executionId])
    await insert(`worker_credential_bindings values($1,$2,'run','workspace','workflow','agent','workflow',null)`,
      [worker.id, intent.executionId])
    // Production keeps statements short; a request that queues behind the Run fails within this deadline.
    pool = new pg.Pool({ ...database.pool.options, options: `-c search_path=${schema},public -c statement_timeout=1000` })
    ports.placement.mockResolvedValue(placement)
    ports.host.mockResolvedValue({ keyRevision: 1, authorizationRevision: 1 })
    ports.principal.mockResolvedValue(owner)
    ports.owner.mockResolvedValue({ principal: owner, owner })
    const producer = { assertPinsCurrent: vi.fn(async () => {}) } as unknown as AgentPlacementProducer
    authority = createExecutionAuthorityExtension(pool, { revalidateRunAuthorization: async () => {} }, producer)
    relay = new MainWorkerMcpRelay(mainId, pool, { authenticate: async () => worker },
      { request: async () => { throw new Error('authorization requests are not forwarded') } })
  })
  afterAll(async () => {
    await pool?.end()
    if (database) {
      try { await dropFixtureSchema(database.pool, schema) }
      finally { await database.close() }
    }
  })

  /** A Run owner transaction that has locked the Run's rows and is busy elsewhere. */
  async function whileRunBusy<T>(statements: string[], work: () => Promise<T>): Promise<T> {
    // The holder only takes row locks, so committing on release changes no data.
    return withTransaction(pool, async holder => {
      for (const statement of statements) await holder.query(statement, statement.includes('$1') ? [intent.operationId] : [])
      return work()
    })
  }
  const runRowsLocked = [
    "select id from runs where id='run' for update",
    `select id from harness_executions where run_id='run' for update`,
    'select operation_id from execution_dispatch_intents where operation_id=$1 for update',
    "select run_id from run_node_placements where run_id='run' for update",
    'select operation_id from execution_dispatch_owner_grants where operation_id=$1 for update',
    'select operation_id from remote_dispatch_origins where operation_id=$1 for update',
    "select run_id from workflow_native_entries where run_id='run' for update",
    "select run_id from worker_credential_bindings where run_id='run' for update",
  ]
  const start = { version: 1, intent, placement, action: 'start' }
  const context = () => ({ binding: connection, signal: new AbortController().signal,
    connectionSignal: new AbortController().signal }) as unknown as Parameters<NonNullable<DeviceExtensionRegistration['handle']>>[1]

  it('admits the original execution start while a Run writer holds its rows', async () => {
    const result = await whileRunBusy(runRowsLocked, () => authority.handle!(start, context()))
    expect(result.payload).toEqual({ version: 1, action: 'start', operationId: intent.operationId,
      attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner })
  })

  it('authorizes the original Worker MCP lease while a Run writer holds its rows', async () => {
    const lease = await whileRunBusy(runRowsLocked, () => relay.handle({ version: 1, operation: 'worker-mcp.authorize',
      intent, placement, applicationAccess }, connection))
    expect(lease).toMatchObject({ principalId: worker.id, executionId: intent.executionId, operationId: intent.operationId })
  })

  it('reports a database deadline as a retryable device failure', async () => {
    const blocked = ['lock table execution_dispatch_intents in access exclusive mode']
    const authorityFailure = await whileRunBusy(blocked, () => authority.handle!(start, context()).then(() => undefined, error => error))
    const relayFailure = await whileRunBusy(blocked, () => relay.handle({ version: 1, operation: 'worker-mcp.authorize',
      intent, placement, applicationAccess }, connection).then(() => undefined, error => error))
    expect(deviceApplicationFailure(authorityFailure)).toEqual({
      code: 'DATABASE_READ_TIMEOUT', retryable: true, class: 'transient',
    })
    expect(deviceApplicationFailure(relayFailure)).toEqual({
      code: 'DATABASE_READ_TIMEOUT', retryable: true, class: 'transient',
    })
  })
})
