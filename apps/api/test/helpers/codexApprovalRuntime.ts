import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { insertProviderRun, providerLaunchCredentials, stopProviderRun } from './wave25Br1003Runtime.js'
import { codexMcpInspectorAdapter } from '../../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../../src/modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from '../../src/modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  DEFAULT_HARNESS_DEFAULTS, type ResolvedSkill, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { ApprovalPostgresSaver } from '../../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { Wave25WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { registerApprovalCheckpointResume } from '../../src/modules/runs/approvalCheckpointRegistration.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { CodexApprovalProvider, type ApprovalProviderOptions } from './codexApprovalProvider.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import type { RepeatRepositoryServices } from '../../src/modules/runs/repeatRepositoryHost.js'

/** Real SQL, workflow engine, Codex adapter, credentials and approval services with replayed provider IO. */
export async function codexApprovalRuntime(handler: 'user' | 'orchestrator' = 'user',
  options: ApprovalProviderOptions & {
    fixture?: ReturnType<typeof makeCurrentWorkflowFixture>
    reviewerRole?: 'orchestrator' | 'master'
    approvalPolicy?: 'never'
    skills?: ResolvedSkill[]
    database?: Awaited<ReturnType<typeof agent3Database>>
    sandbox?: CodexHarnessConfiguration['sandbox']
    preparePlacementExecution?: RepeatRepositoryServices['preparePlacementExecution']
  } = {}) {
  const db = options.database ?? await agent3Database()
  let engine: LangGraphWorkflowEngine | undefined
  const engines: LangGraphWorkflowEngine[] = []
  const adapters: CodexAppServerSessionManager[] = []
  try {
    const f = options.fixture ?? makeCurrentWorkflowFixture(randomUUID())
    const entry = f.version.definition.nodes.find((node) => node.id === f.version.entryNodeId)!
    const approval = handler === 'user' ? { handler } : { handler, designatedOrchestratorAgentId: entry.agentId }
    f.configurations = f.configurations.map(c => AgentConfigurationVersionSchema.parse({ ...c,
      productRole: approvalRole(c),
      harness: {
        ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'test-model', reasoningEffort: 'low',
        sandbox: options.sandbox ?? 'read-only', serviceTier: 'standard',
        advanced: {
          ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION),
          approvalPolicy: options.approvalPolicy ?? 'on-request',
          approvalsReviewer: handler === 'orchestrator' && c.agentId === entry.agentId ? 'auto_review' : 'user',
          webSearch: 'disabled',
        },
      },
    }))
    function approvalRole(configuration: (typeof f.configurations)[number]) {
      if (handler === 'orchestrator' && configuration.agentId === entry.agentId) {
        return options.reviewerRole ?? 'orchestrator'
      }
      return options.reviewerRole === 'master' ? configuration.productRole : 'coder'
    }
    f.version.approval = approval
    f.version.definition.approval = approval
    if (handler === 'orchestrator') for (const node of f.version.definition.nodes) {
      if (node.id !== entry.id) f.version.definition.edges.push({ id: `approval-${node.id}`,
        kind: 'approval', source: entry.id, target: node.id })
    }
    f.version = agentWorkflowVersion(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version)
    f.run = WorkflowRunV3Schema.parse({ ...f.run, approval, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds })
    await seedAgent3(db.pool, db.directory, f, { run: false, ...(options.skills ? { skills: options.skills } : {}) })
    const access = new PostgresAccessService(db.pool)
    const authority = await access.issue({ name: 'Approval Run authority', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [
        { actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] } },
        { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } },
      ] })
    f.run = WorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: authority.principal.id })
    await insertProviderRun(db.pool, f)
    const user = await access.issue({ name: 'Approval user', audience: 'user', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: {
        workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id],
      } }] })
    const providers = new Map<string, CodexApprovalProvider>()
    const saver = new ApprovalPostgresSaver(db.pool, undefined, { schema: db.schema })
    await saver.setup()
    function compose(checkpointer = saver) {
      const managers = new ExecutionScopedNativeSessionManagerResolver((context) => {
        let provider = providers.get(context.executionId)
        if (!provider) {
          const configuration = f.configurations.find(candidate => candidate.agentId === context.agentId)!
          const completesWorkflowTurn = context.agentId === entry.agentId
            || options.reviewerRole === 'master' && configuration.productRole === 'orchestrator'
          provider = new CodexApprovalProvider(context.executionId, completesWorkflowTurn, options)
          for (const previous of providers.values()) {
            for (const [id, thread] of previous.threads) provider.threads.set(id, thread)
          }
          providers.set(context.executionId, provider)
        }
        const native = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
          undefined, 'scoped', undefined, provider.dependencies())
        adapters.push(native)
        return native
      })
      const workflows = new PostgresWorkflowRepository(db.pool)
      const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool))
      vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
      const workflowCapture = createWorkflowNativeCaptureChannel()
      const nativeCapture = { capture: workflowCapture.capture.capture.bind(workflowCapture.capture) }
      const reviewCapture = createReviewNativeCaptureChannel()
      const repositoryServices = createWorkflowRepositoryServices(workflowCapture.verify)
      const runs = new PostgresRunRepository(db.pool, workflows, locations,
        { runtimeRoot: db.directory, ...repositoryServices, services: { ...repositoryServices.services,
          ...(options.preparePlacementExecution ? { preparePlacementExecution: options.preparePlacementExecution } : {}) } })
      const repository = new Wave25InteractionRepository(db.pool, new ReviewNativeProofServices(reviewCapture.verify)), budgets = new PostgresApprovalBudgetRepository(db.pool)
      const credentials = new Wave25WorkerCredentialService(db.pool, access)
      const launchCredentials = providerLaunchCredentials(runs, locations, managers, credentials, (manager) => {
        if (!(manager instanceof CodexAppServerSessionManager)) throw new Error('Expected Codex native manager')
        return codexMcpInspectorAdapter(manager)
      }, db.pool)
      const native = new ApprovalExecutionCoordinator(runs, repository, budgets, managers, 600000,
        launchCredentials, continuationValidator(db.pool, locations),
        new PostgresWorkflowClosureStore(db.pool), new PostgresRepeatReviewerBindings(db.pool),
        nativeCapture, reviewCapture.capture)
      const activeEngine = new LangGraphWorkflowEngine(runs, workflows, native, checkpointer, db.directory,
        locations, launchCredentials, repository, undefined, { workerParallelism: 2 })
      engines.push(activeEngine)
      const service = new InteractionService(repository, budgets, native, (i) => activeEngine.resumeInteraction(i))
      registerApprovalCheckpointResume(service, activeEngine)
      return { engine: activeEngine, native, runs, repository, service, credentials, locations, workflows,
        nativeCapture, nativeVerification: workflowCapture.verify }
    }
    const runtime = compose()
    engine = runtime.engine
    const config = { configurable: { thread_id: f.run.id } }
    return { db, f, ...runtime, compose, saver, config, providers, access,
      principal: user.principal, authorizationPrincipalId: authority.principal.id,
      stop: () => stopProviderRun(runtime.runs, f, authority.principal.id),
      async pending() { return runtime.repository.list({ runId: f.run.id, limit: 100 }) },
      async receipts() { return (await db.pool.query(`select entity_id,effect_digest,first_sequence::text
        from run_graph_effects where run_id=$1 and effect_kind='graph.resume' order by entity_id`, [f.run.id])).rows },
      counts() {
        const values = [...providers.values()]
        return {
          sessions: new Set(values.flatMap(provider => [...provider.threads.keys()])).size,
          prompts: values.reduce((count, provider) => count + provider.starts.length, 0),
          responses: values.reduce((count, provider) => count + provider.responses.length, 0),
        }
      },
      async close() {
        try { for (const item of engines.reverse()) await item.shutdown() }
        finally {
          try {
            for (const adapter of adapters) await adapter.shutdown()
            for (const provider of providers.values()) await provider.flush()
          } finally {
            if (!options.database) await db.close()
          }
        }
      } }
  } catch (error) {
    try { await engine?.shutdown() } finally {
      try { for (const adapter of adapters) await adapter.shutdown() } finally {
        if (!options.database) await db.close()
      }
    }
    throw error
  }
}
