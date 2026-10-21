import { readUntil } from './helpers/observableCondition.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { AgentSourceAttemptAuthority } from '../src/modules/sources/agentSourceAuthority.js'
import { readReconciledDispatchIntent } from '../src/modules/runs/remote/persistence.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('remote dispatch and worker credential lock ordering', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const schema = `dispatch_locks_${randomUUID().replaceAll('-', '')}`
  const intent = DispatchIntentSchema.parse({
    schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(), runId: 'run', nodeId: 'node',
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: randomUUID(), operationId: randomUUID(), bindingHash: 'a'.repeat(64),
    inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: randomUUID(), epoch: '1' },
  })

  beforeAll(async () => {
    database = await agent3Database()
    await createFixtureSchema(database.pool, schema)
    await database.pool.query(`create table ${schema}.runs(id text primary key)`)
    await database.pool.query(`create table ${schema}.execution_dispatch_intents(operation_id text primary key,
      run_id text,record jsonb,execution_id text,node_id text,binding_hash text,attempt_id text)`)
    await database.pool.query(`create table ${schema}.harness_executions(id text primary key,run_id text,
      workflow_node_id text,agent_id text)`)
    await database.pool.query(`create table ${schema}.remote_execution_owner_reconciliations(operation_id text,ordinal integer,transition jsonb)`)
    await database.pool.query(`insert into ${schema}.runs values($1)`, [intent.runId])
    await database.pool.query(`insert into ${schema}.execution_dispatch_intents
      (operation_id,run_id,record,execution_id,node_id,binding_hash,attempt_id) values($1,$2,$3::jsonb,$4,$5,$6,$7)`,
      [intent.operationId, intent.runId, JSON.stringify(intent), intent.executionId, intent.nodeId,
        intent.bindingHash, intent.attemptId])
    await database.pool.query(`insert into ${schema}.harness_executions values($1,$2,$3,$4)`,
      ['unallocated-execution', intent.runId, intent.nodeId, 'agent'])
  })
  afterAll(async () => {
    if (!database) return
    try { await dropFixtureSchema(database.pool, schema) }
    finally { await database.close() }
  })

  it('lets credential authorization finish while physical readback waits for the same Run', async () => {
    const reader = await database.pool.connect()
    const credentials = await database.pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      for (const sql of [reader, credentials]) {
        await sql.query('begin')
        await sql.query(`set local search_path to ${schema}`)
        await sql.query("set local lock_timeout='2s'")
      }
      const readerPid = (await reader.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await credentials.query('select id from runs where id=$1 for update', [intent.runId])
      pending = (async () => {
        const value = await readReconciledDispatchIntent(reader, intent.operationId, true)
        await reader.query('select id from runs where id=$1 for share', [intent.runId])
        return value
      })()
      void pending.catch(() => undefined) // Joined below before either connection is released.
      const waiting = await readUntil(async () => {
        return (await database.pool.query<{ waiting: boolean }>(
          'select cardinality(pg_blocking_pids($1))>0 as waiting', [readerPid],
        )).rows[0]!.waiting
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      expect(waiting).toBe(true)
      expect(await readReconciledDispatchIntent(credentials, intent.operationId, true)).toEqual(intent)
      await credentials.query('commit')
      expect(await pending).toEqual(intent)
      await reader.query('commit')
    } finally {
      await credentials.query('rollback')
      await pending?.catch(() => undefined)
      await reader.query('rollback')
      reader.release()
      credentials.release()
    }
  })

  it('rejects missing source allocation without deadlocking the credential writer', async () => {
    const source = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) }
    const root = SourceRootRecordSchema.parse({
      version: 1, source,
      selection: { hostRef: { kind: 'main', mainId: intent.mainId }, rootPolicyId: 'policy',
        rootPolicyRevision: '1', locationRevision: '1' },
      binding: { version: 1, mainId: intent.mainId, deviceId: null, workerInstallationId: null,
        workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
        canonicalPath: '/private/materialized', filesystem: { device: '1', inode: '2', mountId: '3' },
        accessMode: 'exclusive-write', snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
      ownerPrincipalId: 'operator', authorizedByPrincipalId: 'operator', registration: null,
      attestationId: 'attestation', attestationDigest: 'd'.repeat(64), boundAt: new Date().toISOString(),
    })
    const authority = new AgentSourceAttemptAuthority(database.pool, async () => {
      throw new Error('A missing allocation cannot reach root authorization')
    })
    const reader = await database.pool.connect()
    const credentials = await database.pool.connect()
    let pending: Promise<void> | undefined
    try {
      for (const sql of [reader, credentials]) {
        await sql.query('begin')
        await sql.query(`set local search_path to ${schema}`)
        await sql.query("set local lock_timeout='2s'")
      }
      const readerPid = (await reader.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await credentials.query('select id from runs where id=$1 for update', [intent.runId])
      pending = authority.authorize(reader, { id: 'operator', name: 'Operator', audience: 'operator',
        grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }, {
        workspaceId: 'workspace', root, operationId: intent.operationId,
        attempt: { executionId: 'unallocated-execution', attemptId: intent.attemptId,
          placementHash: 'e'.repeat(64), keyRevision: null, authorizationRevision: null },
      })
      void pending.catch(() => undefined) // Joined before either transaction is released.
      const waiting = await readUntil(async () => {
        return (await database.pool.query<{ waiting: boolean }>(
          'select cardinality(pg_blocking_pids($1))>0 as waiting', [readerPid],
        )).rows[0]!.waiting
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      expect(waiting).toBe(true)
      await credentials.query('select id from harness_executions where id=$1 for update', ['unallocated-execution'])
      await credentials.query('commit')
      await expect(pending).rejects.toMatchObject({ code: 'AGENT_SOURCE_ALLOCATION_MISSING' })
    } finally {
      await credentials.query('rollback')
      await pending?.catch(() => undefined)
      await reader.query('rollback')
      reader.release()
      credentials.release()
    }
  })
})
