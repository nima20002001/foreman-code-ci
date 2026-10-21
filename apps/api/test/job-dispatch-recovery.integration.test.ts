import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { BuildComputerSettings, buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { JobComputerSelection } from '../src/modules/jobs/computerSelection.js'
import { buildComputerFixture, buildQueueConfigurationFixture } from './helpers/buildComputerFixture.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { JobService } from '../src/modules/jobs/service.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { RemoteJobCarrierDispatch } from '../src/modules/runs/remote/jobCarrierDispatch.js'

// Own random schema on the explicitly selected loopback server. No physical
// qualification/native entry or journal absence as proof of nonexecution.
it.skipIf(!process.env.JOB_DISPATCH_DATABASE_URL).each(['fixed', 'auto'] as const)('reports retained delivery/reconciliation failures through HTTP and MCP without redispatch or fabricated cancellation (%s)', async placementMode => {
  const connectionString = process.env.JOB_DISPATCH_DATABASE_URL!
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Use the authorized local PostgreSQL server.')
  const schema = `job_dispatch_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString, max: 1 })
  const pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined, dispatch: PostgresJobDispatch | undefined
  let jobs: JobService | undefined
  await createFixtureSchema(admin, schema)
  try {
    await applyApplicationMigrations(pool)
    const workspaceId = randomUUID(), deviceId = randomUUID()
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({ id: workspaceId, name: 'Dispatch recovery fixture' })])
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const writer = await access.issue({ name: 'Job writer', audience: 'operator', expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:cancel', 'jobs:read'], scope: { workspaceIds: [workspaceId] } }, { actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Job reader', audience: 'operator', expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read'], scope: { workspaceIds: [workspaceId] } }] })
    const request = vi.fn(async (_device: string, _namespace: string, raw: unknown): Promise<{ payload: unknown }> => {
      if ((raw as { method: string }).method === 'job-dispatch') throw new Error('transport rejected before a receipt; secret must not be exposed')
      return { payload: { status: 'unknown', reason: 'journal_absence_requires_reconciliation' } }
    })
    const workerExecution = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
    const mainId = (await pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const automatic = buildComputerFixture(mainId, workspaceId, deviceId)
    await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [deviceId, mainId, automatic.registration.workerInstallationId, JSON.stringify(automatic.registration)])
    const settings = new BuildComputerSettings(pool, commands, async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
    await settings.update(writer.principal, 'http', { target: automatic.target, commandId: randomUUID(),
      expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
    const placement = new JobComputerSelection(settings, { candidates: async () => ({ candidates: [automatic.candidate], diagnosticCodes: [] }) }, workerExecution)

    dispatch = new PostgresJobDispatch(pool, new RemoteJobCarrierDispatch(pool, { request }, undefined), {
      revalidate: async () => {}, authorizeControl: async () => {}, observe: async () => { throw new Error('No receipt was returned.') },
      authorizeLaunch: async (sql, execution) => {
        if (placementMode === 'auto') await settings.requireEnabled(sql, buildComputerTarget(execution.acceptedSpec.target))
      },
    }, workerExecution)
    jobs = new JobService(pool, commands, {
      workerExecution,
      placement, queue: buildQueueConfigurationFixture(writer.principal, automatic.candidate.profile.limits),
      preparation: { choices: async () => ({ targets: [], sources: [], policies: [] }), validate: async () => ({ valid: true, reasons: [], sideEffects: false }),
        revalidateAccepted: async () => {}, adoptFinalBinding: async () => {}, accept: async (_sql, _principal, _workspace, spec) => ({ ...spec, source: { ...spec.source, materializationId: randomUUID(), materializationDigest: '1'.repeat(64) } }) },
      dispatch, artifacts: { list: async () => [], read: async () => { throw new Error('No physical artifact.') } },
    })
    const queueWake = vi.spyOn(jobs, 'wakeQueue')
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } }, operator: { access, services: { jobs, commands } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'dispatch-recovery', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(writer.token), deniedClient = await connect(reader.token)
    const root = `/api/management/workspaces/${workspaceId}/jobs`, headers = { authorization: `Bearer ${writer.token}` }
    const spec = automatic.candidate.spec
    const saved = await app.inject({ method: 'POST', url: `${root}/definitions`, headers, payload: { commandId: randomUUID(), expectedRevision: null, name: 'Retained dispatch', spec: placementMode === 'auto' ? automatic.auto : spec } })
    expect(saved.statusCode).toBe(200)
    const command = { commandId: randomUUID(), definitionId: saved.json().definition.id, expectedRevision: 1 }
    const start = await app.inject({ method: 'POST', url: `${root}/executions`, headers, payload: command })
    expect(start.statusCode).toBe(200)
    expect(['pending-admission', 'accepted']).toContain(start.json().admission.kind)
    // Start already wakes the queue; await that work instead of requesting a second recovery scan.
    expect(queueWake).toHaveBeenCalledTimes(1)
    await expect(queueWake.mock.results[0]!.value).rejects
      .toMatchObject({ code: 'JOB_DISPATCH_PENDING', details: { retryable: true } })
    expect(JSON.stringify(start.json())).not.toContain('secret')
    const original = (await pool.query('select e.record,d.delivery_attempted,d.receipt_sequence,d.last_receipt from job_executions e join job_dispatch_intents d on d.execution_id=e.id where e.workspace_id=$1', [workspaceId])).rows
    expect(original).toHaveLength(1)
    const execution = original[0].record
    expect(original[0]).toMatchObject({ delivery_attempted: true, receipt_sequence: '0', last_receipt: null })
    expect(execution.process).toMatchObject({ phase: 'queued', outcome: null, processStopped: false })
    const tickets = await jobs.listQueue(writer.principal, workspaceId)
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({ state: 'accepted', executionId: execution.id,
      attemptId: execution.attemptId, operationId: execution.operationId })
    await dispatch.close()
    if (placementMode === 'auto') {
      const selected = buildComputerTarget(execution.acceptedSpec.target)
      await settings.update(writer.principal, 'http', { target: selected, commandId: randomUUID(),
        expectedRevision: 1, buildEnabled: false, buildPriority: 0 })
      expect(execution.acceptedSpec.computerSelection).toMatchObject({ mode: 'auto', buildPriority: 100 })
    }
    const retry = await client.callTool({ name: 'job_start', arguments: { workspaceId, ...command } })
    expect(retry.isError).not.toBe(true)
    expect(decodeMcpToolResult(retry)).toEqual({ admission: { kind: 'accepted', ticketId: tickets[0]!.id, executionId: execution.id } })
    expect(queueWake).toHaveBeenCalledTimes(2)
    await expect(queueWake.mock.results[1]!.value).rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
    expect(request.mock.calls.map(([, , raw]) => (raw as { method: string }).method))
      .toEqual(['job-dispatch', 'job-status', 'job-dispatch'])
    const cancel = await client.callTool({ name: 'job_cancel', arguments: { workspaceId, executionId: execution.id, commandId: randomUUID() } })
    expect(cancel.isError).toBe(true); expect(JSON.stringify(cancel.content)).toContain('JOB_DISPATCH_PENDING')
    expect(request.mock.calls.map(([, , raw]) => (raw as { method: string }).method))
      .toEqual(['job-dispatch', 'job-status', 'job-dispatch', 'job-control'])
    const read = await client.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution.id } })
    expect(read.isError).not.toBe(true)
    expect(decodeMcpToolResult(read)).toMatchObject({ execution: { id: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, acceptedSpec: execution.acceptedSpec,
      process: { phase: 'queued', outcome: null, processStopped: false }, transport: 'unknown', publication: 'pending', cancelRequestedAt: expect.any(String) } })
    const http = await app.inject({ method: 'GET', url: `${root}/executions/${execution.id}`, headers })
    expect(http.statusCode).toBe(200); expect(http.json()).toEqual(decodeMcpToolResult(read))
    const denied = await deniedClient.callTool({ name: 'job_cancel', arguments: { workspaceId, executionId: execution.id, commandId: randomUUID() } })
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(request).toHaveBeenCalledTimes(4)
    expect((await pool.query('select id from job_executions where workspace_id=$1', [workspaceId])).rows).toEqual([{ id: execution.id }])
  } finally {
    await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await jobs?.closeQueue(); await dispatch?.close(); await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
  }
}, 90000)
