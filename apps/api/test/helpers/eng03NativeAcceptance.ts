import { workerToolServices } from './workerMcpServices.js'
import { publicationSignal } from './publicationSignal.js'
import { describeNativeFailure, nativeFailureSummary } from './nativeFailureEvidence.js'
import { NativeHarnessFactories } from '../../src/modules/harnesses/runtimeFactory.js'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../../src/infrastructure/runtimeTiming.js'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl, ownedTestPath, removeFixtureDirectory } from './testResources.js'
import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import pg from 'pg'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import {
  AgentConfigurationVersionSchema, DurableInteractionSchema, HarnessConfigurationSchema, HarnessExecutionSchema,
  type AgentConfigurationVersion, type ExecutionResult, type HarnessConfiguration, type HarnessExecution, type HarnessNativeEvent, type NativeSessionReference,
} from '@foreman-code/contracts'
import {
  ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService as WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from '../../src/modules/harnesses/mcpDetection.js'
import { codexMcpInspectorAdapter } from '../../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { Wave25InteractionRepository } from '../../src/modules/interactions/wave25/repository.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { buildApp } from '../../src/app.js'
import { PostgresAppInteractionService } from '../../src/modules/interactions/app.js'
import { PostgresInteractionRepository } from '../../src/modules/interactions/postgres.js'
import { AppMcpRoutes } from '../../src/modules/harnesses/appMcpRoutes.js'
import { repeatDigest, sameRepeatValue, type RepeatNodeInput, type RepeatInputBinding } from '../../src/modules/runs/repeatResolution.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { admitRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../../src/modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from '../../src/modules/interactions/reviewNativeProof.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { readLiveManagementPrincipal } from '../../src/modules/access/liveManagementPrincipal.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { nativePersistenceRedactor } from '../../src/modules/interactions/nativePersistence.js'
import type { NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import type { AuthorizeWorkflowStop } from '../../src/modules/runs/repeatLifecycle.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { seedAgent3 } from './wave25Agent3.js'
import { configureNativeWorkflowMcp } from './nativeWorkflowMcp.js'
import { harnessBinaries } from '../../src/modules/harnesses/binaries.js'
import { configureNativeAcceptanceMcp } from './nativeAcceptanceMcp.js'
import { archiveNativeAcceptanceEvidence } from './nativeAcceptanceEvidence.js'
import { inheritedAgentEnvironment } from '../../src/modules/harnesses/secrets.js'
import { runCommand as runNativeCommand } from '../../src/modules/harnesses/process.js'
import { completeTestResourceCleanup, registerTestResourceCleanup } from '../../../../scripts/test-resources.mjs'

const runCommand = promisify(execFile)
type Harness = 'codex'
type Scenario = 'E03-P01' | 'E03-P02' | 'E03-P03' | 'E03-L01' | 'E03-L02' | 'E03-L03' | 'E03-L04' | 'E03-A01'
export function nativeAcceptanceBinaries(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.FOREMAN_CODE_VERIFICATION_ROOT
    && !environment.ENG03_A_CODEX_BINARY) {
    throw new Error('Acceptance Jobs require an explicitly qualified in-image Codex binary.')
  }
  const { codexBinary } = harnessBinaries({
    CODEX_BINARY: environment.ENG03_A_CODEX_BINARY ?? environment.CODEX_BINARY,
  })
  return { codexBinary }
}

export interface Eng03NativeRuntime {
  engine: LangGraphWorkflowEngine
  runs: PostgresRunRepository
  approvals: ApprovalExecutionCoordinator
  interactions: Wave25InteractionRepository
  budgets: PostgresApprovalBudgetRepository
  registry: NativeProcessRegistry
}

export interface Eng03NativeControl extends Eng03NativeRuntime {
  pool: pg.Pool
  runId: string
  nodeIds: readonly string[]
  projectDirectory: string
  runtimeDirectory: string
  artifactPath: string
  startTask: Promise<void>
  publicationChanged(): Promise<void>
  stop(): Promise<boolean>
  restartWaitingRuntime(): Promise<Eng03NativeRuntime>
  restartRecoverableRuntime(): Promise<Eng03NativeRuntime>
}

export interface Eng03NativeOptions {
  prompts?: Partial<Record<'Entry' | 'A' | 'B' | 'Reviewer', string>>
  harnessOverrides?: Partial<Record<'A' | 'B', HarnessConfiguration>>
  queryTimeoutMs?: number
  control?: (context: Eng03NativeControl) => Promise<void>
}

interface RuntimeInstance extends Eng03NativeRuntime {
  managers: ExecutionScopedNativeSessionManagerResolver
  factories: NativeHarnessFactories
}

interface NativeScenarioResult {
  artifactPath: string
  outcome: 'succeeded' | 'failed'
  overlap: boolean
  identitiesDistinct: boolean
  joinExact: boolean
  cleanup: boolean
}

interface NativeInterval {
  executionId: string
  nativeSessionId: string
  providerVersion: string
  start: { type: string; occurredAt: string; sequence: number }
  finish: { type: string; occurredAt: string; sequence: number }
}

function nativeInterval(execution: HarnessExecution, providerVersion: string,
  events: HarnessNativeEvent[]): NativeInterval | undefined {
  const session = execution.nativeSessionId
  if (!session) return undefined
  const own = events.filter((event) => event.executionId === execution.id)
  const started = own.find(event => event.type === 'turn.started' && event.payload.threadId === session)
  const finished = [...own].reverse().find(event => event.type === 'turn.completed' && event.payload.threadId === session)
  if (!started || !finished || Date.parse(started.occurredAt) >= Date.parse(finished.occurredAt)) return undefined
  return { executionId: execution.id, nativeSessionId: session, providerVersion,
    start: { type: started.type, occurredAt: started.occurredAt, sequence: started.sequence },
    finish: { type: finished.type, occurredAt: finished.occurredAt, sequence: finished.sequence } }
}

function resultText(execution: HarnessExecution | undefined): string {
  const output = execution?.result?.output
  return typeof output === 'string' ? output : output && typeof output === 'object' && 'text' in output
    && typeof output.text === 'string' ? output.text : ''
}

async function version(binary: string, directory: string, registry: NativeProcessRegistry): Promise<string> {
  const scope = await registry.reserveLaunch(`acceptance-version:${randomUUID()}`)
  const errors: unknown[] = []
  let observed = ''
  try {
    const result = await runNativeCommand(binary, ['--version'], directory, AbortSignal.timeout(10_000),
      inheritedAgentEnvironment(), { recovery: scope })
    if (result.exitCode !== 0) throw new Error('Native acceptance version probe failed')
    observed = result.stdout.trim()
  } catch (error) { errors.push(error) }
  try {
    await registry.abandonReservedLaunch(scope)
    if (!await registry.closeOwner(scope.owner)) throw new Error('Native version probe closure remains unconfirmed')
  } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Native version probe and closure failed.')
  return observed
}

/** Opt-in live-provider qualification through current V3 admission and native proof composition. */
export async function runEng03NativeScenario(scenario: Scenario, first: Harness, second: Harness,
  options: Eng03NativeOptions = {}) {
  if (options.queryTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.queryTimeoutMs) || options.queryTimeoutMs < 1 || options.queryTimeoutMs > 60_000)) {
    throw new Error('queryTimeoutMs must be a positive integer at most 60000.')
  }
  const publicationChanges = publicationSignal()
  const scenarioBegan = performance.now()
  const timing = { startedAt: new Date().toISOString(), setupMs: 0, engineMs: 0, totalMs: 0 }
  const { codexBinary } = nativeAcceptanceBinaries()
  const baseUrl = ownedTestDatabaseUrl('ENG03_A_TEST_DATABASE_URL')
  if (!baseUrl) throw new Error('ENG03_A_TEST_DATABASE_URL must name a task-owned loopback test database.')
  const parsed = new URL(baseUrl)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(parsed.pathname.slice(1)))
    || parsed.search || parsed.hash) {
    throw new Error('ENG03_A_TEST_DATABASE_URL must use a loopback database named for tests.')
  }
  const suffix = randomUUID().replaceAll('-', '')
  const schema = `eng03_a_${suffix}`
  const root = await mkdtemp(join(tmpdir(), `eng03-a-${scenario.toLowerCase()}-`))
  const projectDirectory = join(root, 'project')
  const runtimeDirectory = join(root, 'runtime')
  const registryDirectory = join(runtimeDirectory, 'native-process-registry')
  const artifactPath = join(process.env.ENG03_A_EVIDENCE_DIR!, `${scenario}-${suffix}.json`)
  await Promise.all([mkdir(projectDirectory), mkdir(registryDirectory, { recursive: true, mode: 0o700 }),
    mkdir(join(artifactPath, '..'), { recursive: true })])
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const cleanupId = registerTestResourceCleanup(invocation,
    { kind: 'native-acceptance', root, schema, databaseUrl: baseUrl, registryDirectory, artifactPath })
  const registry = new NativeProcessRegistry(registryDirectory)
  const cleanupErrors: unknown[] = []
  let failure: { error: unknown } | undefined
  let result: NativeScenarioResult | undefined
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 })
  let pool: pg.Pool | undefined
  let checkpoints: ReturnType<typeof createCheckpointStore> | undefined
  let engine: LangGraphWorkflowEngine | undefined
  let activeRuntime: RuntimeInstance | undefined
  let mcpApp: ReturnType<typeof buildApp> | undefined
  let mcpRoutes: AppMcpRoutes | undefined
  let restoreNativeMcp: (() => Promise<void>) | undefined
  let runId: string | undefined
  let stopRun: (() => Promise<boolean>) | undefined
  const runtimeTimeline: RuntimeTimingRecord[] = []
  const nativeSecrets = Object.entries(process.env).filter(([name]) => /TOKEN|KEY|PASSWORD|SECRET/.test(name))
    .map(([, value]) => value).filter((value): value is string => Boolean(value))
  let droppedTimingRecords = 0
  const captureTiming = (message: unknown) => {
    if (runtimeTimeline.length < 100_000) runtimeTimeline.push(message as RuntimeTimingRecord)
    else droppedTimingRecords++
  }
  const evidence: Record<string, unknown> = { scenario, timing, runtimeTimeline, mode: 'current V3 native internal acceptance', artifactPath,
    resources: { invocation, cleanupId, root, schema, registryDirectory },
    models: { codex: process.env.ENG03_CODEX_MODEL ?? 'gpt-6-luna' },
    expected: { overlap: true, joinedInputs: 2, outcome: 'succeeded' } }
  runtimeTimingChannel.subscribe(captureTiming)
  try {
    evidence.sourceSha = (await runCommand('git', ['rev-parse', 'HEAD'])).stdout.trim()
    evidence.binaries = { codex: { path: codexBinary, version: await version(codexBinary, projectDirectory, registry) } }
    await createFixtureSchema(admin, schema)
    const url = new URL(baseUrl)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const migrationPool = new pg.Pool({ connectionString: url.toString(), max: 12, connectionTimeoutMillis: 5000 })
    try { await applyApplicationMigrations(migrationPool) } finally { await migrationPool.end() }
    pool = new pg.Pool({ connectionString: url.toString(), max: 12, connectionTimeoutMillis: 5000,
      ...(options.queryTimeoutMs ? { query_timeout: options.queryTimeoutMs,
        statement_timeout: options.queryTimeoutMs } : {}) })
    checkpoints = createCheckpointStore(url.toString(), schema)
    await checkpoints.setup()
    const fixture = makeCurrentWorkflowFixture(suffix, 'parallel')
    const nodeNames = ['Entry', 'A', 'B', 'Reviewer'] as const
    const harnesses: Harness[] = ['codex', first, second, 'codex']
    const tokens = [`ENTRY-${suffix.slice(0, 6)}`, `A-${suffix.slice(0, 6)}`, `B-${suffix.slice(0, 6)}`]
    const prompts = [
      `Reply with exactly ${tokens[0]}.`,
      `Read the accepted Entry result. Without tools or files, list n and n squared modulo 97 for n=1 through 120, one row per n. Finish with exactly ${tokens[1]}. Keep the response under 3000 characters.`,
      `Read the accepted Entry result. Without tools or files, list n and n cubed modulo 101 for n=1 through 120, one row per n. Finish with exactly ${tokens[2]}. Keep the response under 3000 characters.`,
      'Read only the two accepted predecessor results. Find each final A-/B- marker and return exactly A:<A marker>|B:<B marker>. Do not read or write files.',
    ]
    const configuredPrompts = prompts.map((prompt, index) => options.prompts?.[nodeNames[index]!] ?? prompt)
    const configurations: AgentConfigurationVersion[] = nodeNames.map((name, index) => {
      const fallback = { harness: 'codex', model: (evidence.models as { codex: string }).codex,
        reasoningEffort: process.env.ENG03_CODEX_REASONING_EFFORT ?? 'medium', sandbox: 'read-only', serviceTier: 'standard' }
      const override = name === 'A' || name === 'B' ? options.harnessOverrides?.[name] : undefined
      if (override && override.harness !== harnesses[index]) throw new Error(`Harness override for ${name} changes its provider.`)
      return AgentConfigurationVersionSchema.parse({
        id: `cfg-${suffix}-${index}`, workspaceId: fixture.scope.workspaceId, agentId: `agent-${suffix}-${index}`,
        productRole: 'coder', version: 1, prompt: { system: configuredPrompts[index] }, assignedSkills: [],
        harness: HarnessConfigurationSchema.parse(override ?? fallback),
        contentHash: `sha256:${'0'.repeat(64)}`, createdAt: new Date().toISOString(),
      })
    })
    evidence.effectiveHarnesses = configurations.map(({ agentId, harness }) => {
      if (harness.harness !== 'codex') throw new Error('The native fixture requires Codex configurations.')
      return { agentId, harness: harness.harness, model: harness.model, reasoningEffort: harness.reasoningEffort,
        sandbox: harness.sandbox, approvalPolicy: harness.advanced?.approvalPolicy,
        approvalsReviewer: harness.advanced?.approvalsReviewer }
    })
    const nodes = nodeNames.map((name, index) => ({ id: `node-${suffix}-${index}`, name,
      agentId: configurations[index]!.agentId, ...(index === 0 ? {} : { join: { mode: 'all' as const } }) }))
    const edges = ([[0, 1], [0, 2], [1, 3], [2, 3]] as const).map(([source, target], index) => ({
      id: `edge-${suffix}-${index}`, kind: 'execution' as const, source: nodes[source]!.id, target: nodes[target]!.id,
    }))
    const { version: workflowVersion } = ExecutableWorkflowV3Schema.parse({
      version: { ...fixture.version, entryNodeId: nodes[0]!.id,
        agentConfigurationVersionIds: Object.fromEntries(configurations.map((item) => [item.agentId, item.id])),
        definition: { ...fixture.version.definition, entryNodeId: nodes[0]!.id, nodes, edges,
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 4 } } },
      configurations,
    })
    fixture.configurations = configurations
    fixture.version = agentWorkflowVersion(workflowVersion)
    await seedAgent3(pool, projectDirectory, fixture, { run: false })
    const access = new PostgresAccessService(pool)
    const authority = await access.issue({ name: 'Current native acceptance authority', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [
        { actions: ['runs:start', 'runs:stop', 'runs:read'], scope: { workspaceIds: [fixture.scope.workspaceId], workflowIds: [fixture.scope.workflowId] } },
        { actions: ['workspace_locations:read', 'workspace_locations:update'], scope: { workspaceIds: [fixture.scope.workspaceId] } },
      ] })
    nativeSecrets.push(authority.token)
    const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), runtimeDirectory)
    const location = await locations.set(authority.principal, 'http', { workspaceId: fixture.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: projectDirectory })
    const revision = Number((await pool.query<{ revision: string }>('select revision::text from workflows where id=$1',
      [fixture.scope.workflowId])).rows[0]!.revision)
    const admitted = await admitRepeatRun(pool, locations, await access.authenticate(authority.token), 'http', {
      workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      workflowVersionId: fixture.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
      expectedWorkflowRevision: revision, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
      expectedLocationRevision: location.value.locationRevision, input: fixture.run.input,
    }, repeatStartPublication)
    const run = admitted.value
    fixture.run = run
    runId = run.id
    const authorizeStop: AuthorizeWorkflowStop = async (sql) => {
      const principal = await readLiveManagementPrincipal(sql as unknown as Pick<pg.ClientBase, 'query'>, authority.principal.id)
      requireAuthorization(principal, 'runs:stop', { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id })
    }
    const livePool = pool
    // These credentials belong to this schema, so their actual MCP endpoint
    // must authenticate against this database rather than another live app.
    const mcpCommands = new PostgresCommandCoordinator(livePool)
    mcpApp = buildApp({ readiness: { database: { ping: async () => { await livePool.query('select 1') } },
      checkpoints: { ping: async () => undefined } }, appMcp: workerToolServices(livePool, mcpCommands).appMcp(new PostgresAccessService(livePool),
      new PostgresAppInteractionService(livePool, new PostgresInteractionRepository(livePool), mcpCommands)) })
    const endpoint = `${await mcpApp.listen({ host: '127.0.0.1', port: 0 })}/mcp`
    restoreNativeMcp = await configureNativeWorkflowMcp({
      projectDirectory, runtimeDirectory, codexBinary,
    })
    mcpRoutes = new AppMcpRoutes(livePool, endpoint)
    evidence.mcpEndpoint = endpoint
    await configureNativeAcceptanceMcp(livePool, runtimeDirectory,
      { codex: codexBinary }, endpoint, harnesses)
    const makeRuntime = (saver: BaseCheckpointSaver): RuntimeInstance => {
      const commands = new PostgresCommandCoordinator(livePool)
      const locations = new WorkspaceLocationService(livePool, commands, runtimeDirectory)
      const workflows = new PostgresWorkflowRepository(livePool)
      const workflowCapture = createWorkflowNativeCaptureChannel(), reviewCapture = createReviewNativeCaptureChannel()
      const runs = new PostgresRunRepository(livePool, workflows, locations,
        { runtimeRoot: runtimeDirectory, ...createWorkflowRepositoryServices(workflowCapture.verify) },
        async () => { publicationChanges.notify() })
      const appendNativeEvent = runs.appendNativeEvent.bind(runs)
      const pendingNativeEvents = new Map<string, { executionId: string; type: string; sequence: number; startedAt: string }>()
      runs.appendNativeEvent = async (...args) => {
        const began = performance.now()
        const event = args[0]
        const pendingKey = `${event.executionId}:${event.connectionId ?? ''}:${event.sequence}`
        pendingNativeEvents.set(pendingKey, { executionId: event.executionId, type: event.type,
          sequence: event.sequence, startedAt: new Date().toISOString() })
        evidence.pendingNativeEvents = [...pendingNativeEvents.values()]
        try { return await appendNativeEvent(...args) }
        finally {
          pendingNativeEvents.delete(pendingKey)
          evidence.pendingNativeEvents = [...pendingNativeEvents.values()]
          const stats = (evidence.nativeEventPersistence ??= { count: 0, totalMs: 0, maxMs: 0 }) as {
            count: number; totalMs: number; maxMs: number
          }
          const elapsedMs = Math.round(performance.now() - began)
          stats.count++; stats.totalMs += elapsedMs; stats.maxMs = Math.max(stats.maxMs, elapsedMs)
          if (stats.count % 64 === 0) await writeFile(artifactPath.replace('.json', '-persistence.json'),
            JSON.stringify({ scenario, ...stats })).catch(() => {
              // ignore: Persistence timing is optional telemetry; a failed snapshot must not fail the observed operation.
              return undefined
            })
        }
      }
      const appendNativeEvents = runs.appendNativeEvents.bind(runs)
      runs.appendNativeEvents = async (...args) => {
        const began = performance.now()
        let committed = false
        const pendingKeys = args[0].map(({ event }) => {
          const key = `${event.executionId}:${event.connectionId ?? ''}:${event.sequence}`
          pendingNativeEvents.set(key, { executionId: event.executionId, type: event.type,
            sequence: event.sequence, startedAt: new Date().toISOString() })
          return key
        })
        evidence.pendingNativeEvents = [...pendingNativeEvents.values()]
        try {
          const result = await appendNativeEvents(...args)
          committed = true
          return result
        }
        finally {
          for (const key of pendingKeys) pendingNativeEvents.delete(key)
          evidence.pendingNativeEvents = [...pendingNativeEvents.values()]
          const stats = (evidence.nativeEventBatches ??= { count: 0, frames: 0, totalMs: 0, maxMs: 0 }) as {
            count: number; frames: number; totalMs: number; maxMs: number
          }
          const elapsedMs = Math.round(performance.now() - began)
          stats.count++
          stats.frames += args[0].length
          stats.totalMs += elapsedMs
          stats.maxMs = Math.max(stats.maxMs, elapsedMs)
          const publications = (evidence.nativeBatchPublications ??= []) as unknown[]
          if (publications.length === 128) publications.shift()
          const completedAt = new Date().toISOString()
          publications.push({ executionId: args[0][0]?.event.executionId, frames: args[0].length,
            firstOccurredAt: args[0][0]?.event.occurredAt, lastOccurredAt: args[0].at(-1)?.event.occurredAt,
            completedAt, elapsedMs, committed })
        }
      }
      const interactions = new Wave25InteractionRepository(livePool, new ReviewNativeProofServices(reviewCapture.verify))
      const factories = new NativeHarnessFactories({
        codexBinary,
        auxiliaryRecovery: role => registry.scope(`${role}:${randomUUID()}`),
        admitRecovery: async recovery => { Object.assign(recovery, await registry.reserveLaunch(recovery.owner)) },
        abandonRecovery: async recovery => { await registry.abandonReservedLaunch(recovery) },
        closeRecovery: async recovery => {
          if (!await registry.closeOwner(recovery.owner)) throw new Error('Native diagnostic closure is unconfirmed.')
        },
      })
      const managers = new ExecutionScopedNativeSessionManagerResolver(context => {
        const config = context.configuration.harness
        if (config.harness !== context.harness) throw new Error('Pinned harness mismatch')
        if (config.harness !== 'codex') throw new Error('The native fixture requires a Codex configuration.')
        return factories.allocate({
          harness: config.harness, role: 'workflow', appMcpAccess: 'scoped',
          ownerAgentId: context.agentId, workingDirectory: context.workingDirectory,
          processRecovery: registry.scope(`execution:${context.executionId}`),
          configured: { instanceId: context.configuration.id, instanceRevision: context.configuration.contentHash,
            driverId: config.harness, enabled: true, configuration: config },
        }).manager
      })
      const validateContinuation = continuationValidator(livePool, locations)
      const workerCredentials = new WorkerCredentialService(livePool, new PostgresAccessService(livePool))
      const credentials: ExecutionCredentialProvider = {
        async prepare(input) {
          await validateContinuation(input.executionId, input.signal)
          const execution = await runs.getExecution(input.executionId)
          const configuration = execution && await runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
          if (!execution || !configuration || execution.workingDirectory !== input.workingDirectory
            || configuration.harness.harness !== input.harness) throw new Error('Native execution identity is missing')
          const { manager } = managers.resolve({ executionId: execution.id, agentId: execution.agentId,
            runId: execution.runId, attempt: execution.attempt, ...(input.purpose ? { purpose: input.purpose } : {}),
            harness: input.harness, workingDirectory: input.workingDirectory, configuration })
          if (!(manager instanceof CodexAppServerSessionManager)) throw new Error('The native fixture requires a Codex manager.')
          const inspector = codexMcpInspectorAdapter(manager)
          const diagnosticInspector: typeof inspector = { async inspect(request) {
            const began = performance.now()
            try {
              const inspected = await inspector.inspect(request)
              const entries = (evidence.mcpInspectionEntries ??= []) as unknown[]
              if (entries.length < 16) entries.push({ executionId: input.executionId, phase: request.phase,
                expectedEndpoint: endpoint, ...inspected })
              return inspected
            }
            catch (error) {
              const errors = (evidence.mcpInspectionErrors ??= []) as unknown[]
              if (errors.length < 16) errors.push({ executionId: input.executionId,
                elapsedMs: Math.round(performance.now() - began),
                ...(error instanceof Error ? { name: error.name, message: nativePersistenceRedactor([]).text(error.message) }
                  : { name: typeof error }) })
              throw error
            }
          } }
          const prepared = await new WorkerLaunchCredentialService(new McpDetectionService(diagnosticInspector, endpoint), workerCredentials, 'runner-local').prepare(input)
          await mcpRoutes!.refresh()
          nativeSecrets.push(...Object.values(prepared.credential.environment.variables))
          return prepared
        },
        revoke: (credential) => workerCredentials.revoke(credential),
        revokeForExecution: (id) => workerCredentials.revokeForExecution(id),
        revokeForRun: (id, client) => workerCredentials.revokeForRun(id, client),
        reconcileTerminalCredentials: () => workerCredentials.reconcileTerminalCredentials(),
        renew: (id, credential) => workerCredentials.renewForExecution(id, credential),
      }
      const budgets = new PostgresApprovalBudgetRepository(livePool)
      const approvals = new ApprovalExecutionCoordinator(runs, interactions, budgets,
        managers, 180_000, credentials, validateContinuation, new PostgresWorkflowClosureStore(livePool),
        new PostgresRepeatReviewerBindings(livePool), workflowCapture.capture, reviewCapture.capture)
      const observeExact = approvals.observeExact.bind(approvals)
      approvals.observeExact = async (input) => {
        const began = performance.now()
        try { return await observeExact(input) }
        catch (error) {
          const errors = (evidence.nativeObservationErrors ??= []) as unknown[]
          const failures = error instanceof AggregateError ? error.errors.slice(0, 8).map((failure: unknown) => {
            if (!(failure instanceof Error)) return { name: typeof failure }
            return {
              name: failure.name,
              code: failure instanceof HarnessExecutionError ? failure.result.error?.code ?? null : null,
              message: nativePersistenceRedactor([]).text(failure.message).slice(0, 512),
              cause: failure.cause instanceof Error
                ? nativePersistenceRedactor([]).text(failure.cause.message).slice(0, 512) : undefined,
            }
          }) : []
          if (errors.length < 16) errors.push({ executionId: input.execution.id,
            occurredAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - began),
            failures,
            ...describeNativeFailure(error, nativeSecrets) })
          throw error
        }
      }
      const engine = new LangGraphWorkflowEngine(runs, workflows, approvals, saver, runtimeDirectory, locations,
        credentials, interactions, undefined, { workerParallelism: 2 })
      return { engine, runs, approvals, interactions, budgets, registry, managers, factories }
    }
    activeRuntime = makeRuntime(checkpoints.saver)
    engine = activeRuntime.engine
    stopRun = () => engine!.cancel(run.id, authorizeStop)
    timing.setupMs = Math.round(performance.now() - scenarioBegan)
    const engineBegan = performance.now()
    evidence.engineStartedAt = new Date().toISOString()
    const startTask = engine.start(run.id)
    const recordEngineFinish = () => {
      timing.engineMs = Math.round(performance.now() - engineBegan)
      evidence.engineFinishedAt = new Date().toISOString()
      publicationChanges.notify()
    }
    void startTask.then(recordEngineFinish, recordEngineFinish)
    evidence.startTaskState = 'pending'
    if (options.control) void startTask.then(() => { evidence.startTaskState = 'fulfilled' }, (error: unknown) => {
      evidence.startTaskState = 'rejected'
      evidence.startError = describeNativeFailure(error, nativeSecrets)
    })
    const restartRuntime = async (kind: 'waiting' | 'terminal_unaccepted'): Promise<Eng03NativeRuntime> => {
      if (kind === 'waiting') await startTask
      else await startTask.catch(() => {
        // ignore: The failed startup is retained in evidence while recovery starts a replacement runtime.
        return undefined
      })
      if (!activeRuntime || !checkpoints) throw new Error('Native runtime is unavailable for restart.')
      const current = await activeRuntime.runs.get(run.id)
      if (kind === 'waiting') {
        const pending = await livePool.query(`select 1 from durable_interactions where run_id=$1 and status='pending'
          and native_session_id is not null limit 1`, [run.id])
        if (current?.executionState !== 'waiting' || !pending.rowCount) {
          throw new Error('Restart requires a durable waiting Run with an exact pending native interaction.')
        }
      } else if (current?.executionState !== 'running') {
        throw new Error('Terminal recovery restart requires an unfinished running Run.')
      }
      const before = await livePool.query<{ id: string; accepted: boolean; state: string; result: unknown; native_session_id: string | null }>(
        `select e.id,e.accepted,e.record->>'state' as state,e.record->>'nativeSessionId' as native_session_id,e.record->'result' as result,
          s.reference,s.workflow_finalized_at
         from harness_executions e left join execution_native_sessions s on s.execution_id=e.id
         where e.run_id=$1 order by e.id`, [run.id])
      const acceptedSibling = before.rows.some((row) => row.accepted && row.result)
      const recoverable = kind === 'waiting'
        ? before.rows.some((row) => row.native_session_id && !row.result)
        : before.rows.some((row) => !row.accepted && row.state === 'completed' && row.native_session_id
          && row.result && typeof row.result === 'object' && 'outcome' in row.result
          && row.result.outcome === 'succeeded')
      if (!acceptedSibling || !recoverable) {
        throw new Error('Restart requires an accepted sibling and the exact recoverable native session/result.')
      }
      const stopBefore = await livePool.query<{ stop_requested_at: Date | null }>(
        'select stop_requested_at from runs where id=$1', [run.id])
      if (stopBefore.rows[0]?.stop_requested_at) throw new Error('A stopped Run cannot exercise waiting restart.')
      await activeRuntime.engine.shutdown()
      await activeRuntime.managers.dispose()
      activeRuntime.factories.stopAuxiliaries()
      await activeRuntime.factories.disposeAuxiliaries()
      await checkpoints.close()
      checkpoints = createCheckpointStore(url.toString(), schema)
      await checkpoints.setup()
      activeRuntime = makeRuntime(checkpoints.saver)
      engine = activeRuntime.engine
      const after = await livePool.query(
        `select e.id,e.accepted,e.record->>'state' as state,e.record->>'nativeSessionId' as native_session_id,e.record->'result' as result,
          s.reference,s.workflow_finalized_at
         from harness_executions e left join execution_native_sessions s on s.execution_id=e.id
         where e.run_id=$1 order by e.id`, [run.id])
      const stopAfter = await livePool.query<{ stop_requested_at: Date | null }>(
        'select stop_requested_at from runs where id=$1', [run.id])
      if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)
        || (await activeRuntime.runs.get(run.id))?.executionState !== current.executionState
        || stopAfter.rows[0]?.stop_requested_at) {
        throw new Error('Runtime restart changed a durable execution or waiting Run identity.')
      }
      evidence.runtimeRestart = { kind, at: new Date().toISOString(), preservedExecutionCount: before.rowCount,
        preservedNativeSessionIds: before.rows.map((row) => row.native_session_id).filter(Boolean) }
      return activeRuntime
    }
    const restartWaitingRuntime = () => restartRuntime('waiting')
    const restartRecoverableRuntime = () => restartRuntime('terminal_unaccepted')
    evidence.runId = run.id
    evidence.progressAt = new Date().toISOString()
    await writeFile(artifactPath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = options.control
        ? options.control({ pool, runId: run.id, nodeIds: nodes.map((node) => node.id), projectDirectory,
          runtimeDirectory, artifactPath, ...activeRuntime, startTask, publicationChanged: publicationChanges.next, stop: () => engine!.cancel(run.id, authorizeStop),
          restartWaitingRuntime, restartRecoverableRuntime })
          .then(() => startTask.catch(() => {
            // ignore: The control callback handles the startup outcome, which is also retained in evidence.
            return undefined
          }))
        : startTask
      await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ENG03_NATIVE_TIMEOUT')), 180_000)
      })])
    } finally { clearTimeout(timer) }
    const final = await activeRuntime.runs.get(run.id)
    const executionRows = await pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1', [run.id])
    const executions = executionRows.rows.map((row) => HarnessExecutionSchema.parse(row.record))
    const byNode = (index: number) => executions.find((execution) => execution.workflowNodeId === nodes[index]!.id)
    const nativeRows = await pool.query<{ record: HarnessNativeEvent }>(
      'select record from harness_native_events where execution_id=any($1::text[]) order by execution_id,sequence',
      [executions.map((execution) => execution.id)])
    const nativeEvents = nativeRows.rows.map((row) => row.record)
    const sessionRows = await pool.query<{ execution_id: string; workflow_finalized_at: Date | null; reference: NativeSessionReference }>(
      'select execution_id,reference,workflow_finalized_at from execution_native_sessions where execution_id=any($1::text[])',
      [executions.map((execution) => execution.id)])
    const nativeSessions = new Map(sessionRows.rows.map((row) => [row.execution_id, row.reference]))
    const intervals = [1, 2].map((index) => {
      const execution = byNode(index)
      return execution && nativeInterval(execution,
        nativeSessions.get(execution.id)?.providerVersion ?? '', nativeEvents)
    })
    const overlap = intervals.every(Boolean) && Math.max(...intervals.map((item) => Date.parse(item!.start.occurredAt)))
      < Math.min(...intervals.map((item) => Date.parse(item!.finish.occurredAt)))
    const reviewer = byNode(3)
    // getExecution rereads the current repository's exact canonical input receipt.
    const reviewerInput = reviewer && (await activeRuntime.runs.getExecution(reviewer.id))!.input as unknown as RepeatNodeInput | undefined
    const accepted = reviewerInput?.predecessors ?? []
    const bindings = (await pool.query<{ record: RepeatInputBinding }>(
      'select record from run_repeat_bindings where run_id=$1 and recipient_execution_id=$2 order by ordinal',
      [run.id, reviewer?.id ?? 'no-reviewer'])).rows.map((row) => row.record)
    const joined = Boolean(reviewer && reviewerInput?.executionSemanticsVersion === 3 && accepted.length === 2 && bindings.length === 2
      && accepted.map((item) => item.relationshipId).join('|') === [edges[2]!.id, edges[3]!.id].sort().join('|')
      && accepted.every((item) => {
        const sender = executions.find((execution) => execution.id === item.execution.executionId)
        const binding = bindings.find((candidate) => 'relationshipId' in candidate.source && candidate.source.relationshipId === item.relationshipId)
        return sender?.result?.outcome === 'succeeded' && sameRepeatValue(item.acceptedResult, sender.result)
          && binding?.source.execution.executionId === sender.id && binding.recipient.executionId === reviewer.id
          && binding.ordinal === accepted.indexOf(item)
          && binding.source.acceptedResultDigest === repeatDigest(sender.result, 64 * 1024)
          && binding.inputDigest === repeatDigest(reviewer.input, 4 * 1024 * 1024)
      }) && intervals.every((item) => item && Date.parse(reviewer.createdAt) > Date.parse(item.finish.occurredAt)))
    const finalText = resultText(reviewer)
    const branchTexts = [resultText(byNode(1)), resultText(byNode(2))]
    const outcome = final?.outcome === 'succeeded' && JSON.stringify(final.result?.output) === JSON.stringify(reviewer?.result?.output)
      && branchTexts.every((text, index) => text.includes(tokens[index + 1]!))
      && finalText.includes(tokens[1]!) && finalText.includes(tokens[2]!) ? 'succeeded' : 'failed'
    const identitiesDistinct = [1, 2].every((index) => Boolean(byNode(index)?.nativeSessionId && byNode(index)?.runtimeDirectory))
      && new Set([1, 2].map((index) => byNode(index)?.agentId)).size === 2
      && new Set([1, 2].map((index) => byNode(index)?.agentConfigurationVersionId)).size === 2
      && new Set([1, 2].map((index) => byNode(index)?.nativeSessionId)).size === 2
      && new Set([1, 2].map((index) => byNode(index)?.runtimeDirectory)).size === 2
    const activeCredentials = await pool.query<{ count: string }>(`select count(*) from worker_credential_bindings b
      join management_principals p on p.id=b.principal_id where b.run_id=$1 and p.revoked_at is null`, [run.id])
    // Read persisted engine closure before best-effort final disposal; actively
    // closing owners here would conceal a missing product cleanup operation.
    const unresolvedClosures = await pool.query<{ count: string }>(`select count(*) from execution_native_closures
      where execution_id=any($1::text[]) and closed_at is null and detached_at is null`,
    [executions.map((execution) => execution.id)])
    const cleanup = Number(activeCredentials.rows[0]?.count) === 0
      && Number(unresolvedClosures.rows[0]?.count) === 0
      && executions.filter((execution) => execution.nativeSessionId).every((execution) =>
        sessionRows.rows.some((row) => row.execution_id === execution.id && row.reference.nativeSessionId === execution.nativeSessionId
          && row.workflow_finalized_at !== null))
    Object.assign(evidence, { runId: run.id, workflowVersionId: fixture.version.id, sourceGraph: { nodes, edges },
      outcome, runOutcome: final?.outcome, runResult: final?.result, executions: executions.map((execution) => ({
        id: execution.id, nodeId: execution.workflowNodeId, agentId: execution.agentId,
        nativeSessionId: execution.nativeSessionId, runtimeDirectory: execution.runtimeDirectory,
        state: execution.state, result: execution.result, input: execution.input,
      })), intervals, overlap, identitiesDistinct, accepted, bindings, joinExact: joined, finalText, cleanup,
      activeCredentialCount: Number(activeCredentials.rows[0]?.count),
      nativeEventSummary: executions.map((execution) => ({ id: execution.id,
        events: nativeEvents.filter((event) => event.executionId === execution.id)
          .map(({ type, occurredAt, sequence }) => ({ type, occurredAt, sequence })) })) })
    result = { artifactPath, outcome, overlap, identitiesDistinct, joinExact: joined, cleanup }
  } catch (error) {
    failure = { error }
    evidence.error = describeNativeFailure(error, nativeSecrets)
    evidence.failureAt = new Date().toISOString()
    evidence.failureStartTaskState = evidence.startTaskState
    try {
      if (runId && pool) {
        evidence.failureRun = await activeRuntime?.runs.get(runId).catch(() => {
          // ignore: The run may be unreadable after the scenario failure; continue collecting other diagnostics.
          return undefined
        })
        try {
          const checkpoint = await checkpoints?.saver.getTuple({ configurable: { thread_id: runId } })
          evidence.failureCheckpoint = nativePersistenceRedactor([]).value({
            checkpointId: checkpoint?.checkpoint.id,
            pendingWrites: checkpoint?.pendingWrites?.filter(([, channel]) =>
              channel === '__interrupt__' || channel === '__error__'),
          })
        } catch (checkpointError) {
          evidence.failureCheckpoint = { readError: checkpointError instanceof Error
            ? nativePersistenceRedactor([]).text(checkpointError.message) : typeof checkpointError }
        }
        if (activeRuntime) {
          const owned = Reflect.get(activeRuntime.approvals, 'ownedSessions') as Map<string, {
            session?: NativeSessionReference; manager: NativeHarnessSessionManager
          }>
          evidence.failureNativeHistories = await Promise.all([...owned].map(async ([executionId, value]) => {
            if (!value.session) return { executionId }
            const history = await value.manager.history(value.session, AbortSignal.timeout(5_000)).catch(() => {
              // ignore: The failed native session may no longer serve history; retain the other session diagnostics.
              return undefined
            })
            const lane = await activeRuntime!.interactions.coordination.getLane(value.session.harness,
              value.session.nativeSessionId).catch(() => {
                // ignore: Coordination may be unavailable after the scenario failure; retain the native history.
                return undefined
              })
            return { executionId, nativeTurnId: history?.nativeTurnId, terminalOutcome: history?.terminalResult?.outcome,
              pending: history?.pendingInteractions.map(item => ({ nativeRequestId: item.turn.nativeRequestId,
                nativeTurnId: item.turn.nativeTurnId, nativeRequestType: item.nativeRequestType })),
              lane: lane && { observedStatus: lane.observedStatus, hasWriterLease: Boolean(lane.leaseToken),
                currentTurnOrMessageId: lane.currentTurnOrMessageId },
              lastEvents: history?.events.slice(-20).map(({ type, sequence, payload }) => ({
                type, sequence, payload: nativePersistenceRedactor(nativeSecrets).value(payload),
              })) }
          }))
        }
        const requests = await pool.query<{ record: unknown }>(
          'select record from durable_interactions where run_id=$1 order by created_at', [runId]).catch(() => {
            // ignore: Interaction reads may fail after the scenario failure; continue collecting execution diagnostics.
            return undefined
          })
        evidence.failureInteractions = requests?.rows.map(({ record }) => {
          const interaction = DurableInteractionSchema.parse(record)
          return { id: interaction.id, executionId: interaction.executionId, nativeRequestId: interaction.nativeRequestId,
            nativeRequestType: interaction.nativeRequestType, graphInterruptId: interaction.graphInterruptId,
            status: interaction.status, deliveryState: interaction.deliveryState }
        })
        const rows = await pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1', [runId]).catch(() => {
          // ignore: Execution reads may fail after the scenario failure; continue collecting event diagnostics.
          return undefined
        })
        evidence.failureExecutions = rows?.rows.map((row) => {
          const execution = HarnessExecutionSchema.parse(row.record)
          return { id: execution.id, nodeId: execution.workflowNodeId, state: execution.state,
            result: execution.result, nativeSessionId: execution.nativeSessionId }
        })
        const events = await pool.query<{ execution_id: string; type: string; occurred_at: string; item_type: string | null }>(
          `select execution_id, record->>'type' as type, record->>'occurredAt' as occurred_at,
             record#>>'{payload,item,type}' as item_type
           from harness_native_events where execution_id in (select id from harness_executions where run_id=$1)
           order by execution_id,sequence`, [runId]).catch(() => {
            // ignore: Event reads may fail after the scenario failure; preserve the original failure and collected diagnostics.
            return undefined
          })
        evidence.failureNativeEvents = events?.rows
      }
    } catch (diagnosticError) {
      failure.error = new AggregateError([error, diagnosticError], 'Native scenario and diagnostic collection failed.')
    }
    process.stdout.write(`ENG03 failure ${JSON.stringify({ scenario,
      startTaskState: evidence.failureStartTaskState, startError: evidence.startError,
      error: describeNativeFailure(error, nativeSecrets),
      observations: evidence.nativeObservationErrors,
      executions: Array.isArray(evidence.failureExecutions) ? evidence.failureExecutions.map(value => {
        const execution = value as { id: string; state: string; result?: ExecutionResult }
        return { id: execution.id, state: execution.state, outcome: execution.result?.outcome,
          ...(execution.result?.error ? { error: nativePersistenceRedactor(nativeSecrets).value(execution.result.error) } : {}) }
      }) : [],
    })}\n`)
    try { await stopRun?.() }
    catch (cleanupError) { cleanupErrors.push(cleanupError) }
  } finally {
    activeRuntime?.factories.stopAuxiliaries()
    const close = async (action: () => Promise<unknown>) => {
      try { await action() }
      catch (error) { cleanupErrors.push(error) }
    }
    await close(async () => engine?.shutdown())
    await close(async () => activeRuntime?.managers.dispose())
    await close(async () => activeRuntime?.factories.disposeAuxiliaries())
    await close(async () => {
      const owners = new Set(registry.snapshot().launches.map(launch => launch.owner))
      for (const owner of owners) {
        await close(async () => {
          if (!await registry.closeOwner(owner)) throw new Error(`Native acceptance closure is unconfirmed for ${owner}`)
        })
      }
    })
    await close(async () => mcpRoutes?.close())
    await close(async () => mcpApp?.close())
    if (!cleanupErrors.length) await close(async () => restoreNativeMcp?.())
    const keepRuntime = Boolean(process.env.ENG03_A_KEEP_RUNTIME)
    if (!cleanupErrors.length && !keepRuntime && runId) {
      const threadId = runId
      await close(async () => checkpoints?.saver.deleteThread(threadId))
    }
    await close(async () => checkpoints?.close())
    await close(async () => pool?.end())
    if (!cleanupErrors.length && !keepRuntime) await close(() => dropFixtureSchema(admin, schema))
    await close(() => admin.end())
    timing.totalMs = Math.round(performance.now() - scenarioBegan)
    runtimeTimingChannel.unsubscribe(captureTiming)
    evidence.droppedTimingRecords = droppedTimingRecords
    evidence.finishedAt = new Date().toISOString()
    evidence.resourcesRetained = keepRuntime || cleanupErrors.length > 0
    evidence.cleanupErrors = cleanupErrors.map(error => error instanceof Error ? error.message : String(error))
    if (evidence.error || evidence.startError || cleanupErrors.length) {
      console.error(`Native acceptance failure ${nativeFailureSummary(evidence, nativeSecrets)}`)
    }
    await close(async () => {
      await writeFile(ownedTestPath(artifactPath), JSON.stringify(nativePersistenceRedactor(nativeSecrets).value(evidence), null, 2), { mode: 0o600 })
      await archiveNativeAcceptanceEvidence(basename(artifactPath), nativePersistenceRedactor(nativeSecrets).value(evidence))
    })
    process.stdout.write(`ENG03 evidence ${artifactPath}\n`)
    if (!cleanupErrors.length && !keepRuntime) {
      await close(async () => {
        await removeFixtureDirectory(root)
        completeTestResourceCleanup(invocation, cleanupId)
      })
    }
  }
  if (cleanupErrors.length) {
    const errors = [...(failure ? [failure.error] : []), ...cleanupErrors]
    throw new AggregateError(errors, `Native acceptance cleanup remains unconfirmed; resources retained at ${root}`, { cause: failure?.error })
  }
  if (failure) throw failure.error
  return result!
}
