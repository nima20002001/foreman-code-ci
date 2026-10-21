import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JobAdmissionResultSchema, JobPendingAdmissionSchema } from '@foreman-code/contracts/job-admission'
import { PreparedJobSpecSchema, JobDefinitionSchema, type JobDefinitionSpec, type JobExecution } from '@foreman-code/contracts/jobs'
import { RemoteJobOperationReceiptSchema, type RemoteJobDispatchPort } from '@foreman-code/contracts/remote-job-execution'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresJobDispatch, type JobDispatchHost } from '../src/modules/jobs/dispatch.js'
import type { JobPreparationPort } from '../src/modules/jobs/ports.js'
import { projectJobReceiptLocked } from '../src/modules/jobs/receiptProjection.js'
import { JobService } from '../src/modules/jobs/service.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { jobSpec } from './helpers/jobFixture.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { JobComputerSelection } from '../src/modules/jobs/computerSelection.js'

describe.skipIf(!postgresEnabled)('Worker execution startup gates', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  const resources: Array<() => Promise<void>> = []
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database.close() }, 60_000)
  afterEach(async () => {
    for (const close of resources.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  function workerSpec(): JobDefinitionSpec {
    const spec = jobSpec()
    spec.target.hostRef = { kind: 'device', mainId: spec.target.mainId, deviceId: randomUUID() }
    spec.target.registration = {
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    }
    return spec
  }

  async function jobFixture(options: { enabled?: boolean; queued?: boolean; mainComputer?: boolean } = {}) {
    const workspaceId = randomUUID()
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [
      workspaceId, JSON.stringify({ id: workspaceId, name: 'Worker gate fixture' }),
    ])
    const access = new PostgresAccessService(database.pool)
    const commands = new PostgresCommandCoordinator(database.pool)
    const writer = await access.issue({
      name: 'Job gate writer', audience: 'operator', expiresAt: new Date(Date.now() + 300_000),
      grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel'],
        scope: { workspaceIds: [workspaceId] } }],
    })
    const reader = await access.issue({
      name: 'Job gate reader', audience: 'operator', expiresAt: new Date(Date.now() + 300_000),
      grants: [{ actions: ['jobs:read'], scope: { workspaceIds: [workspaceId] } }],
    })
    let queueFixture: Awaited<ReturnType<typeof buildQueueFixture>> | undefined
    if (options.queued) {
      const settingsOwner = await access.issue({ name: 'Build settings fixture', audience: 'operator',
        expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
      queueFixture = await buildQueueFixture(database.pool, writer.principal, { workspaceId,
        settingsPrincipal: settingsOwner.principal, mainComputer: options.mainComputer ?? false })
      queueFixture.online()
      resources.push(() => queueFixture!.jobs.closeQueue())
    }
    const preparation: JobPreparationPort = {
      choices: async () => ({ targets: [], sources: [], policies: [] }),
      validate: vi.fn<JobPreparationPort['validate']>(async () => ({ valid: true, reasons: [], sideEffects: false })),
      revalidateAccepted: async () => {},
      adoptFinalBinding: vi.fn(async () => {}),
      accept: vi.fn(async (_sql, _principal, _workspace, spec) => ({
        ...spec, source: { ...spec.source, materializationId: randomUUID(), materializationDigest: '1'.repeat(64) },
      })),
    }
    const pending = { status: 'unknown' as const, reason: 'journal_absence_requires_reconciliation' as const }
    const remote = {
      deliver: vi.fn<RemoteJobDispatchPort['deliver']>(async () => pending),
      reconcile: vi.fn<RemoteJobDispatchPort['reconcile']>(async () => pending),
      control: vi.fn<RemoteJobDispatchPort['control']>(async () => pending),
    }
    const host = {
      revalidate: vi.fn<JobDispatchHost['revalidate']>(async () => {}),
      authorizeControl: vi.fn<JobDispatchHost['authorizeControl']>(async () => {}),
      observe: vi.fn<JobDispatchHost['observe']>(async (sql, execution, receipt) => {
        await projectJobReceiptLocked(sql, execution, receipt, { verifyRequiredOutputs: async () => {} })
      }),
    }
    const compose = async (workerExecution: WorkerExecutionPolicy) => {
      const dispatch = new PostgresJobDispatch(database.pool, remote, host, workerExecution)
      resources.push(() => dispatch.close())
      const jobs = new JobService(database.pool, commands, {
        preparation, dispatch, workerExecution,
        ...(queueFixture ? { queue: queueFixture.queue,
          placement: new JobComputerSelection(queueFixture.settings, queueFixture.inventory, workerExecution) } : {}),
        artifacts: { list: async () => [], read: async () => { throw new Error('No artifact in this fixture') } },
      })
      resources.push(() => jobs.closeQueue())
      const app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { jobs, commands } as unknown as OperatorServices },
      })
      resources.push(() => app.close())
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'Worker gate test', version: '1' })
        resources.push(() => client.close())
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      return { app, jobs, dispatch, connect }
    }
    const application = await compose(new WorkerExecutionPolicy({
      enabled: options.enabled ?? false, managedBy: 'startup',
    }))
    const root = `/api/management/workspaces/${workspaceId}/jobs`
    const headers = { authorization: `Bearer ${writer.token}` }
    const save = async (spec: JobDefinitionSpec) => {
      if (queueFixture) spec = { ...queueFixture.computers[0]!.candidate.spec, argv: spec.argv,
        inputs: spec.inputs, outputs: spec.outputs }
      const response = await application.app.inject({ method: 'POST', url: `${root}/definitions`, headers,
        payload: { commandId: randomUUID(), expectedRevision: null, name: 'Saved Job', spec } })
      expect(response.statusCode).toBe(200)
      return JobDefinitionSchema.parse(response.json().definition)
    }
    return { ...application, compose, root, headers, workspaceId, writer, reader, preparation, remote, host, save }
  }

  async function expectNoJobAllocation(workspaceId: string) {
    for (const table of ['job_preparations', 'job_executions', 'job_dispatch_intents']) {
      expect((await database.pool.query(`select 1 from ${table} where workspace_id=$1`, [workspaceId])).rows)
        .toEqual([])
    }
  }

  it('queues disabled Worker manual Jobs through HTTP and authenticated MCP without source reservation', async () => {
    const fixture = await jobFixture({ queued: true })
    const definition = await fixture.save(workerSpec())
    const input = { definitionId: definition.id, expectedRevision: definition.revision, commandId: randomUUID() }
    const http = await fixture.app.inject({ method: 'POST', url: `${fixture.root}/executions`,
      headers: fixture.headers, payload: input })
    expect(http.statusCode).toBe(200)
    expect(http.json().admission.kind).toBe('pending-admission')
    await fixture.jobs.wakeQueue()
    expect(await fixture.jobs.getQueueTicket(fixture.writer.principal, fixture.workspaceId, http.json().admission.ticket.id))
      .toMatchObject({ state: 'blocked', waitingReasons: ['remote_execution_disabled'] })
    const client = await fixture.connect(fixture.writer.token)
    const mcp = await client.callTool({ name: 'job_start',
      arguments: { workspaceId: fixture.workspaceId, ...input, commandId: randomUUID() } })
    expect(mcp.isError).not.toBe(true)
    const pending = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(mcp))
    expect(pending.admission).toMatchObject({ kind: 'pending-admission' })
    await fixture.jobs.wakeQueue()
    expect(fixture.preparation.accept).not.toHaveBeenCalled()
    expect(fixture.remote.deliver).not.toHaveBeenCalled()
    await expectNoJobAllocation(fixture.workspaceId)
    const receipts = await database.pool.query(
      "select 1 from management_command_receipts where principal_id=$1 and operation='job.start'",
      [fixture.writer.principal.id],
    )
    expect(receipts.rows).toEqual([])
  })

  it('queues and dispatches Main Jobs with Worker execution disabled', async () => {
    const fixture = await jobFixture({ queued: true, mainComputer: true })
    const definition = await fixture.save(jobSpec())
    const response = await fixture.app.inject({ method: 'POST', url: `${fixture.root}/executions`,
      headers: fixture.headers, payload: { definitionId: definition.id, expectedRevision: 1, commandId: randomUUID() } })
    expect(response.statusCode).toBe(200)
    expect(['pending-admission', 'accepted']).toContain(response.json().admission.kind)
    await expect(fixture.jobs.wakeQueue()).rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
    expect(fixture.preparation.accept).toHaveBeenCalledOnce()
    expect(fixture.remote.deliver).toHaveBeenCalledOnce()
    const rows = (await database.pool.query('select record from job_executions where workspace_id=$1',
      [fixture.workspaceId])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].record.acceptedSpec.target.hostRef.kind).toBe('main')
  })

  it('rejects workflow Job preparation and admission before source or dispatch allocation', async () => {
    const fixture = await jobFixture()
    const definition = await fixture.save(workerSpec())
    const identity = { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() }
    const workflow = { workflowId: randomUUID(), runId: randomUUID(), nodeId: 'build',
      nodeExecutionId: identity.executionId }
    await expect(fixture.jobs.prepareDefinition(database.pool, fixture.writer.principal, definition, identity))
      .rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED' })
    await expect(fixture.jobs.admit(database.pool, fixture.writer.principal, definition, workflow, {}))
      .rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED' })
    const prepared = PreparedJobSpecSchema.parse({ ...definition.spec, source: { ...definition.spec.source,
      materializationId: randomUUID(), materializationDigest: '1'.repeat(64) } })
    await expect(fixture.jobs.admitPrepared(database.pool, fixture.writer.principal,
      definition, workflow, {}, prepared, identity)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED' })
    expect(fixture.preparation.accept).not.toHaveBeenCalled()
    await expectNoJobAllocation(fixture.workspaceId)
  })

  it('blocks the first delivery of an accepted Worker Job after Main restarts with execution disabled', async () => {
    const fixture = await jobFixture({ enabled: true })
    const definition = await fixture.save(workerSpec())
    const input = { definitionId: definition.id, expectedRevision: 1, commandId: randomUUID() }
    // Stop after the actual acceptance transaction, before its post-commit wakeup.
    vi.spyOn(fixture.dispatch, 'wake').mockResolvedValueOnce()
    const accepted = await fixture.jobs.start(fixture.writer.principal, 'http', fixture.workspaceId, input)
    await fixture.app.close()
    await fixture.dispatch.close()
    const restarted = await fixture.compose(new WorkerExecutionPolicy())
    const client = await restarted.connect(fixture.writer.token)
    const replay = await client.callTool({ name: 'job_start', arguments: { workspaceId: fixture.workspaceId, ...input } })
    expect(replay.isError).toBe(true)
    expect(JSON.stringify(replay.content)).toContain('WORKER_EXECUTION_DISABLED')
    expect(fixture.remote.deliver).not.toHaveBeenCalled()
    const row = (await database.pool.query(
      'select delivery_attempted,receipt_sequence from job_dispatch_intents where execution_id=$1', [accepted.id],
    )).rows[0]
    expect(row).toEqual({ delivery_attempted: false, receipt_sequence: '0' })
    const read = await client.callTool({ name: 'job_get',
      arguments: { workspaceId: fixture.workspaceId, executionId: accepted.id } })
    expect(read.isError).not.toBe(true)
    expect(decodeMcpToolResult(read)).toMatchObject({ execution: accepted })
    const cancel = await client.callTool({ name: 'job_cancel', arguments: { workspaceId: fixture.workspaceId,
      executionId: accepted.id, commandId: randomUUID() } })
    expect(cancel.isError).not.toBe(true)
    expect(decodeMcpToolResult(cancel)).toMatchObject({ execution: {
      id: accepted.id, process: { phase: 'terminal', outcome: 'cancelled', processStopped: true },
      publication: 'complete',
    } })
    expect(fixture.remote.deliver).not.toHaveBeenCalled()
    expect(fixture.remote.control).not.toHaveBeenCalled()
  })

  it('retains attempted Job replay, reconciliation, cancellation and history while Worker execution is disabled', async () => {
    const fixture = await jobFixture({ enabled: true })
    const definition = await fixture.save(workerSpec())
    const input = { definitionId: definition.id, expectedRevision: 1, commandId: randomUUID() }
    await expect(fixture.jobs.start(fixture.writer.principal, 'http', fixture.workspaceId, input))
      .rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
    const execution: JobExecution = (await database.pool.query('select record from job_executions where workspace_id=$1',
      [fixture.workspaceId])).rows[0].record
    await fixture.app.close()
    await fixture.dispatch.close()
    const restarted = await fixture.compose(new WorkerExecutionPolicy())
    const client = await restarted.connect(fixture.writer.token)
    const replay = await client.callTool({ name: 'job_start', arguments: { workspaceId: fixture.workspaceId, ...input } })
    expect(replay.isError).toBe(true)
    expect(JSON.stringify(replay.content)).toContain('JOB_DISPATCH_PENDING')
    expect(fixture.remote.deliver).toHaveBeenCalledOnce()
    expect(fixture.remote.reconcile).toHaveBeenCalledOnce()
    const cancel = await client.callTool({ name: 'job_cancel', arguments: { workspaceId: fixture.workspaceId,
      executionId: execution.id, commandId: randomUUID() } })
    expect(cancel.isError).toBe(true)
    expect(JSON.stringify(cancel.content)).toContain('JOB_DISPATCH_PENDING')
    expect(fixture.remote.control).toHaveBeenCalledOnce()
    const history = await client.callTool({ name: 'job_get',
      arguments: { workspaceId: fixture.workspaceId, executionId: execution.id } })
    expect(history.isError).not.toBe(true)
    const http = await restarted.app.inject({ method: 'GET', url: `${fixture.root}/executions/${execution.id}`,
      headers: fixture.headers })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(decodeMcpToolResult(history))
    expect(http.json().execution).toMatchObject({ id: execution.id, acceptedSpec: execution.acceptedSpec,
      operationId: execution.operationId, attemptId: execution.attemptId, cancelRequestedAt: expect.any(String) })
    expect((await database.pool.query('select id from job_executions where workspace_id=$1',
      [fixture.workspaceId])).rows).toEqual([{ id: execution.id }])
    const denied = await restarted.connect(fixture.reader.token)
    const rejected = await denied.callTool({ name: 'job_cancel', arguments: { workspaceId: fixture.workspaceId,
      executionId: execution.id, commandId: randomUUID() } })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('ACCESS_DENIED')
    expect(fixture.remote.control).toHaveBeenCalledOnce()
  })

  it('allows enabled Worker admission while retaining target qualification and scoped permission checks', async () => {
    const fixture = await jobFixture({ enabled: true, queued: true })
    const definition = await fixture.save(workerSpec())
    const input = { definitionId: definition.id, expectedRevision: 1, commandId: randomUUID() }
    fixture.host.revalidate.mockRejectedValue(new DomainError('PLACEMENT_NOT_QUALIFIED', 'Worker is not qualified', 409))
    const response = await fixture.app.inject({ method: 'POST', url: `${fixture.root}/executions`,
      headers: fixture.headers, payload: input })
    expect(response.statusCode).toBe(200)
    await expect(fixture.jobs.wakeQueue()).rejects.toMatchObject({ code: 'PLACEMENT_NOT_QUALIFIED' })
    expect(fixture.preparation.accept).toHaveBeenCalledOnce()
    expect(fixture.remote.deliver).not.toHaveBeenCalled()
    fixture.host.revalidate.mockResolvedValue()
    const client = await fixture.connect(fixture.writer.token)
    const permitted = await client.callTool({ name: 'job_start', arguments: { workspaceId: fixture.workspaceId, ...input } })
    expect(permitted.isError).not.toBe(true)
    const accepted = z.object({ admission: JobAdmissionResultSchema }).parse(decodeMcpToolResult(permitted))
    expect(accepted.admission).toMatchObject({ kind: 'accepted' })
    await expect(fixture.jobs.wakeQueue()).rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
    expect(fixture.remote.deliver).toHaveBeenCalledOnce()
    const denied = await fixture.app.inject({ method: 'POST', url: `${fixture.root}/executions`,
      headers: { authorization: `Bearer ${fixture.reader.token}` }, payload: { ...input, commandId: randomUUID() } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect(fixture.preparation.accept).toHaveBeenCalledOnce()
  })

  it('accepts closure during delivery and reads it after restart without another delivery', async () => {
    const fixture = await jobFixture({ enabled: true })
    const definition = await fixture.save(workerSpec())
    fixture.remote.deliver.mockImplementationOnce(async (intent, execution) => {
      const registration = execution.acceptedSpec.target.registration!
      const hostRef = execution.acceptedSpec.target.hostRef
      if (hostRef.kind !== 'device') throw new Error('Expected Worker target')
      const now = new Date().toISOString()
      const receipt = RemoteJobOperationReceiptSchema.parse({
        schemaVersion: 1, kind: 'job', intent, execution,
        connection: { mainId: hostRef.mainId, deviceId: hostRef.deviceId, ...registration,
          bootId: randomUUID(), connectionGeneration: 1 },
        workerIncarnationId: randomUUID(), sequence: 1, observedAt: now,
        phase: 'confirmed_terminal', entryAttempted: false, stopFence: true, controls: [],
        terminal: { outcome: 'cancelled', exitCode: null, signal: null, processStopped: true,
          finishedAt: now, closureEvidenceDigest: '1'.repeat(64), logGapPossible: false,
          logsTruncated: false, outputCollectionError: false, resultDigest: '1'.repeat(64), artifactDigests: [] },
        publication: 'complete',
      })
      await fixture.dispatch.observeReceipt(execution.workspaceId, execution.id, receipt)
      return { status: 'known', receipt }
    })
    const input = { definitionId: definition.id, expectedRevision: 1, commandId: randomUUID() }
    const execution = await fixture.jobs.start(fixture.writer.principal, 'http', fixture.workspaceId, input)
    expect(execution.process.outcome).toBe('cancelled')
    await fixture.app.close()
    await fixture.dispatch.close()
    const restarted = await fixture.compose(new WorkerExecutionPolicy())
    const retained = await restarted.dispatch.readAcceptedClosureReceipt(database.pool, {
      workspaceId: fixture.workspaceId, executionId: execution.id, attemptId: execution.attemptId,
      operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner,
    })
    expect(retained).toMatchObject({ intent: { executionId: execution.id }, phase: 'confirmed_terminal' })
    const replay = await restarted.jobs.start(fixture.writer.principal, 'mcp', fixture.workspaceId, input)
    expect(replay).toEqual(execution)
    const client = await restarted.connect(fixture.writer.token)
    const retainedStart = await client.callTool({ name: 'job_start', arguments: {
      workspaceId: fixture.workspaceId, ...input,
    } })
    expect(retainedStart.isError).not.toBe(true)
    expect(decodeMcpToolResult(retainedStart)).toEqual({ admission: { kind: 'retained-execution', execution } })
    const httpRetry = await restarted.app.inject({ method: 'POST', url: `${fixture.root}/executions`,
      headers: fixture.headers, payload: input })
    expect(httpRetry.statusCode).toBe(200)
    expect(httpRetry.json()).toEqual(decodeMcpToolResult(retainedStart))
    expect(await restarted.jobs.listQueue(fixture.writer.principal, fixture.workspaceId)).toEqual([])
    expect(fixture.remote.deliver).toHaveBeenCalledOnce()
    expect(fixture.remote.reconcile).not.toHaveBeenCalled()
  })

  async function runFixture(options: { placement: 'main' | 'worker' }) {
    const candidate = makeCurrentWorkflowFixture(randomUUID())
    if (options.placement === 'worker') {
      for (const node of candidate.version.definition.nodes) {
        node.placement = { schemaVersion: 1,
          hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() },
          rootPolicyId: 'approved-root', rootPolicyRevision: '1', locationRevision: '1',
          projectRoot: '/approved/project', cwdPolicy: 'project-root', relativeCwd: '',
          instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'installation' }
      }
    }
    const saved = await seedAgent3(database.pool, database.directory, candidate, { run: false })
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Run gate writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ManagementActionSchema.options,
        scope: { workspaceIds: [saved.scope.workspaceId] } }] })
    const locations = new WorkspaceLocationService(database.pool, new PostgresCommandCoordinator(database.pool))
    const selected = await locations.set(writer.principal, 'http', { workspaceId: saved.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: database.directory })
    const sql = await database.pool.connect()
    try {
      saved.run.executionLocation = await locations.snapshot(sql, saved.scope.workspaceId,
        selected.value.locationRevision, 'read-only')
    } finally { sql.release() }
    vi.spyOn(locations, 'snapshot').mockResolvedValue(saved.run.executionLocation!)
    const revision = (await database.pool.query('select revision from workflows where id=$1',
      [saved.scope.workflowId])).rows[0].revision
    const input = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
      workflowVersionId: saved.version.id, executionSemanticsVersion: 3 as const, commandId: randomUUID(),
      expectedWorkflowRevision: Number(revision),
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: saved.run.executionLocation!.locationRevision, input: {} }
    return { saved, writer, locations, input }
  }

  it('rejects a Worker Agent Run before Run, delegated authority or graph allocation', async () => {
    const fixture = await runFixture({ placement: 'worker' })
    await expect(admitRepeatRun(database.pool, fixture.locations, fixture.writer.principal, 'mcp',
      fixture.input, repeatStartPublication)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED' })
    expect((await database.pool.query('select 1 from runs where workflow_id=$1',
      [fixture.saved.scope.workflowId])).rows).toEqual([])
    expect((await database.pool.query('select 1 from management_principals where delegated_from=$1',
      [fixture.writer.principal.id])).rows).toEqual([])
    const receipts = await database.pool.query(
      "select 1 from management_command_receipts where principal_id=$1 and operation='run.start'",
      [fixture.writer.principal.id],
    )
    expect(receipts.rows).toEqual([])
  })

  it('admits and replays an ordinary Main Agent Run with Worker execution disabled', async () => {
    const fixture = await runFixture({ placement: 'main' })
    const accepted = await admitRepeatRun(database.pool, fixture.locations, fixture.writer.principal, 'http',
      fixture.input, repeatStartPublication)
    const replay = await admitRepeatRun(database.pool, fixture.locations, fixture.writer.principal, 'mcp',
      fixture.input, repeatStartPublication)
    expect(replay).toEqual({ ...accepted, replayed: true })
    expect((await database.pool.query('select id from runs where workflow_id=$1',
      [fixture.saved.scope.workflowId])).rows).toEqual([{ id: accepted.value.id }])
    expect((await database.pool.query('select run_id from run_graph_heads where run_id=$1',
      [accepted.value.id])).rows).toEqual([{ run_id: accepted.value.id }])
    expect((await database.pool.query('select 1 from run_repeat_executions where run_id=$1',
      [accepted.value.id])).rows).toEqual([])
  })
})
