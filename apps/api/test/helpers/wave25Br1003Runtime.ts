import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { bindRunAuthority, currentOperatorAuthority, type AcceptedRunAuthority } from '../../src/modules/access/runAuthority.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import type pg from 'pg'
import { AcceptedRepeatStartV1Schema } from '@foreman-code/contracts/wave25'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../../src/modules/access/workerCredentials.js'
import { Wave25WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider, type NativeMcpInspector } from '../../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import { DomainError } from '../../src/modules/errors.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../../src/modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from '../../src/modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import type { RepeatRepositoryServices } from '../../src/modules/runs/repeatRepositoryHost.js'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { ExecutionScopedNativeSessionManagerResolver, type NativeManagerResolutionContext } from '../../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { registerApprovalCheckpointResume } from '../../src/modules/runs/approvalCheckpointRegistration.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { LOCAL_RUNNER_ID, WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { CheckpointTestProvider } from './wave25Br1003Provider.js'
import { approvalFixture } from './wave25ApprovalFixture.js'

/** Production-class composition at the provider port. Actual migrations, Run
 * owner, repository, coordinator, delivery service, engine, saver and atomic
 * registration are retained. Only provider transport and filesystem identity
 * qualification are synthetic. This is not a buildProductionApp/HTTP test. */
export async function checkpointRuntimeFixture(branches: 1 | 2 = 1, pendingPerExecution: 1 | 2 = 1,
  options: { databaseUrl?: string;
    /** A suite-owned database; the caller closes it after all runtimes shut down. */
    database?: Awaited<ReturnType<typeof agent3Database>>;
    acknowledgeStarts?: boolean; disconnectAfterStart?: boolean; fixture?: ReturnType<typeof makeCurrentWorkflowFixture>;
    nativeSourcePersisted?: Parameters<typeof createWorkflowRepositoryServices>[2];
    nativeCommitted?: ConstructorParameters<typeof PostgresRunRepository>[4];
    approvalNodeIds?: string[]; insertRun?: boolean; workerParallelism?: number; credentialTtlMs?: number;
    onRunTerminal?: ConstructorParameters<typeof LangGraphWorkflowEngine>[8];
    outputFor?: ConstructorParameters<typeof CheckpointTestProvider>[4];
    admitPlacementExecutionLocked?: RepeatRepositoryServices['admitPlacementExecutionLocked'];
    preparePlacementExecution?: RepeatRepositoryServices['preparePlacementExecution'];
    /** Exact physical closure port; omitted unless a fixture supplies native lifetimes. */
    recoverNativeProcesses?: ConstructorParameters<typeof ApprovalExecutionCoordinator>[11];
    managerFactory?: (context: NativeManagerResolutionContext,
      owner: () => RunOwnership | undefined) => NativeHarnessSessionManager;
    prepareManagerContext?: ConstructorParameters<typeof ApprovalExecutionCoordinator>[13];
    validateContinuation?: ReturnType<typeof continuationValidator>;
    mcpInspector?: (manager: NativeHarnessSessionManager) => NativeMcpInspector } = {}) {
  const db = options.database ?? await agent3Database(options.databaseUrl)
  const engines: LangGraphWorkflowEngine[] = []
  try {
    const f = options.fixture ?? makeCurrentWorkflowFixture(randomUUID())
    // Routed approvals require persistent sessions. Native approval fixtures
    // retain their explicitly configured policy and sandbox.
    if (f.version.definition.approval?.handler !== 'native') {
      f.configurations = f.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
        ...configuration, harness: structuredClone(approvalFixture().configurations[1]!.harness),
      }))
    }
    if (branches === 2) {
      const original = f.configurations[1]!, existingNode = f.version.definition.nodes[1]!
      const configuration = AgentConfigurationVersionSchema.parse({ ...original, id: `${original.id}-parallel`, agentId: `${original.agentId}-parallel` })
      const node = { ...existingNode, id: `${existingNode.id}-parallel`, agentId: configuration.agentId }
      f.configurations.push(configuration)
      f.version.definition.nodes.push(node)
      f.version.definition.edges.push({ id: `parallel-${randomUUID()}`, kind: 'execution', source: f.version.entryNodeId, target: node.id })
      f.version.agentConfigurationVersionIds[configuration.agentId] = configuration.id
      f.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 3 }
    }
    f.version = agentWorkflowVersion(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version)
    f.run = WorkflowRunV3Schema.parse({ ...f.run, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds })
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const access = new PostgresAccessService(db.pool)
    const accepted = await access.issue({ name: 'Checkpoint test Run authority', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [
        { actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] } },
        { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } },
      ] })
    f.run = WorkflowRunV3Schema.parse({ ...f.run, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      authorizationPrincipalId: accepted.principal.id })
    if (options.insertRun !== false) await insertProviderRun(db.pool, f)
    const user = await access.issue({ name: 'Checkpoint test approver', audience: 'user', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id] } }] })
    const provider = new CheckpointTestProvider(new Set(options.approvalNodeIds ?? f.version.definition.nodes.filter((node) => node.id !== f.version.entryNodeId).map((node) => node.id)),
      pendingPerExecution, options.acknowledgeStarts !== false, options.disconnectAfterStart === true, options.outputFor)
    const saver = new ApprovalPostgresSaver(db.pool, undefined, { schema: db.schema })
    await saver.setup()
    function compose(checkpointer: ApprovalPostgresSaver = saver) {
      const workflows = new PostgresWorkflowRepository(db.pool)
      const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool),
        undefined, f.run.executionLocation!.runnerId)
      // No native binaries or accepted runner filesystem are qualified here.
      // Keep SQL authorization real, including its accepted/root grant checks.
      vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
      const workflowCapture = createWorkflowNativeCaptureChannel()
      const reviewCapture = createReviewNativeCaptureChannel()
      const repositoryServices = createWorkflowRepositoryServices(workflowCapture.verify, undefined, options.nativeSourcePersisted)
      const runs = new PostgresRunRepository(db.pool, workflows, locations,
        { runtimeRoot: db.directory, ...repositoryServices, services: { ...repositoryServices.services,
          ...(options.preparePlacementExecution ? { preparePlacementExecution: options.preparePlacementExecution } : {}),
          ...(options.admitPlacementExecutionLocked
            ? { admitPlacementExecutionLocked: options.admitPlacementExecutionLocked } : {}) } },
        options.nativeCommitted)
      const repository = new Wave25InteractionRepository(db.pool, new ReviewNativeProofServices(reviewCapture.verify)), budgets = new PostgresApprovalBudgetRepository(db.pool)
      const managers = new ExecutionScopedNativeSessionManagerResolver((context, owner) =>
        options.managerFactory ? options.managerFactory(context, owner) : provider.connection())
      const credentials = new Wave25WorkerCredentialService(db.pool, access, options.credentialTtlMs)
      // This helper's external provider is deterministic. Its configuration
      // inspector is the same explicit synthetic boundary as its transport.
      const validate = options.validateContinuation ?? continuationValidator(db.pool, locations)
      const launchCredentials = providerLaunchCredentials(runs, locations, managers, credentials, options.mcpInspector ?? (() => ({
        async inspect(input) { return { harness: input.harness, providerVersion: '0.154.0',
          runnerId: input.runnerId, workingDirectory: input.workingDirectory, inspectedAt: new Date().toISOString(),
          entry: { name: input.serverName, transport: 'streamable-http', endpoint: providerAppEndpoint,
            enabled: true, credentialEnvironmentVariable: APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, status: 'connected' } } },
      })), db.pool, { prepareContext: options.prepareManagerContext, validateContinuation: validate })
      const native = new ApprovalExecutionCoordinator(runs, repository, budgets, managers, 600000,
        launchCredentials, validate,
        new PostgresWorkflowClosureStore(db.pool), new PostgresRepeatReviewerBindings(db.pool),
        workflowCapture.capture, reviewCapture.capture, options.recoverNativeProcesses,
        undefined, options.prepareManagerContext)
      const engine = new LangGraphWorkflowEngine(runs, workflows, native, checkpointer, db.directory,
        locations, launchCredentials, repository, options.onRunTerminal,
        { workerParallelism: options.workerParallelism ?? 2 })
      const service = new InteractionService(repository, budgets, native, (interaction) => engine.resumeInteraction(interaction),
        undefined, (interaction) => native.inspectInteractionActivity(interaction))
      registerApprovalCheckpointResume(service, engine)
      engines.push(engine)
      return { engine, service, repository, runs, native, locations, workflows, checkpointer }
    }
    const runtime = compose()
    const config = { configurable: { thread_id: f.run.id } }
    async function pending() {
      return (await runtime.repository.list({ runId: f.run.id, limit: 100 })).sort((a, b) => a.id.localeCompare(b.id))
    }
    async function receipts() {
      return (await db.pool.query(`select entity_id,effect_digest,first_sequence::text from run_graph_effects
        where run_id=$1 and effect_kind='graph.resume' order by entity_id`, [f.run.id])).rows
    }
    async function writes() { return (await saver.getTuple(config))?.pendingWrites ?? [] }
    return { db, f, ...runtime, compose, saver, provider, config, pending, receipts, writes,
      principal: user.principal, authorizationPrincipalId: accepted.principal.id,
      stop: () => stopProviderRun(runtime.runs, f, accepted.principal.id),
      async close() {
        // Shutdown runs before ending their pools; all timing gates in the test
        // must be released in finally blocks before entering fixture cleanup.
        try { for (const engine of engines.reverse()) await engine.shutdown() }
        finally {
          if (!options.database) await db.close()
        }
      } }
  } catch (error) {
    try {
      for (const engine of engines.reverse()) await engine.shutdown()
    } finally {
      if (!options.database) await db.close()
    }
    throw error
  }
}

export const providerAppEndpoint = 'http://127.0.0.1:4100/mcp/app'

/** Canonical insertion after seedAgent3 has published through typed Save. */
export async function insertProviderRun(pool: pg.Pool, fixture: ReturnType<typeof makeCurrentWorkflowFixture>,
  authority?: AcceptedRunAuthority) {
  const { run, version } = fixture
  const row = (await pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [version.workflowId])).rows[0]
  if (!row) throw new Error('Provider fixture requires a saved workflow')
  const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: {
    request: { workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: version.id,
      executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: Number(row.revision),
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      expectedLocationRevision: run.executionLocation!.locationRevision, input: run.input },
    authorizationPrincipalId: run.authorizationPrincipalId,
    executable: { version, configurations: fixture.configurations },
    workflow: { id: run.workflowId, workspaceId: run.workspaceId, revision: Number(row.revision),
      currentVersionId: version.id, archived: false, definition: version.definition },
    workspace: { id: run.workspaceId, archived: false, location: run.executionLocation }, draft: null,
  } })
  await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const admitted = await insertRepeatRun(sql, accepted, repeatStartPublication)
    if (authority) await bindRunAuthority(sql as unknown as pg.PoolClient, admitted.id, authority)
    return admitted
  }))
}

/** Production credential validation and issuance with a provider-specific inspector. */
export function providerLaunchCredentials(runs: PostgresRunRepository, locations: WorkspaceLocationService,
  managers: ExecutionScopedNativeSessionManagerResolver, credentials: Wave25WorkerCredentialService,
  inspector: (manager: NativeHarnessSessionManager) => NativeMcpInspector, pool: pg.Pool,
  options: {
    prepareContext?: ((context: NativeManagerResolutionContext) => Promise<NativeManagerResolutionContext>) | undefined
    validateContinuation?: ReturnType<typeof continuationValidator> | undefined
  } = {}): ExecutionCredentialProvider {
  const validate = options.validateContinuation ?? continuationValidator(pool, locations)
  return {
    async prepare(input) {
      await validate(input.executionId, input.signal)
      const execution = await runs.getExecution(input.executionId)
      if (!execution || execution.workingDirectory !== input.workingDirectory) throw new DomainError(
        'WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the accepted directory.', 409)
      const configuration = await runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      const run = await runs.get(execution.runId)
      if (!configuration || configuration.agentId !== execution.agentId || configuration.harness.harness !== input.harness
        || !run?.executionLocation || run.executionLocation.runnerId !== LOCAL_RUNNER_ID) throw new DomainError(
        'WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the pinned local execution.', 409)
      const context: NativeManagerResolutionContext = { executionId: execution.id, agentId: execution.agentId,
        harness: input.harness, workingDirectory: input.workingDirectory, configuration,
        runId: execution.runId, attempt: execution.attempt, ...(input.purpose ? { purpose: input.purpose } : {}) }
      const { manager } = managers.resolve(options.prepareContext ? await options.prepareContext(context) : context)
      return new WorkerLaunchCredentialService(new McpDetectionService(inspector(manager), providerAppEndpoint),
        credentials, run.executionLocation.runnerId, Math.min(300_000, credentials.ttlMs - 30_000)).prepare(input)
    },
    revoke: (credential) => credentials.revoke(credential),
    revokeForExecution: (id) => credentials.revokeForExecution(id),
    revokeForRun: (id, client) => credentials.revokeForRun(id, client),
    reconcileTerminalCredentials: () => credentials.reconcileTerminalCredentials(),
    renew: (id, credential) => credentials.renewForExecution(id, credential),
    restore: (id, environment) => credentials.restoreForExecution(id, environment),
  }
}

export async function stopProviderRun(runs: PostgresRunRepository,
  fixture: ReturnType<typeof makeCurrentWorkflowFixture>, principalId: string) {
  await runs.requestStop(fixture.run.id, async (sql) => {
    await sql.query('select id from management_principals where id=$1 for share', [principalId])
    const live = await currentOperatorAuthority(sql as unknown as Pick<pg.Pool, 'query'>, principalId)
    requireAuthorization(live.principal, 'runs:stop', { workspaceId: fixture.run.workspaceId,
      workflowId: fixture.run.workflowId, runId: fixture.run.id })
  })
}
