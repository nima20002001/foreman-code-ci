import { readUntil } from './helpers/observableCondition.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { JobApplicationBridge } from '../src/modules/runs/remote/jobApplicationBridge.js'
import { jobExecution } from './helpers/jobFixture.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('Concurrent Job publication authorization', () => {
  it('authorizes overlapping publications without upgrading a shared execution lock', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error('An owned loopback test database is required')
    }
    const schema = `job_publication_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString: url.toString() })
    let pool: pg.Pool | undefined
    try {
      await admin.query(`create schema ${schema}`)
      pool = new pg.Pool({ connectionString: url.toString(), max: 12,
        application_name: schema,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=4000` })
      await pool.query(`
        create table job_executions(id text primary key,workspace_id text,record jsonb,accepted_spec jsonb,accepted_by text);
        create table job_dispatch_intents(execution_id text primary key,intent jsonb);
        create table management_principals(id text primary key,name text,audience text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text);
      `)
      const execution = jobExecution()
      execution.process = { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true }
      execution.finishedAt = execution.createdAt
      const binding = { kind: 'main' as const, mainId: execution.acceptedSpec.target.mainId,
        mainInstallationId: execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID() }
      const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1,
        mainId: binding.mainId, executionId: execution.id, operationId: execution.operationId,
        attemptId: execution.attemptId, owner: execution.owner, bindingHash: execution.acceptedSpec.bindingHash,
        inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, subject: { kind: 'manual-job',
          workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId } })
      await pool.query('insert into job_executions values($1,$2,$3,$4,$5)',
        [execution.id, execution.workspaceId, JSON.stringify(execution), JSON.stringify(execution.acceptedSpec), 'owner'])
      await pool.query('insert into job_dispatch_intents values($1,$2)', [execution.id, JSON.stringify(intent)])
      await pool.query("insert into management_principals values('owner','Owner','operator',$1,'2099-01-01',null,null)",
        [JSON.stringify([{ actions: ['jobs:start'], scope: { workspaceIds: [execution.workspaceId] } }])])
      const publicationSessions = new Set<pg.PoolClient>()
      let releasePublications!: () => void
      const overlapping = new Promise<void>(resolve => { releasePublications = resolve })
      // Publication takes an exclusive lock first, so overlapping requests queue behind the first publisher.
      const requireAcceptedSource = async (sql: pg.PoolClient) => {
        await sql.query('select record from job_executions where id=$1 for share', [execution.id])
        publicationSessions.add(sql)
        await overlapping
      }
      const dispatch = { require: requireAcceptedSource, requireLaunch: requireAcceptedSource,
        requireControl: requireAcceptedSource, requireEvidence: requireAcceptedSource, observeReceipt: async () => {} }
      const authority = new JobPublicationAuthority(dispatch, { revalidateAccepted: async () => {} })
      const bridge = new JobApplicationBridge(pool, dispatch, { appendLog: async () => { throw new Error('Unexpected log') } }, authority)
      const frame = { method: 'job-authorize', intent, action: 'publish' }
      const clients: pg.PoolClient[] = []
      try {
        for (let index = 0; index < 12; index++) clients.push(await pool.connect())
      } finally {
        for (const client of clients) client.release()
      }
      const publications = Promise.allSettled(Array.from({ length: 12 }, () => bridge.handle(frame, binding)))
      try {
        await readUntil(async () => {
          const waiting = await admin.query<{ count: number }>(`select count(*)::integer as count
            from pg_stat_activity where application_name=$1 and wait_event_type='Lock'`, [schema])
          return { publishers: publicationSessions.size, waiting: waiting.rows[0]!.count }
        }, state => state.publishers === 1 && state.waiting === 11,
        { timeoutMs: 1000, description: 'eleven publications to queue behind the first publisher' })
      } finally {
        releasePublications()
        await publications
      }
      const results = await publications
      expect(results.map(result => result.status === 'fulfilled' ? result.value : String(result.reason)))
        .toEqual(Array.from({ length: 12 }, () => ({ authorized: true, operationId: intent.operationId,
          attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner })))
      await expect(bridge.handle(frame, { ...binding, mainInstallationId: randomUUID() }))
        .rejects.toThrow('Installed Main does not own')
      await pool.query("update management_principals set revoked_at=now() where id='owner'")
      await expect(bridge.handle(frame, binding)).rejects.toThrow()
      expect((await pool.query('select record from job_executions where id=$1', [execution.id])).rows[0].record)
        .toEqual(execution)
    } finally {
      await pool?.end()
      try { await admin.query(`drop schema if exists ${schema} cascade`) } finally { await admin.end() }
    }
  }, 15000)
})
