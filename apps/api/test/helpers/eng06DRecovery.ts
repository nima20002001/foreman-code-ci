import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import {
  AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION, HarnessExecutionSchema,
} from '@foreman-code/contracts'
import {
  RUN_INSPECTION_TOOLS, RunAcceptedInputValueSchema, RunExecutionDetailSchema,
  RunExecutionsPageSchema, RunRecordDetailSchema, RunStartV3InputSchema, WorkflowRunV3Schema,
  makeCurrentWorkflowFixture, type RunInspectionToolName, type RunExecutionDetail,
} from '@foreman-code/contracts/wave25'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../../src/app.js'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../../src/modules/access/workerCredentials.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { Wave25WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../../src/modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from '../../src/modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { registerApprovalCheckpointResume } from '../../src/modules/runs/approvalCheckpointRegistration.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../../src/modules/runs/workflowProduction.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../../src/modules/workspaces/management.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { providerLaunchCredentials, providerAppEndpoint } from './wave25Br1003Runtime.js'
import { RecoveryProvider, type Fault, type Submission } from './eng06DProvider.js'
import { waitForEng06Settlement } from './eng06DSettlement.js'

export type Form = 'sequential' | 'repeat' | 'parallel'
type Base = Awaited<ReturnType<typeof currentOperatorIntegration>>
type Runtime = ReturnType<Base['compose']>
export type Transport = Pick<Base, 'app' | 'client' | 'connect'> & { close(): Promise<void> }

/** Same composition as checkpointRuntimeFixture, plus d32a361's final physical
 * recovery port. Only the external provider/registry and filesystem inspector
 * are synthetic. All owners, captures, migrations, lifecycle writers, grants,
 * original-source checks and generation/receipt fences remain real. */
function composeRuntime(base: Base, provider: RecoveryProvider, errors: unknown[], activeStarts: Set<Promise<void>>): Runtime {
  const { pool, directory, schema } = base.db
  const commands = new PostgresCommandCoordinator(pool)
  const workflows = new PostgresWorkflowRepository(pool)
  // Keep the explicitly seeded provider runner through real location_set/Start.
  // The production default is runner-local; this provider fixture models local.
  const locations = new WorkspaceLocationService(pool, commands, undefined, base.f.run.executionLocation!.runnerId)
  vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
  const workflowCapture = createWorkflowNativeCaptureChannel(), reviewCapture = createReviewNativeCaptureChannel()
  const runs = new PostgresRunRepository(pool, workflows, locations,
    { runtimeRoot: directory, ...createWorkflowRepositoryServices(workflowCapture.verify) })
  const repository = new Wave25InteractionRepository(pool, new ReviewNativeProofServices(reviewCapture.verify))
  const budgets = new PostgresApprovalBudgetRepository(pool)
  const managers = new ExecutionScopedNativeSessionManagerResolver(() => provider.connection())
  const credentials = new Wave25WorkerCredentialService(pool, new PostgresAccessService(pool))
  const launchCredentials = providerLaunchCredentials(runs, locations, managers, credentials, () => ({
    async inspect(input) { return { harness: input.harness, providerVersion: '0.154.0',
      runnerId: input.runnerId, workingDirectory: input.workingDirectory, inspectedAt: new Date().toISOString(),
      entry: { name: input.serverName, transport: 'streamable-http', endpoint: providerAppEndpoint,
        enabled: true, credentialEnvironmentVariable: APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, status: 'connected' } } },
  }), pool)
  const native = new ApprovalExecutionCoordinator(runs, repository, budgets, managers, 600000,
    launchCredentials, continuationValidator(pool, locations),
    new PostgresWorkflowClosureStore(pool), new PostgresRepeatReviewerBindings(pool),
    workflowCapture.capture, reviewCapture.capture,
    (executionId, signal) => provider.recoverProcesses(executionId, signal))
  // A fresh object reads the same durable checkpoint tables. Do not preserve
  // process-local saver state or reset an existing Run's checkpoint.
  const checkpointer = new ApprovalPostgresSaver(pool, undefined, { schema })
  const engine = new LangGraphWorkflowEngine(runs, workflows, native, checkpointer, directory,
    locations, launchCredentials, repository, undefined, { workerParallelism: 2 })
  // Observe failures before Start's transport adapter reduces them to a code.
  // Return the ORIGINAL promise; do not fake completion, recovery or dispatch.
  const drive = engine.start.bind(engine)
  vi.spyOn(engine, 'start').mockImplementation((runId) => {
    const task = drive(runId)
    activeStarts.add(task)
    void task.then(() => { activeStarts.delete(task) }, () => { activeStarts.delete(task) })
    void task.catch((error: unknown) => errors.push(error))
    return task
  })
  const service = new InteractionService(repository, budgets, native, (interaction) => engine.resumeInteraction(interaction))
  registerApprovalCheckpointResume(service, engine)
  return { runs, workflows, locations, native, checkpointer, engine, service, repository }
}

function describeError(error: unknown, depth = 0): unknown {
  if (depth > 5) return 'nested cause limit'
  if (!(error instanceof Error)) return String(error)
  return { name: error.name, message: error.message,
    ...('code' in error ? { code: String(error.code) } : {}),
    ...(error.cause ? { cause: describeError(error.cause, depth + 1) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map((item) => describeError(item, depth + 1)) } : {}) }
}

async function openTransport(base: Base, runtime: Runtime, errors: unknown[]): Promise<Transport> {
  const commands = new PostgresCommandCoordinator(base.db.pool), access = new PostgresAccessService(base.db.pool)
  const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
    reportDispatchFailure: (_id, code) => errors.push(code) })({ primaryPool: base.db.pool, commands,
    runs: runtime.runs, workflows: runtime.workflows, locations: runtime.locations, engine: runtime.engine,
    nativeExecutions: runtime.native, interactions: runtime.service, checkpointer: runtime.checkpointer })
  const services = { ...base.services, commands, locations: runtime.locations,
    workspaces: new WorkspaceManagementService(base.db.pool, commands, runtime.locations),
    workflows: new WorkflowManagementService(base.db.pool, commands),
    runs: new RunManagementService(base.db.pool, commands, runtime.runs, runtime.engine, runtime.locations, binding) }
  // MCP serializes unexpected errors internally, so Fastify's onError alone
  // cannot reveal them. Retain the real service error without changing it.
  const realStop = services.runs.stop.bind(services.runs)
  const stopObserver = vi.spyOn(services.runs, 'stop').mockImplementation(async (...args) => {
    try { return await realStop(...args) }
    catch (error) { errors.push(error); throw error }
  })
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services } })
  app.addHook('onError', (_request, _reply, error, done) => { errors.push(error); done() })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'eng06-d-restarted-reader', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    return { app, connect, client: await connect(base.writer.token),
      async close() { await Promise.allSettled(clients.map((client) => client.close())); await app.close(); stopObserver.mockRestore() } }
  } catch (error) { await Promise.allSettled(clients.map((client) => client.close())); await app.close(); stopObserver.mockRestore(); throw error }
}

export async function recoveryFixture(form: Form, plan: (input: Submission) => Fault = () => 'success', budget = 12,
  options: { sessionPersistence?: 'persistent' | 'ephemeral'; parallelism?: number } = {}) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
  // This provider models a separate native session for every execution attempt.
  // Only persistent sessions can detach across a restart and be reattached.
  fixture.configurations = fixture.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
    ...configuration,
    harness: { ...configuration.harness, advanced: {
      ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never',
      sessionPersistence: options.sessionPersistence ?? 'ephemeral',
    } },
  }))
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = { handler: 'native' }
  fixture.run.approval = { handler: 'native' }
  fixture.version.definition.executionPolicy = { maxParallelism: options.parallelism ?? 1, maxNodeExecutions: budget }
  fixture.run.input = { instruction: 'Preserve the accepted input across attempts and recovery' }
  const base = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
  const provider = new RecoveryProvider(base.f.version, plan)
  // The inherited runtime only seeds the authentic saved version/Run. It has no
  // recovery registry port, so it must never run this fixture's native work.
  await base.client.close(); await base.app.close(); await base.engine.shutdown()
  const errors: unknown[] = [], shutdownErrors: unknown[] = []
  const activeStarts = new Set<Promise<void>>()
  let runtime = composeRuntime(base, provider, errors, activeStarts)
  const runtimes = [runtime]
  let transport: Transport
  try { transport = await openTransport(base, runtime, errors) }
  catch (error) {
    await runtime.engine.shutdown().catch((failure: unknown) => shutdownErrors.push(failure))
    await base.close()
    vi.mocked(runtime.locations.revalidateSnapshot).mockRestore()
    vi.mocked(runtime.engine.start).mockRestore()
    throw error
  }
  return {
    base, provider, errors, shutdownErrors,
    diagnostics() { return { starts: provider.counts.starts, recoveries: [...provider.recoveryCalls],
      errors: errors.map((item) => describeError(item)), shutdownErrors: shutdownErrors.map((item) => describeError(item)) } },
    get runtime() { return runtime }, get transport() { return transport },
    launch(runId = base.f.run.id) { void runtime.engine.start(runId).catch((error: unknown) => errors.push(error)) },
    async restart(options: { mode?: 'crash' | 'graceful' } = {}) {
      await transport.close()
      // A dead API cannot publish its original manager's close or detach callback.
      const crashClose = options.mode === 'crash'
        ? vi.spyOn(runtime.native, 'closeForRestart').mockResolvedValue(undefined) : undefined
      // Continue through a reported shutdown failure so a separate Stop/readback
      // assertion still exercises the recovery path. Tests assert this array too.
      try { await runtime.engine.shutdown() } catch (error) { shutdownErrors.push(error) }
      finally {
        crashClose?.mockRestore()
        if (options.mode === 'crash') provider.killAll()
      }
      runtime = composeRuntime(base, provider, errors, activeStarts); runtimes.push(runtime)
      transport = await openTransport(base, runtime, errors)
    },
    async settled(runId = base.f.run.id, options: { pollIntervalMs?: number } = {}) {
      try {
        await waitForEng06Settlement(async () => {
          await runtime.engine.reconcile((error) => errors.push(error))
          const snapshot = await runtime.runs.getRepeatSnapshot(runId)
          const executions = (await base.db.pool.query<{ id: string; state: string; accepted: boolean }>(
            "select id,record->>'state' as state,accepted from harness_executions where run_id=$1 order by id", [runId])).rows
          return { state: snapshot.run.executionState, cleanupPending: snapshot.cleanupPending,
            activeStarts: activeStarts.size, executions }
        }, options)
      } catch (error) {
        // Preserve the real error behind HTTP INTERNAL_ERROR / a generic timeout.
        // No catch converts a failed convergence assertion into a passing test.
        const rows = (await base.db.pool.query<{ id: string; state: string; result: unknown }>(
          "select id,record->>'state' as state,record->'result' as result from harness_executions where run_id=$1 order by id", [runId])).rows
        // Put the cause before large result rows so truncated reports retain it.
        throw new Error(`ENG06-D settlement failed: ${JSON.stringify({ runId,
          errors: errors.map((item) => describeError(item)),
          shutdownErrors: shutdownErrors.map((item) => describeError(item)), wait: describeError(error),
          starts: provider.counts.starts, recoveries: provider.recoveryCalls, rows })}`,
        { cause: error })
      }
    },
    async close() {
      provider.killAll()
      try {
        await transport.close()
        // Drain all rebuilt runtimes even when one restart closure rejects.
        await Promise.allSettled(runtimes.map((item) => item.engine.shutdown()))
        await base.close()
      } finally {
        for (const item of runtimes) {
          vi.mocked(item.locations.revalidateSnapshot).mockRestore()
          vi.mocked(item.engine.start).mockRestore()
        }
      }
    },
  }
}
export type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>
export const scope = (f: RecoveryFixture, runId = f.base.f.run.id) => ({ workspaceId: f.base.f.scope.workspaceId, runId })
export const runPath = (f: RecoveryFixture, runId = f.base.f.run.id) =>
  `/api/management/workspaces/${encodeURIComponent(f.base.f.scope.workspaceId)}/runs/${encodeURIComponent(runId)}`
export function toolValue(result: { isError?: boolean | undefined; structuredContent?: unknown }, diagnostics?: unknown) {
  expect(result.isError, JSON.stringify({ result, diagnostics })).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
export async function readParity(f: RecoveryFixture, name: RunInspectionToolName, input: Record<string, unknown>,
  client = f.transport.client, token = f.base.writer.token) {
  const { workspaceId, runId, executionId, ...query } = input
  const suffix = name === RUN_INSPECTION_TOOLS.record ? '/record' : name === RUN_INSPECTION_TOOLS.executions ? '/executions'
    : name === RUN_INSPECTION_TOOLS.version ? '/version' : `/executions/${encodeURIComponent(String(executionId))}`
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))
  const response = await f.transport.app.inject({ method: 'GET',
    url: `/api/management/workspaces/${encodeURIComponent(String(workspaceId))}/runs/${encodeURIComponent(String(runId))}${suffix}${params.size ? `?${params}` : ''}`,
    headers: { authorization: `Bearer ${token}` } })
  expect(response.statusCode, JSON.stringify({ body: response.body, diagnostics: response.statusCode !== 200 ? f.diagnostics() : undefined })).toBe(200)
  expect(response.headers['cache-control']).toBe('private, no-store')
  expect(response.headers.vary).toContain('Authorization')
  const result = await client.callTool({ name, arguments: input })
  const mcp = toolValue(result, result.isError ? f.diagnostics() : undefined)
  expect(mcp).toEqual(response.json())
  return mcp
}
export async function executionRows(f: RecoveryFixture, runId = f.base.f.run.id) {
  const rows = (await f.base.db.pool.query<{ record: unknown; slot_id: string; input_json: string; input_digest: string;
    result_json: string | null; result_digest: string | null }>(`select e.record,x.slot_id,s.input_json,s.input_digest,r.result_json,r.result_digest
    from harness_executions e join run_repeat_executions x on x.execution_id=e.id
    join run_repeat_slots s on s.slot_id=x.slot_id left join run_repeat_results r on r.execution_id=e.id
    where e.run_id=$1 order by e.created_at,e.id`, [runId])).rows
  return rows.map((row) => ({ ...row, execution: HarnessExecutionSchema.parse(row.record),
    input: RunAcceptedInputValueSchema.parse(JSON.parse(row.input_json)) }))
}
export async function readback(f: RecoveryFixture, runId = f.base.f.run.id) {
  const record = RunRecordDetailSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.record, scope(f, runId)))
  const persisted = await f.runtime.runs.getRepeatSnapshot(runId)
  const publicRun = WorkflowRunV3Schema.parse(persisted.run); delete publicRun.authorizationPrincipalId
  expect(record).toEqual({ run: publicRun, stopRequested: persisted.stopRequested, cleanupPending: persisted.cleanupPending })
  const page = RunExecutionsPageSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.executions, { ...scope(f, runId), limit: 100 }))
  const rows = await executionRows(f, runId)
  expect(page.pageInfo.nextCursor).toBeNull()
  expect(page.items.map((item) => item.executionId).sort()).toEqual(rows.map((row) => row.execution.id).sort())
  const details: RunExecutionDetail[] = []
  for (const row of rows) {
    const detail = RunExecutionDetailSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.execution,
      { ...scope(f, runId), executionId: row.execution.id }))
    expect(detail.execution).toMatchObject({ executionId: row.execution.id, state: row.execution.state, attempt: row.execution.attempt })
    expect(detail.acceptedInput).toEqual({ digest: row.input_digest, value: row.input })
    expect(detail.reportedResult).toEqual(row.execution.result)
    expect(detail.acceptedResult).toEqual(row.result_json === null ? { status: 'not_accepted' }
      : { status: 'accepted', digest: row.result_digest, value: JSON.parse(row.result_json) })
    if (row.input.occurrence) expect(detail.execution.occurrence).toEqual(row.input.occurrence.identity)
    else expect(detail.execution).not.toHaveProperty('occurrence')
    details.push(detail)
  }
  return { record, page, details }
}
export async function fullRunInput(f: RecoveryFixture) {
  // The inherited fixture seeds a synthetic filesystem identity. A NEW Start
  // must revalidate a real accepted location, not borrow the old Run's snapshot.
  expect(f.runtime.locations.runnerId).toBe(f.base.f.run.executionLocation!.runnerId)
  const location = toolValue(await f.transport.client.callTool({ name: 'workspace_location_set', arguments: {
    workspaceId: f.base.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
    runnerId: f.runtime.locations.runnerId, rootPath: f.base.db.directory,
  } })) as { locationRevision?: number; value?: { locationRevision: number } }
  const locationRevision = location.value?.locationRevision ?? location.locationRevision
  expect(Number.isInteger(locationRevision)).toBe(true)
  const row = (await f.base.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.base.f.scope.workflowId])).rows[0]!
  return RunStartV3InputSchema.parse({ workspaceId: f.base.f.scope.workspaceId, workflowId: f.base.f.scope.workflowId,
    workflowVersionId: f.base.f.version.id, executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: Number(row.revision),
    expectedAgentConfigurationVersionIds: f.base.f.version.agentConfigurationVersionIds,
    expectedLocationRevision: locationRevision, input: f.base.f.run.input })
}

/** An original failure is not interchangeable with synthesized interruption.
 * Keep this assertion before any restart; changing it to retryable:false would
 * hide a regression in the real two-attempt policy. */
export async function assertOriginalFailure(f: RecoveryFixture, executionId: string, retryable: boolean) {
  const expected = f.provider.originalResult(executionId)
  expect(expected, JSON.stringify({ executionId, reason: 'Provider completion missing', diagnostics: f.diagnostics() })).toMatchObject({ outcome: 'failed',
    error: { code: 'ENG06_NATIVE_FAILURE', retryable } })
  const execution = await f.runtime.runs.getExecution(executionId)
  expect(execution?.result, JSON.stringify({ executionId, reason: 'Original result changed', actual: execution?.result, diagnostics: f.diagnostics() })).toEqual(expected)
  const sources = (await f.base.db.pool.query<{ result: unknown }>(`select
    record#>'{original,history,terminalTurn,result}' as result from workflow_native_proofs
    where execution_id=$1 and record#>>'{original,type}'='history'
      and record#>>'{original,history,terminalTurn,result,outcome}'='failed'`, [executionId])).rows
  expect(sources.map((row) => row.result), `Missing original failure capture for ${executionId}`).toContainEqual(expected)
}

/** Reads actual coordinator-created recovery receipts. No fixture INSERT or
 * UPDATE is permitted for closures, recoveries, results, attempts or Run state. */
export async function assertRecoveryReceipts(f: RecoveryFixture, executionIds: readonly string[],
  options: { detached?: boolean } = {}) {
  const detached = options.detached ?? true
  const rows = (await f.base.db.pool.query<{
    execution_id: string; generation: string; latest_generation: string;
    execution_identity: { id: string; runId: string }; reference: unknown; native_reference: unknown;
    detached_reference: unknown; closed: boolean; detached: boolean; owner_id: string; owner_fence: string;
  }>(`select p.execution_id,p.generation::text,p.execution_identity,p.reference,p.owner_id,p.owner_fence,
    c.closed_at is not null as closed,c.detached_at is not null as detached,c.detached_reference,
    s.reference as native_reference,
    (select max(n.generation)::text from execution_native_closures n where n.execution_id=e.id) as latest_generation
    from execution_native_recoveries p join harness_executions e on e.id=p.execution_id
    join execution_native_closures c on c.generation=p.generation
    join execution_native_sessions s on s.execution_id=e.id where e.run_id=$1 order by p.execution_id`, [f.base.f.run.id])).rows
  expect(rows.map((row) => row.execution_id).sort()).toEqual([...executionIds].sort())
  for (const row of rows) {
    expect(row.execution_identity).toMatchObject({ id: row.execution_id, runId: f.base.f.run.id })
    expect(row.generation).toBe(row.latest_generation)
    expect(row.reference).toEqual(row.native_reference)
    expect(row.detached_reference).toEqual(detached ? row.reference : null)
    // Recovery adds a separate receipt. It cannot rewrite an original detach
    // as a close, create a new native generation, or invent a provider terminal.
    expect(row.detached).toBe(detached); expect(row.closed).toBe(false)
    expect(row.owner_id).toMatch(/^\d+$/); expect(row.owner_fence).toMatch(/^\d+$/)
  }
  expect(new Set(f.provider.recoveryCalls)).toEqual(new Set(executionIds))
}
