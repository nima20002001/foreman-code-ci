import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureDatabase, dropFixtureDatabase, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { projectJobReceiptLocked } from '../src/modules/jobs/receiptProjection.js'
import { executeJob, jobSupervisorIdentity } from '../src/modules/jobs/executor.js'
import type { PodmanJobSupervisor } from '../src/modules/jobs/executorPodman.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { RemoteJobExecutionHost } from '../src/modules/runs/remote/jobExecutionHost.js'
import { jobSpec } from './helpers/jobFixture.js'

vi.mock('../src/modules/jobs/executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/jobs/executor.js')>(), executeJob: vi.fn(),
}))

// Real migrations, authenticated MCP and persisted readback. Native execution
// and source qualification are explicit doubles; no installed OCI claim.
describe.skipIf(process.env.JOB_LIFECYCLE_POSTGRES !== '1' && !process.env.TEST_DATABASE_URL)('Job retained-log MCP readback', () => {
  it('persists a failed final-log gap through completion and denies an ungranted MCP reader', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Job lifecycle tests require loopback PostgreSQL')
    const admin = new pg.Client({ connectionString: url.toString() })
    const name = `job_log_test_${randomUUID().replaceAll('-', '')}`, clients: Client[] = []
    let pool: pg.Pool | undefined, app: ReturnType<typeof buildApp> | undefined, journal: RemoteOperationJournal | undefined
    let root: string | undefined, created = false
    await admin.connect()
    try {
      await createFixtureDatabase(admin, name); created = true
      url.pathname = `/${name}`
      pool = new pg.Pool({ connectionString: url.toString(), max: 5 })
      const db = pool
      await applyApplicationMigrations(db)
      const workspaceId = randomUUID(), access = new PostgresAccessService(db), commands = new PostgresCommandCoordinator(db)
      await db.query('insert into workspaces(id,record) values($1,$2)', [workspaceId, JSON.stringify({ id: workspaceId, name: 'Log readback fixture' })])
      const writer = await access.issue({ name: 'Job writer', audience: 'operator', expiresAt: new Date(Date.now() + 60000),
        grants: [{ actions: ['job_definitions:write', 'jobs:start', 'jobs:read'], scope: { workspaceIds: [workspaceId] } }] })
      const denied = await access.issue({ name: 'No Job read grant', audience: 'operator', expiresAt: new Date(Date.now() + 60000),
        grants: [{ actions: ['capabilities:read'], scope: { workspaceIds: [workspaceId] } }] })
      const forbidden = vi.fn(async () => { throw new Error('Unexpected native/source operation in readback fixture') })
      const jobs = new JobService(db, commands, {
        preparation: { choices: async () => ({ targets: [], sources: [], policies: [] }), validate: async () => ({ valid: true, reasons: [], sideEffects: false }),
          accept: async (_sql, _principal, _workspaceId, spec) => ({ ...spec, source: { ...spec.source, materializationId: randomUUID(), materializationDigest: '1'.repeat(64) } }),
          revalidateAccepted: async () => {}, adoptFinalBinding: async () => {} },
        dispatch: { accept: async (_sql, input) => ({ operationId: input.operationId, attemptId: input.attemptId, owner: { grantId: randomUUID(), epoch: '1' } }),
          wake: async () => {}, cancel: forbidden, cancelForRunCleanup: forbidden },
        artifacts: { list: async () => [], read: forbidden },
      })
      const saved = await jobs.saveDefinition(writer.principal, 'http', workspaceId,
        { commandId: randomUUID(), expectedRevision: null, name: 'Final log', spec: jobSpec() })
      const execution = await jobs.start(writer.principal, 'http', workspaceId,
        { commandId: randomUUID(), definitionId: saved.id, expectedRevision: 1 })
      const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId: execution.acceptedSpec.target.mainId,
        executionId: execution.id, operationId: execution.operationId, attemptId: execution.attemptId, owner: execution.owner,
        bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`,
        subject: { kind: 'manual-job', workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId } })
      root = await mkdtemp(join(tmpdir(), 'job-log-mcp-'))
      journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true })
      const appendLog = vi.fn(async () => {}); appendLog.mockRejectedValueOnce(new Error('Final stdout delivery failed'))
      vi.mocked(executeJob).mockImplementation(async (current, ports) => {
        const supervisorIdentity = jobSupervisorIdentity(current)
        expect(await ports.authority.claim(current, supervisorIdentity)).toBe('launch')
        await ports.authority.launched(current, supervisorIdentity, 'c'.repeat(64))
        await ports.appendLog({ executionId: current.id, attemptId: current.attemptId, sequence: 1,
          stream: 'stdout', text: 'final', byteSize: 5, createdAt: new Date().toISOString() })
        return { outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true, supervisorIdentity,
          containerId: 'c'.repeat(64), recoveryRequired: false, logError: false, logsTruncated: false, outputCollectionError: false }
      })
      const removeExecution = vi.fn(async () => {})
      const host = new RemoteJobExecutionHost({ journal, incarnationId: randomUUID(),
        connection: { kind: 'main', mainId: intent.mainId, mainInstallationId: execution.acceptedSpec.target.mainInstallationId!, bootId: randomUUID() },
        supervisor: { removeExecution } as unknown as PodmanJobSupervisor,
        source: { verify: forbidden }, inputs: { prepare: forbidden },
        authorize: async () => {}, appendLog, collectOutputs: async () => {},
        observeReceipt: async receipt => {
          const sql = await db.connect()
          try {
            await sql.query('begin')
            const original = await jobs.repository.execution(sql, workspaceId, execution.id, true)
            await projectJobReceiptLocked(sql, original, receipt, { verifyRequiredOutputs: async () => {} })
            await sql.query('commit')
          } catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
        },
      })
      await host.deliver(intent, execution); await host.drain()
      const persisted = await jobs.repository.execution(db, workspaceId, execution.id)
      expect(persisted.publication).toBe('complete'); expect(persisted.resultIssue).toBe('log_delivery_unknown')
      expect(await journal.jobPendingLogs(intent.operationId)).toHaveLength(1)
      expect(removeExecution).toHaveBeenCalledWith(execution, 'c'.repeat(64))
      app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { jobs, commands } as OperatorServices } })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'Job log MCP test', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
        return client
      }
      const reader = await connect(writer.token)
      const readback = await reader.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution.id } })
      expect(readback.isError).not.toBe(true); expect(decodeMcpToolResult(readback)).toEqual({ execution: persisted })
      const ungranted = await connect(denied.token)
      const rejected = await ungranted.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution.id } })
      expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected.content)).toContain('ACCESS_DENIED')
      expect(vi.mocked(executeJob)).toHaveBeenCalledOnce(); expect(appendLog).toHaveBeenCalledOnce()
    } finally {
      await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await journal?.close(); await pool?.end()
      try { if (created) await dropFixtureDatabase(admin, name) } finally { await admin.end(); if (root) await removeFixtureDirectory(root) }
      vi.clearAllMocks()
    }
  }, 60000)
})
