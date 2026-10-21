import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentConfigurationVersionSchema, AgentSchema, HarnessExecutionSchema,
  DEFAULT_CODEX_ADVANCED_CONFIGURATION, ListInteractionsResponseSchema, WorkspaceSchema,
  type HarnessExecution } from '@foreman-code/contracts'
import { ManagementActionSchema, RunEventsPageSchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  RunActivitiesPageSchema, RunHandoffsReadSchema, SavedManagedWorkflowCommandResultSchema, ManualRunStartResultSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { beginTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { loadConfig } from '../src/config.js'
import { buildProductionApp } from '../src/production.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import * as mcpResults from '../src/mcp/shared/results.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'
import { detectedClaudeProfilePath } from '../src/modules/harnesses/claudeSdk/productionMetadata.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { describeNativeFailure, type NativeFailureDetail } from './helpers/nativeFailureEvidence.js'
import { LocalWorkflowArtifactAuthority } from '../src/modules/runs/remote/localWorkflowArtifactAuthority.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { configureNativeAcceptanceMcp } from './helpers/nativeAcceptanceMcp.js'
import { writeNativeAcceptanceEvidence } from './helpers/nativeAcceptanceEvidence.js'
import { LocalNativeArtifactOutputSchema } from '../src/modules/runs/remote/nativeArtifactOutputs.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES } from '@foreman-code/contracts/worker-native-output'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'

const enabled = process.env.NIM2691_REAL_NATIVE === '1' && process.env.NIM2691_POSTGRES === '1'

async function taskPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

describe.skipIf(!enabled)('NIM-2691 real native workflow qualification', () => {
  it.each([
    { name: 'single Codex activation', form: 'single', providers: ['codex'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'local Codex artifact through authenticated MCP', form: 'single', providers: ['codex'],
      review: false, approval: false, capLoop: false, attemptFourth: false, artifacts: true },
    { name: 'local Codex artifact recovery before adoption', form: 'single', providers: ['codex'],
      review: false, approval: false, capLoop: false, attemptFourth: false, artifacts: true, restartOnArtifacts: true },
    { name: 'sequential Codex handoff', form: 'sequential', providers: ['codex', 'codex'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'Codex conditional final route', form: 'conditional',
      providers: ['codex', 'codex'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'Codex accepted review return', form: 'sequential', providers: ['codex', 'codex'],
      review: true, approval: false, capLoop: false, attemptFourth: false },
    { name: 'Codex read-only approval before handoff', form: 'sequential',
      providers: ['codex', 'codex'], review: false, approval: true, capLoop: false, attemptFourth: false },
    { name: 'unequal Codex branches into one all-required join', form: 'parallel',
      providers: ['codex', 'codex', 'codex', 'codex'], review: false, approval: false, capLoop: false, attemptFourth: false },
    { name: 'concurrent branches into one join approval with engine restart', form: 'parallel',
      providers: ['codex', 'codex', 'codex', 'codex'], review: false, approval: true,
      approvalNode: 3, restartOnApproval: true, capLoop: false, attemptFourth: false },
    { name: 'third needs-changes review reroutes from C to D', form: 'parallel',
      providers: ['codex', 'codex', 'codex', 'codex'], review: false, approval: false, capLoop: true, attemptFourth: false },
    { name: 'attempted fourth C request is denied before D reroute', form: 'parallel',
      providers: ['codex', 'codex', 'codex', 'codex'], review: false, approval: false, capLoop: true, attemptFourth: true },
    { name: 'no valid route preserves findings after the third C review', form: 'parallel',
      providers: ['codex', 'codex', 'codex', 'codex'], review: false, approval: false,
      capLoop: true, attemptFourth: false, noRoute: true },
    { name: 'accepted third C review needs no B continuation', form: 'parallel',
      providers: ['codex', 'codex', 'codex', 'codex'], review: false, approval: false,
      capLoop: true, attemptFourth: false, finalAccepted: true },
  ] as const)('finishes $name with exact accepted results and cleanup', async (scenario) => {
    const approvalNode = 'approvalNode' in scenario ? scenario.approvalNode : 0
    const restartOnApproval = 'restartOnApproval' in scenario && scenario.restartOnApproval
    const noRoute = 'noRoute' in scenario && scenario.noRoute
    const finalAccepted = 'finalAccepted' in scenario && scenario.finalAccepted
    const artifacts = 'artifacts' in scenario && scenario.artifacts
    const restartOnArtifacts = 'restartOnArtifacts' in scenario && scenario.restartOnArtifacts
    await nim2691TaskDatabase(async (pool, directory, suppliedUrl) => {
      const projectPath = join(directory, 'workspaces')
      const runtimeRoot = join(directory, 'runtime')
      await mkdir(projectPath, { mode: 0o700 })
      await mkdir(runtimeRoot, { mode: 0o700 })
      const port = await taskPort()
      const config = { ...loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: String(port),
        DATABASE_URL: suppliedUrl.replace(/^postgres:/, 'postgresql:'),
        HARNESS_WORKSPACE_ROOT: runtimeRoot, DATABASE_QUERY_TIMEOUT_MS: '10000' }),
        workspaceStorageRoot: projectPath, fileStorageRoot: join(directory, 'files') }
      const database = createDatabase(config.database)
      const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
      let app: ReturnType<typeof buildProductionApp>['app'] | undefined
      let observedRunId: string | undefined
      const secrets = new Set(Object.entries(process.env)
        .filter(([name, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL/.test(name) && value)
        .map(([, value]) => value!))
      const nativeFailures: Array<{ stage: string; executionId?: string; error: NativeFailureDetail;
        elapsedMs?: number; signalAborted?: boolean }> = []
      const toolFailure = mcpResults.toolFailure
      const mcpFailureObserver = vi.spyOn(mcpResults, 'toolFailure').mockImplementation((error, message) => {
        if (nativeFailures.length < 16) {
          nativeFailures.push({ stage: 'mcp_tool', error: describeNativeFailure(error, [...secrets]) })
        }
        return toolFailure(error, message)
      })
      const artifactExecution = LocalWorkflowArtifactAuthority.prototype.execution
      const artifactObserver = vi.spyOn(LocalWorkflowArtifactAuthority.prototype, 'execution')
        .mockImplementation(async function (this: LocalWorkflowArtifactAuthority, sql, executionId) {
          try { return await artifactExecution.call(this, sql, executionId) }
          catch (error) {
            if (artifacts && nativeFailures.length < 16) nativeFailures.push({ stage: 'artifact_declaration',
              executionId, error: describeNativeFailure(error, [...secrets]) })
            throw error
          }
        })
      const cancellations: Array<{ nativeSessionId: string; caller: string[]; reason?: NativeFailureDetail }> = []
      const inspectMcp = CodexAppServerSessionManager.prototype.inspectMcpConfiguration
      const inspectionObserver = vi.spyOn(CodexAppServerSessionManager.prototype, 'inspectMcpConfiguration')
        .mockImplementation(async function (this: CodexAppServerSessionManager, cwd, signal) {
          const started = performance.now()
          try { return await inspectMcp.call(this, cwd, signal) }
          catch (error) {
            if (nativeFailures.length < 16) nativeFailures.push({ stage: 'inspect_mcp_configuration',
              elapsedMs: Math.round(performance.now() - started), signalAborted: Boolean(signal?.aborted),
              error: describeNativeFailure(error, [...secrets]) })
            throw error
          }
        })
      const createSession = CodexAppServerSessionManager.prototype.createSession
      const sessionObserver = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession')
        .mockImplementation(async function (this: CodexAppServerSessionManager, source, signal) {
          for (const value of Object.values(source.environment?.variables ?? {})) secrets.add(value)
          try { return await createSession.call(this, source, signal) }
          catch (error) {
            if (nativeFailures.length < 16) nativeFailures.push({ stage: 'create_session',
              error: describeNativeFailure(error, [...secrets]) })
            throw error
          }
        })
      const cancelSession = CodexAppServerSessionManager.prototype.cancel
      const cancellationObserver = vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel')
        .mockImplementation(async function (this: CodexAppServerSessionManager, session, signal) {
          if (cancellations.length < 16) {
            const redactor = nativePersistenceRedactor([...secrets])
            const request: (typeof cancellations)[number] = { nativeSessionId: session.nativeSessionId,
              caller: (new Error('Native cancellation requested.').stack ?? '').split('\n').slice(1, 9)
                .map(line => redactor.text(line)),
            }
            if (signal?.reason !== undefined) request.reason = describeNativeFailure(signal.reason, [...secrets])
            cancellations.push(request)
          }
          return cancelSession.call(this, session, signal)
        })
      const observeExact = ApprovalExecutionCoordinator.prototype.observeExact
      const executionObserver = vi.spyOn(ApprovalExecutionCoordinator.prototype, 'observeExact')
        .mockImplementation(async function (this: ApprovalExecutionCoordinator, input) {
          try { return await observeExact.call(this, input) }
          catch (error) {
            if (nativeFailures.length < 16) nativeFailures.push({ stage: 'observe_execution',
              executionId: input.execution.id, error: describeNativeFailure(error, [...secrets]) })
            throw error
          }
        })
      const validateInteraction = ApprovalExecutionCoordinator.prototype.validateInteraction
      const validationObserver = vi.spyOn(ApprovalExecutionCoordinator.prototype, 'validateInteraction')
        .mockImplementation(async function (this: ApprovalExecutionCoordinator, interaction, signal) {
          try { return await validateInteraction.call(this, interaction, signal) }
          catch (error) {
            if (nativeFailures.length < 16) nativeFailures.push({ stage: 'validate_interaction',
              executionId: interaction.executionId, error: describeNativeFailure(error, [...secrets]) })
            throw error
          }
        })
      const attachInteraction = ApprovalExecutionCoordinator.prototype.attachInteraction
      const attachmentObserver = vi.spyOn(ApprovalExecutionCoordinator.prototype, 'attachInteraction')
        .mockImplementation(async function (this: ApprovalExecutionCoordinator, interaction, signal) {
          try { return await attachInteraction.call(this, interaction, signal) }
          catch (error) {
            if (nativeFailures.length < 16) nativeFailures.push({ stage: 'attach_interaction',
              executionId: interaction.executionId, error: describeNativeFailure(error, [...secrets]) })
            throw error
          }
        })
      let production: ReturnType<typeof buildProductionApp> | undefined
      const mcpClients: Client[] = []
      let artifactBoundary: pg.PoolClient | undefined
      let failure: { error: unknown } | undefined
      let cleanupRun: { workspaceId: string; id: string } | undefined
      const verify = async () => {
        await database.migrate()
        await checkpoints.setup()
        await configureNativeAcceptanceMcp(database.pool, runtimeRoot,
          { codex: config.harnesses.codexBinary }, `http://127.0.0.1:${port}/mcp`, scenario.providers)
        const settings = new PostgresSettingsRepository(pool)
        const defaults = await settings.getHarnessDefaults()
        await settings.saveHarnessDefaults({ ...defaults, claude: {
          harness: 'claude', model: 'claude-haiku-4-5-20251001', authMode: 'subscription',
          configDirectory: detectedClaudeProfilePath(), permissionMode: 'default', sandbox: 'read-only',
          tools: [], permissionRules: [], instructions: '', mcpServers: {},
        } })
        production = buildProductionApp(config, database, checkpoints, false)
        const startupErrors: Array<{ code: string; message: string; cause: string | null;
          inspectionCodes: string[]; probe: unknown }> = []
        const recordFailure = (error: unknown) => {
          const redact = nativePersistenceRedactor([...secrets])
          if (nativeFailures.length < 16) nativeFailures.push({ stage: 'engine',
            error: describeNativeFailure(error, [...secrets]) })
          const code = error && typeof error === 'object' && 'code' in error
              ? String(error.code) : error instanceof Error ? error.name : 'unknown'
          startupErrors.push({ code: redact.text(code),
            message: redact.text(error instanceof Error ? error.message : 'Unknown engine failure').slice(0, 2048),
            cause: error instanceof Error && error.cause instanceof Error
              ? redact.text(error.cause.message).slice(0, 2048) : null,
            probe: error instanceof DomainError && error.code === 'WORKER_NATIVE_OUTPUT_PROTECTION_FAILED'
              ? redact.value(error.details ?? null) : null,
            inspectionCodes: error instanceof DomainError && Array.isArray(error.details?.inspectionCodes)
              ? error.details.inspectionCodes.filter((value): value is string =>
                typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(value)) : [] })
        }
        const observeEngine = (runtime: ReturnType<typeof buildProductionApp>) => {
          runtime.app.addHook('onError', async (request, _reply, error) => {
            if (artifacts && request.url === '/mcp' && nativeFailures.length < 16) {
              nativeFailures.push({ stage: 'mcp_http', error: describeNativeFailure(error, [...secrets]) })
            }
          })
          const start = runtime.engine.start.bind(runtime.engine)
          runtime.engine.start = async (runId) => {
            try { return await start(runId) }
            catch (error) { recordFailure(error); throw error }
          }
          const resume = runtime.engine.resumeInteraction.bind(runtime.engine)
          runtime.engine.resumeInteraction = async (interaction, claim) => {
            try { return await resume(interaction, claim) }
            catch (error) { recordFailure(error); throw error }
          }
        }
        observeEngine(production)
        app = production.app
        production.registerFileStorage()
        await production.initialize()
        expect((await settings.getHarnessDefaults()).claude?.model).toBe('claude-haiku-4-5-20251001')
        await app.listen({ host: config.host, port: config.port })
        const fixture = makeCurrentWorkflowFixture(`nim2691-native-${randomUUID()}`, scenario.form)
        const configurations = fixture.configurations.map((original, index) => AgentConfigurationVersionSchema.parse({
          ...original,
          harness: { harness: 'codex', model: process.env.NIM2691_CODEX_MODEL ?? process.env.CODEX_TEST_MODEL ?? 'gpt-6-luna',
            reasoningEffort: process.env.NIM2691_CODEX_REASONING_EFFORT ?? 'medium',
            sandbox: 'read-only', serviceTier: 'standard',
            ...(scenario.approval && index === approvalNode
              ? { advanced: DEFAULT_CODEX_ADVANCED_CONFIGURATION } : {}) },
          prompt: { system: scenario.capLoop
            ? finalAccepted && index === 1
              ? 'You are requester B. On work_request and needs-changes work_return, always output a new routing.kind request with outcome review_c. Never output routing.kind return. Follow the node initial prompt and the Foreman Code work-handoff output contract. Do not use tools.'
              : 'Follow the node initial prompt and the Foreman Code work-handoff output contract. Do not use tools.'
            : index === 0 || scenario.approval && index === approvalNode
            ? scenario.approval && index === approvalNode
              ? 'Run exactly pwd with the native shell tool and sandbox_permissions require_escalated so the user approves it before execution. Wait for the authorized response. Then follow the Foreman Code work-handoff output contract.'
              : 'Follow the Foreman Code work-handoff output contract. Do not use tools.'
            : 'Summarize only the received work. Follow the Foreman Code work-handoff output contract.' },
        }))
        if (artifacts) {
          const original = configurations[0]!
          const harness = original.harness
          if (harness.harness !== 'codex') throw new Error('The native artifact fixture requires Codex.')
          configurations[0] = AgentConfigurationVersionSchema.parse({ ...original,
            harness: { ...harness, sandbox: 'workspace-write',
              advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, workspaceWrite: { networkAccess: false,
                excludeTmpdirEnvVar: true, excludeSlashTmp: true } } },
            prompt: { system: 'Produce the requested report using only the four declared tools whose names end in files_native_output_create, files_native_output_append, files_native_output_seal, and files_native_output_publish. Do not write files with shell tools. Follow the Foreman Code artifact and work-handoff result contracts.' },
          })
        }
        const workspace = WorkspaceSchema.parse({ id: fixture.scope.workspaceId, name: 'NIM-2691 native qualification' })
        const canonicalPath = await realpath(projectPath), details = await stat(projectPath)
        await pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
          values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [workspace.id, JSON.stringify(workspace),
          JSON.stringify({ runnerId: 'runner-local', rootPath: canonicalPath }),
          JSON.stringify({ device: String(details.dev), inode: String(details.ino) })])
        for (const [index, configuration] of configurations.entries()) {
          if (configuration.harness.harness !== 'codex') throw new Error('The native workflow fixture requires Codex.')
          const agent = AgentSchema.parse({ id: configuration.agentId,
            name: scenario.capLoop ? ['A', 'B', 'C', 'D'][index]! : `NIM-2691 Agent ${index + 1}`,
            productRole: 'coder', harness: configuration.harness.harness,
            model: configuration.harness.model,
            effort: configuration.harness.reasoningEffort,
            fastMode: false,
            harnessConfiguration: configuration.harness, prompt: configuration.prompt,
            assignedSkills: [], configurationVersionId: configuration.id })
          await pool.query(`insert into agents(id,workspace_id,record)
            values($1,$2,$3::jsonb)`, [agent.id, workspace.id, JSON.stringify(agent)])
          await pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
            values($1,$2,$3,1,$4::jsonb)`,
          [configuration.id, workspace.id, agent.id, JSON.stringify(configuration)])
          await pool.query('update agents set current_configuration_version_id=$2 where id=$1',
            [agent.id, configuration.id])
        }
        const access = new PostgresAccessService(pool)
        const writer = await access.issue({ name: 'NIM-2691 native test owner', audience: 'operator',
          expiresAt: new Date(Date.now() + 10 * 60_000), grants: [
            { actions: ['capabilities:read'], scope: {} },
            { actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'),
              scope: { workspaceIds: [workspace.id] } },
          ] })
        const headers = { host: 'localhost' }
        const connect = async (token: string) => {
          const client = new Client({ name: 'local-artifact-acceptance', version: '1.0.0' })
          mcpClients.push(client)
          await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
            { authProvider: { token: async () => token } }))
          return client
        }
        const created = await app.inject({ method: 'POST',
          url: `/api/management/workspaces/${workspace.id}/workflows`, headers,
          payload: { workspaceId: workspace.id, commandId: randomUUID(), name: 'NIM-2691 single native turn' } })
        expect(created.statusCode, created.body).toBe(201)
        const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
        const capEdges = scenario.capLoop ? [
          { id: `edge-${randomUUID()}`, kind: 'execution' as const,
            source: fixture.version.definition.nodes[0]!.id, target: fixture.version.definition.nodes[1]!.id },
          { id: `edge-${randomUUID()}`, kind: 'execution' as const,
            source: fixture.version.definition.nodes[1]!.id, target: fixture.version.definition.nodes[2]!.id,
            maxWorkHandoffsPerRun: 3 },
          { id: `edge-${randomUUID()}`, kind: 'execution' as const,
            source: fixture.version.definition.nodes[noRoute || finalAccepted ? 0 : 1]!.id,
            target: fixture.version.definition.nodes[3]!.id,
            ...(!noRoute && !finalAccepted ? { maxWorkHandoffsPerRun: 1 } : {}) },
        ] : undefined
        const graph = { ...fixture.version.definition, id: managed.workflow.id,
          version: managed.workflow.version, createdAt: managed.workflow.createdAt,
          updatedAt: managed.workflow.updatedAt, name: managed.workflow.name,
          nodes: fixture.version.definition.nodes.map((node, index) => ({ ...node,
            ...(scenario.capLoop ? { name: ['A', 'B', 'C', 'D'][index] } : {}),
            ...(scenario.capLoop && index === 3 ? { join: undefined } : {}),
            ...(scenario.capLoop && index === 1 ? { choice: { outcomes: [
              { outcome: 'review_c', target: { kind: 'edge', relationshipId: capEdges![1]!.id } },
              ...(!noRoute && !finalAccepted ? [{ outcome: 'review_d', target: { kind: 'edge' as const,
                relationshipId: capEdges![2]!.id } }] : []),
            ] } } : {}),
            ...(scenario.review && index === 0 ? { choice: { outcomes: [{ outcome: 'review',
              target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] } } : {}),
            initialPrompt: scenario.capLoop
              ? [
                'Finish with latestDeliverable {"revision":0} and remainingFindings [].',
                scenario.attemptFourth
                  ? 'This is the admission-denial qualification. Produce a structured routing decision, not prose. If input.work.kind is work_request or work_return, ALWAYS output routing {"kind":"request","outcome":"review_c"}, even when a limit notice is present. That fourth request is a deliberate diagnostic; the backend must deny it locally without starting C. Do not select review_d on a work_return. Only when input.work.kind is limit_denial, output routing {"kind":"request","outcome":"review_d"}, preserving input.work.notice.latestDeliverable and remainingFindings. Never request C again after limit_denial.'
                  : finalAccepted
                  ? 'You are B, the requester, never the reviewer. NEVER output routing.kind return or reuse returned.requestId as routing.requestId. On input.work.kind work_request, submit routing {"kind":"request","outcome":"review_c"} with latestDeliverable {"revision":0} and remainingFindings []. On every input.work.kind work_return with outcome needs_changes, output routing {"kind":"request","outcome":"review_c"} again, preserving input.work.returned.latestDeliverable and remainingFindings. An accepted review creates no continuation turn for you.'
                  : noRoute
                  ? 'If input.work.kind is work_request or a work_return without a notice, submit routing.kind request with outcome review_c, preserving latestDeliverable and remainingFindings. On the third work_return with input.work.notice, there is no connected alternative from B: output routing {"kind":"finish"}, preserve input.work.returned.latestDeliverable and remainingFindings without claiming approval. Never request C after the notice.'
                  : 'If input.work.kind is work_request, submit routing.kind request with outcome review_c and latestDeliverable {"revision":0}. If input.work.kind is work_return and input.work.notice exists, submit a new request with outcome review_d, preserving returned.latestDeliverable and returned.remainingFindings. Otherwise submit a new request with outcome review_c, preserving returned.latestDeliverable and returned.remainingFindings. Never finish before D returns.',
                finalAccepted
                  ? 'Return to input.work.request.requestId, copying every character verbatim. Read the prior revision from input.work.acceptedSourceResult.output.data.latestDeliverable.revision. If that prior revision is less than 2, use routing.outcome needs_changes, add one to the revision and include one finding. At prior revision 2, return routing.outcome accepted, preserve the deliverable and set remainingFindings []. Never create a fourth review.'
                  : 'Return to input.work.request.requestId, copying every character verbatim without shortening, repeating or reconstructing it. Use routing.kind return and outcome needs_changes. Set latestDeliverable.revision to input.work.acceptedSourceResult.output.data.latestDeliverable.revision plus one. Include one remaining finding. Never accept.',
                'Return to the exact input.work.request.requestId with routing.kind return and outcome accepted. Preserve the latest deliverable and set remainingFindings to [].',
              ][index]
              : scenario.approval && index === approvalNode
              ? 'Call the native shell tool with exactly pwd and sandbox_permissions require_escalated. After user approval and the command result, return a short greeting in latestDeliverable and finish.'
              : scenario.review
              ? index === 0
                ? 'Submit one review request using routing.kind request and routing.outcome review. Put a short greeting in latestDeliverable.'
                : 'Return to the exact requestId in input.work.request using routing.kind return and routing.outcome accepted. Keep latestDeliverable non-null and remainingFindings empty.'
              : scenario.form === 'conditional' && index === 0
                ? 'Return a short greeting in latestDeliverable, use routing.kind finish, and select routing.outcome go.'
              : index === 0
                ? 'Return a short greeting as latestDeliverable and finish.'
                : 'Summarize only the received work in latestDeliverable. Your routing must be exactly {"kind":"finish"}, with no outcome or requestId. Do not copy the predecessor routing.' })),
          edges: capEdges ?? fixture.version.definition.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 3 })),
          handoffs: { contractVersion: 1 }, executionPolicy: { maxParallelism: scenario.form === 'parallel' && !scenario.capLoop ? 2 : 1,
            maxNodeExecutions: scenario.capLoop ? 12 : configurations.length } }
        if (artifacts) {
          const node = graph.nodes[0]!
          node.artifactOutputs = { version: 1, outputKeys: ['report'] }
          node.initialPrompt = 'Produce one report.md text/markdown artifact containing exactly LOCAL_ARTIFACT_REPORT\\n. Create it with files_native_output_create, append base64 TE9DQUxfQVJUSUZBQ1RfUkVQT1JUCg== at offset 0, seal, and publish. Use distinct command IDs. Return routing.kind finish, data.latestDeliverable "local report", data.remainingFindings [], and the report output key with the publication commandId in artifactOutputs. Do not invent a publication or use other tools.'
        }
        const saveInput = CurrentWorkflowSaveInputSchema.parse({ workspaceId: workspace.id,
          workflowId: managed.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
          expectedRevision: managed.revision, expectedWorkflowVersionId: null,
          expectedAgentConfigurationVersionIds: Object.fromEntries(configurations.map((configuration) => [configuration.agentId, configuration.id])),
          graph })
        const savedResponse = await app.inject({ method: 'PUT', headers,
          url: `/api/management/workspaces/${workspace.id}/workflows/${managed.workflow.id}/definition`,
          payload: saveInput })
        expect(savedResponse.statusCode, savedResponse.body).toBe(200)
        const saved = CurrentWorkflowSaveResultSchema.parse(savedResponse.json())
        const startInput = { workspaceId: workspace.id, workflowId: managed.workflow.id,
            workflowVersionId: saved.value.version.id, executionSemanticsVersion: 3,
            commandId: randomUUID(), expectedWorkflowRevision: saved.value.revision,
            expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
            expectedLocationRevision: 1, input: { task: artifacts ? 'Produce one original report artifact.' : 'Say hello once.' } }
        let artifactCut: HarnessExecution | undefined
        let runId: string
        if (artifacts) {
          const reader = await access.issue({ name: 'Artifact denied reader', audience: 'operator',
            expiresAt: new Date(Date.now() + 10 * 60_000), grants: [{
              actions: ['runs:read', 'workflows:read'], scope: { workspaceIds: [workspace.id] },
            }] })
          const denied = await connect(reader.token)
          expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('run_start')
          const startDenied = await denied.callTool({ name: 'run_start', arguments: startInput })
          expect(startDenied.isError).toBe(true)
          expect(graphRpcValue(startDenied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
          const outputDenied = await denied.callTool({ name: WORKER_NATIVE_OUTPUT_TOOL_NAMES.create,
            arguments: { commandId: randomUUID(), filename: 'forbidden.md', mediaType: 'text/markdown' } })
          expect(outputDenied.isError).toBe(true)
          expect(graphRpcValue(outputDenied)).toMatchObject({ error: { code: 'ROLE_NOT_ALLOWED' } })
          expect((await pool.query('select 1 from local_workflow_native_outputs')).rowCount).toBe(0)
          expect((await pool.query('select 1 from runs where workflow_id=$1', [managed.workflow.id])).rowCount).toBe(0)
          const client = await connect(writer.token)
          const launched = await client.callTool({ name: 'run_start', arguments: startInput })
          expect(launched.isError, JSON.stringify(launched)).not.toBe(true)
          runId = ManualRunStartResultSchema.parse(decodeMcpToolResult(launched)).run.id
        } else {
          const started = await app.inject({ method: 'POST', headers,
            url: `/api/management/workspaces/${workspace.id}/workflows/${managed.workflow.id}/runs`, payload: startInput })
          expect(started.statusCode, started.body).toBe(202)
          runId = started.json().run.id as string
        }
        cleanupRun = { workspaceId: workspace.id, id: runId }
        if (restartOnArtifacts) {
          artifactBoundary = await pool.connect()
          await beginTransaction(artifactBoundary)
          // Publication uses the real file ledger. Only output binding's INSERT
          // waits here, then rolls back under its production lock timeout.
          await artifactBoundary.query('lock table management_command_receipts in share mode')
        }
        observedRunId = runId
        const approved = new Set<string>()
        let restarted = false
        let approvalNativeLaunch: ReturnType<NativeProcessRegistry['snapshot']>['launches'][number] | undefined
        let state: string | undefined, outcome: string | undefined
        const runDeadline = Date.now() + (scenario.capLoop ? 420_000 : 180_000)
        let nextReconciliationAt = 0
        while (Date.now() < runDeadline) {
          if (restartOnArtifacts && !restarted) {
            const terminal = (await pool.query<{ execution: unknown; closed: boolean; published: boolean }>(
              `select e.record as execution,
                exists(select 1 from execution_native_closures c where c.execution_id=e.id and c.closed_at is not null) as closed,
                exists(select 1 from file_tool_publications p join files f on f.file_id=p.file_id
                  where f.execution_id=e.id and f.state='ready') as published
               from harness_executions e where e.run_id=$1 and e.record->>'state'='completed'`, [runId])).rows[0]
            if (terminal?.closed && terminal.published) {
              artifactCut = HarnessExecutionSchema.parse(terminal.execution)
              expect((await pool.query(`select 1 from management_command_receipts
                where operation='remote.native-artifact.output' and result->'producer'->>'runId'=$1`,
              [runId])).rowCount).toBe(0)
              await production.shutdown()
              await rollbackTransaction(artifactBoundary!)
              artifactBoundary!.release()
              artifactBoundary = undefined
              production = buildProductionApp(config, database, checkpoints, false)
              observeEngine(production)
              production.registerFileStorage()
              app = production.app
              await production.initialize()
              await app.listen({ host: config.host, port: config.port })
              await production.reconcile((error) => { throw error })
              restarted = true
            }
          }
          if (scenario.approval) {
            const pendingResponse: { statusCode: number; body: string; json(): unknown } = await app.inject({ method: 'GET',
              url: `/api/user/interactions?workspaceId=${encodeURIComponent(workspace.id)}&workflowId=${encodeURIComponent(managed.workflow.id)}&runId=${encodeURIComponent(runId)}&status=pending&limit=20`,
              headers: { host: 'localhost' } })
            expect(pendingResponse.statusCode, pendingResponse.body).toBe(200)
            const pending: ReturnType<typeof ListInteractionsResponseSchema.parse>['items'] =
              ListInteractionsResponseSchema.parse(pendingResponse.json()).items
            if (restartOnApproval && !restarted && pending.length) {
              expect(pending).toHaveLength(1)
              const current = (await pool.query<{ execution_state: string }>(
                'select execution_state from runs where id=$1', [runId])).rows[0]
              if (current?.execution_state !== 'waiting') {
                await new Promise((resolve) => setTimeout(resolve, 50))
                continue
              }
              const registry = new NativeProcessRegistry(join(runtimeRoot, 'native-process-registry'))
              const ownedLaunches = registry.snapshot().launches.filter(launch =>
                launch.owner === `execution:${pending[0]!.executionId}` && launch.lifecycle === 'active')
              expect(ownedLaunches).toHaveLength(1)
              approvalNativeLaunch = ownedLaunches[0]!
              expect(approvalNativeLaunch.guardian).toBeDefined()
              expect(approvalNativeLaunch.provider).toBeDefined()
              await production.shutdown()
              production = buildProductionApp(config, database, checkpoints, false)
              observeEngine(production)
              production.registerFileStorage()
              app = production.app
              await production.initialize()
              await app.listen({ host: config.host, port: config.port })
              await production.reconcile((error) => { throw error })
              const recoveredLaunches = registry.snapshot().launches.filter(launch =>
                launch.owner === approvalNativeLaunch!.owner && launch.lifecycle === 'active')
              expect(recoveredLaunches).toHaveLength(1)
              expect(recoveredLaunches[0]).toMatchObject({ launchId: approvalNativeLaunch.launchId,
                bootId: approvalNativeLaunch.bootId, guardian: approvalNativeLaunch.guardian,
                provider: approvalNativeLaunch.provider })
              restarted = true
              continue
            }
            for (const interaction of pending) {
              if (approved.has(interaction.id)) continue
              const request = interaction.request as { command?: unknown }
              const permitted = request.command === 'pwd' || request.command === '/bin/bash -lc pwd'
                || request.command === "/bin/bash -lc 'pwd'"
              if (interaction.nativeRequestType !== 'item/commandExecution/requestApproval' || !permitted) {
                throw new Error('The native provider asked for a command other than the read-only pwd command.')
              }
              const choice = interaction.responseOptions.find((option) => option.semantic === 'approve_once')
              assert.ok(choice)
              const response = await app.inject({ method: 'POST',
                url: `/api/user/interactions/${interaction.id}/respond`,
                headers: { host: 'localhost' },
                payload: { interactionId: interaction.id, optionId: choice.optionId, expectedRevision: interaction.revision } })
              if (response.statusCode === 409 && (response.json() as { error?: { code?: string } }).error?.code === 'REVISION_CONFLICT') {
                continue // The native request changed after the list read; refetch its current revision.
              }
              expect(response.statusCode, response.body).toBe(200)
              approved.add(interaction.id)
            }
          }
          // server.ts runs this recovery every five seconds alongside native observation.
          if (Date.now() >= nextReconciliationAt) {
            await production.reconcile(recordFailure)
            nextReconciliationAt = Date.now() + 5_000
          }
          const row = (await pool.query<{ execution_state: string; record: { outcome?: string } }>(
            'select execution_state,record from runs where id=$1', [runId])).rows[0]
          state = row?.execution_state; outcome = row?.record.outcome
          if (state === 'completed' || noRoute && state === 'waiting'
            && (await pool.query('select 1 from run_work_direction_waits where run_id=$1', [runId])).rowCount === 1) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const redact = nativePersistenceRedactor([...secrets])
        const runError = (await pool.query<{ code: string | null }>(
          `select record #>> '{result,error,code}' as code from runs where id=$1`, [runId])).rows[0]
        const executions = (await pool.query<{ id: string; state: string; outcome: string | null;
          code: string | null; message: string | null }>(
          `select id,record->>'state' as state,record #>> '{result,outcome}' as outcome,
            record #>> '{result,error,code}' as code,record #>> '{result,error,message}' as message
            from harness_executions where run_id=$1 order by id`, [runId])).rows
          .map(({ message, ...execution }) => ({ ...execution,
            message: message === null ? null : redact.text(message).slice(0, 2048),
            modelAtCapacity: message === 'Selected model is at capacity. Please try a different model.',
          }))
        const activityKinds = (await pool.query<{ kind: string }>(
          'select kind from run_activity where run_id=$1 order by sequence', [runId])).rows.map((row) => row.kind)
        const approvalProgress = (await pool.query<{ id: string; status: string; delivery: string | null;
          resume: string | null; acknowledged: boolean | null }>(`select i.id,i.status,
          i.record->>'deliveryState' as delivery,g.state as resume,
          g.approval_native_ack_id is not null as acknowledged from durable_interactions i
          left join interaction_graph_resumes g on g.interaction_id=i.id
          where i.run_id=$1 order by i.id`, [runId])).rows
        const invalidNativeResults = (await pool.query<{ execution_id: string; result: unknown }>(
          `select p.execution_id,p.record#>'{original,history,terminalTurn,result}' as result
            from workflow_native_proofs p join harness_executions e on e.id=p.execution_id
            where p.run_id=$1 and e.record#>>'{result,error,code}'='WORK_RESULT_INVALID'
              and p.record#>'{original,history,terminalTurn,result}' is not null
            order by p.proof_id limit 5`, [runId])).rows.map(row => ({
          executionId: row.execution_id, result: redact.text(JSON.stringify(row.result)).slice(0, 4096),
        }))
        const publicEvents = await app.inject({ method: 'GET', headers,
          url: `/api/management/workspaces/${workspace.id}/runs/${runId}/events?limit=500` })
        expect(publicEvents.statusCode, publicEvents.body).toBe(200)
        const publicPage = RunEventsPageSchema.parse(publicEvents.json())
        if (outcome !== (noRoute ? 'pending' : 'succeeded')) {
          await writeNativeAcceptanceEvidence(`handoff-failure-${randomUUID()}.json`,
            nativePersistenceRedactor([...secrets]).value({ scenario: scenario.name, runId, state, outcome,
              runError, executions, activityKinds, startupErrors, nativeFailures }))
        }
        if (scenario.capLoop) expect(publicPage.items.some((item) => item.kind === 'work_handoff_accepted'),
          JSON.stringify({ state, outcome, runError, executions, startupErrors })).toBe(true)
        expect({ state, outcome }, JSON.stringify({ runError, executions, activityKinds, startupErrors,
          approvalProgress, invalidNativeResults }))
          .toEqual({ state: noRoute ? 'waiting' : 'completed', outcome: noRoute ? 'pending' : 'succeeded' })
        if (artifacts) {
          if (restartOnArtifacts) expect(restarted).toBe(true)
          const records = (await pool.query<{ result: unknown }>(`select result from management_command_receipts
            where operation='remote.native-artifact.output' and result->'producer'->>'runId'=$1`, [runId])).rows
          expect(records).toHaveLength(1)
          const output = LocalNativeArtifactOutputSchema.parse(records[0]!.result)
          expect(output.outputKey).toBe('report')
          expect((await pool.query('select 1 from file_tool_publications where file_id=$1',
            [output.pins.fileId])).rowCount).toBe(1)
          expect((await pool.query('select 1 from execution_dispatch_intents where run_id=$1', [runId])).rowCount).toBe(0)
          if (artifactCut) {
            expect(output.producer.executionId).toBe(artifactCut.id)
            expect(output.nativeIdentity.nativeSessionId).toBe(artifactCut.nativeSessionId)
            expect((await pool.query<{ record: unknown }>('select record from harness_executions where id=$1',
              [artifactCut.id])).rows[0]!.record).toEqual(artifactCut)
          }
          const download = await app.inject({ method: 'GET', headers,
            url: `/api/workspaces/${workspace.id}/agent-chat/conversations/${output.scope.chat.conversationId}/files/${output.pins.fileId}/revisions/${output.pins.revisionId}/content` })
          expect(download.statusCode, download.body).toBe(200)
          expect(download.body).toBe('LOCAL_ARTIFACT_REPORT\n')
          const reader = new Client({ name: 'artifact-readback', version: '1.0.0' })
          mcpClients.push(reader)
          await reader.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
            { authProvider: { token: async () => writer.token } }))
          const readback = await reader.callTool({ name: 'run_get', arguments: { workspaceId: workspace.id, runId } })
          expect(readback.isError, JSON.stringify(readback)).not.toBe(true)
          expect(decodeMcpToolResult(readback)).toMatchObject({ run: { id: runId, outcome: 'succeeded' },
            executions: [expect.objectContaining({ id: output.producer.executionId, state: 'completed' })] })
        }
        if (noRoute) {
          expect(runError?.code).toBeNull()
          expect(activityKinds).toContain('work_needs_direction')
          expect(activityKinds).toContain('work_direction_wait')
          expect((await pool.query('select 1 from run_work_unresolved where run_id=$1',
            [runId])).rowCount).toBe(1)
        }
        if (restartOnApproval) {
          expect(restarted).toBe(true)
          expect(approved.size).toBe(1)
          expect((await pool.query('select id from harness_executions where run_id=$1 and workflow_node_id=$2',
            [runId, fixture.version.definition.nodes[approvalNode]!.id])).rowCount).toBe(1)
          expect((await pool.query('select activation_id from run_work_join_dispatches where run_id=$1',
            [runId])).rowCount).toBe(scenario.form === 'parallel' ? 1 : 0)
        }
        if (scenario.approval) {
          const nativeTypes = (await pool.query<{ type: string }>(`select e.record->>'type' as type
            from harness_native_events e join harness_executions x on x.id=e.execution_id
            where x.run_id=$1 order by e.sequence`, [runId])).rows.map((row) => row.type)
          expect(approved.size, JSON.stringify({ nativeTypes })).toBeGreaterThan(0)
          const approvalEvents = activityKinds.filter((kind) => kind.startsWith('interaction_'))
          expect(approvalEvents).toContain('interaction_decided')
          expect(approvalEvents).toContain('interaction_resolved')
          expect(approvalEvents).toContain('interaction_worker_ack')
          expect(approvalEvents.indexOf('interaction_decided')).toBeLessThan(
            approvalEvents.indexOf('interaction_worker_ack'))
          const approvalActivity = new Map<string, ReturnType<typeof RunActivitiesPageSchema.parse>['items'][number]>()
          let olderCursor: string | null = null
          for (let pageIndex = 0; pageIndex < 11; pageIndex++) {
            const response = await app.inject({ method: 'GET', headers,
              url: `/api/management/workspaces/${workspace.id}/runs/${runId}/activities?limit=100${
                olderCursor ? `&cursor=${encodeURIComponent(olderCursor)}` : ''}` })
            expect(response.statusCode, response.body).toBe(200)
            const page = RunActivitiesPageSchema.parse(response.json())
            for (const item of page.items) if (item.kind === 'approval') approvalActivity.set(item.id, item)
            olderCursor = page.olderCursor
            if (!olderCursor) break
          }
          const approvalStatuses = [...approvalActivity.values()].sort((a, b) =>
            BigInt(a.sequence)<BigInt(b.sequence) ? -1 : 1).map((item) => item.status)
          expect(approvalStatuses).toContain('recorded')
          expect(approvalStatuses).toContain('delivered')
          expect(approvalStatuses).toContain('acknowledged')
          expect(approvalStatuses.indexOf('recorded')).toBeLessThan(approvalStatuses.indexOf('acknowledged'))
        }
        expect((await pool.query('select 1 from run_work_results where run_id=$1', [runId])).rowCount)
          .toBe(scenario.capLoop ? scenario.attemptFourth ? 10 : finalAccepted ? 8 : 9 : configurations.length)
        expect((await pool.query('select 1 from run_repeat_executions where run_id=$1 and work_activation_id is not null',
          [runId])).rowCount).toBe(scenario.capLoop ? scenario.attemptFourth ? 10 : finalAccepted ? 8 : 9 : configurations.length)
        const nativeVersions = (await pool.query<{ harness: string; provider_version: string }>(`
          select s.reference->>'harness' as harness,s.reference->>'providerVersion' as provider_version
            from execution_native_sessions s join harness_executions e on e.id=s.execution_id
            where e.run_id=$1 order by e.workflow_node_id`, [runId])).rows
        if (scenario.capLoop) {
          const expectedSessions = 8 + Number(!finalAccepted) + Number(scenario.attemptFourth)
          expect(nativeVersions.map((item) => item.harness).sort())
            .toEqual(Array(expectedSessions).fill('codex'))
        } else expect(nativeVersions.map((item) => item.harness).sort()).toEqual([...scenario.providers].sort())
        expect(nativeVersions.every((item) => /^(?:codex-cli )?\d+\.\d+\.\d+$/.test(item.provider_version))).toBe(true)
        if (configurations.length > 1) {
          const usage = (await pool.query<{ used: number }>('select used from run_work_connection_usage where run_id=$1',
            [runId])).rows
          expect(usage).toHaveLength(graph.edges.length)
          expect(usage.map((item) => item.used).sort()).toEqual(scenario.capLoop ? [1, 1, 3] :
            Array(graph.edges.length).fill(1))
          expect((await pool.query('select 1 from run_work_requests where run_id=$1', [runId])).rowCount)
            .toBe(scenario.capLoop ? 5 : graph.edges.length)
          expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
            [runId, fixture.version.definition.nodes[0]!.id])).rowCount).toBe(1)
          const lineages = (await pool.query<{ request_id: string; source_digest: string; result_digest: string;
            recipient_request_id: string; recipient_digest: string; recipient_activation_id: string; destination_activation_id: string }>(`
              select r.request_id,r.payload_digest as source_digest,x.result_digest,
                coalesce(e.record #>> '{input,work,request,requestId}',
                  (select item #>> '{request,requestId}' from jsonb_array_elements(e.record #> '{input,work,sources}') item
                    where item #>> '{request,requestId}'=r.request_id)) as recipient_request_id,
                coalesce(e.record #>> '{input,work,request,payloadDigest}',
                  (select item #>> '{request,payloadDigest}' from jsonb_array_elements(e.record #> '{input,work,sources}') item
                    where item #>> '{request,requestId}'=r.request_id)) as recipient_digest,
                e.work_activation_id as recipient_activation_id,
                r.destination_activation_id
              from run_work_requests r join run_work_results x on x.execution_id=r.requester_execution_id
                join harness_executions e on e.work_activation_id=r.destination_activation_id
              where r.run_id=$1 order by r.request_id`, [runId])).rows
          expect(lineages).toHaveLength(scenario.capLoop ? 5 : graph.edges.length)
          for (const lineage of lineages) {
            expect(lineage.request_id).toBe(lineage.recipient_request_id)
            expect(lineage.source_digest).toBe(lineage.result_digest)
            expect(lineage.source_digest).toBe(lineage.recipient_digest)
            expect(lineage.destination_activation_id).toBe(lineage.recipient_activation_id)
          }
          if (scenario.form === 'parallel' && !scenario.capLoop) {
            const joins = (await pool.query<{ activation_id: string }>(`select activation_id
              from run_work_activations where run_id=$1 and cause_kind='join'`, [runId])).rows
            expect(joins).toHaveLength(1)
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and work_activation_id=$2',
              [runId, joins[0]!.activation_id])).rowCount).toBe(1)
          }
          if (scenario.capLoop) {
            const capUsage = (await pool.query<{ used: number }>(`select used from run_work_connection_usage
              where run_id=$1 and relationship_id=$2`, [runId, capEdges![1]!.id])).rows[0]
            expect(capUsage?.used).toBe(3)
            const handoffsHttp = await app.inject({ method: 'GET', headers,
              url: `/api/management/workspaces/${workspace.id}/runs/${runId}/handoffs` })
            expect(handoffsHttp.statusCode, handoffsHttp.body).toBe(200)
            const handoffs = RunHandoffsReadSchema.parse(handoffsHttp.json())
            expect(handoffs.connections.find((item) => item.relationshipId === capEdges![1]!.id))
              .toMatchObject({ used: 3, limit: 3, remaining: 0 })
            expect(handoffs.notices).toHaveLength(scenario.attemptFourth ? 2 : finalAccepted ? 0 : 1)
            if (noRoute) expect(handoffs).toMatchObject({ directionWait: true,
              unresolved: [expect.objectContaining({ reason: 'finish_with_findings' })] })
            const activityPath = `/api/management/workspaces/${workspace.id}/runs/${runId}/activities?limit=100`
            const activities = new Map<string, ReturnType<typeof RunActivitiesPageSchema.parse>['items'][number]>()
            let olderCursor: string | null = null
            for (let pageIndex = 0; pageIndex < 11; pageIndex++) {
              const response = await app.inject({ method: 'GET', headers,
                url: `${activityPath}${olderCursor ? `&cursor=${encodeURIComponent(olderCursor)}` : ''}` })
              expect(response.statusCode, response.body).toBe(200)
              const page = RunActivitiesPageSchema.parse(response.json())
              for (const item of page.items) activities.set(item.id, item)
              olderCursor = page.olderCursor
              if (!olderCursor) break
            }
            const activityItems = [...activities.values()]
            expect(activityItems.some((item) => item.kind === 'work_request')).toBe(true)
            expect(activityItems.some((item) => item.kind === 'work_return')).toBe(true)
            if (noRoute) expect(activityItems.some((item) => item.kind === 'needs_direction')).toBe(true)
            else if (!finalAccepted) {
              expect(activityItems.some((item) => item.kind === 'work_notice'
                && item.status === 'delivered')).toBe(true)
              expect(activityItems.some((item) => item.kind === 'reroute')).toBe(true)
            }
            expect((await pool.query('select 1 from run_work_denials where run_id=$1', [runId])).rowCount)
              .toBe(scenario.attemptFourth ? 1 : 0)
            const notice = (await pool.query<{ record: { message: string }; delivery_state: string }>(`
              select record,delivery_state from run_work_notices where run_id=$1`, [runId])).rows
            expect(notice).toHaveLength(scenario.attemptFourth ? 2 : finalAccepted ? 0 : 1)
            expect(notice.every((item) => item.record.message === 'The maximum number of work handoffs to agent C has been reached (3 of 3 for this Run). Choose another available agent or finish with the remaining findings.')).toBe(true)
            expect(notice.every((item) => item.delivery_state === 'delivered')).toBe(true)
            const returns = (await pool.query<{ outcome: string }>(`select outcome from run_work_returns
              where run_id=$1 order by returned_at`, [runId])).rows
            expect(returns.map((item) => item.outcome).sort()).toEqual(
              (finalAccepted ? ['accepted', 'accepted', 'needs_changes', 'needs_changes']
                : ['accepted', 'needs_changes', 'needs_changes', 'needs_changes']).sort())
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
              [runId, fixture.version.definition.nodes[0]!.id])).rowCount).toBe(1)
            expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
              [runId, fixture.version.definition.nodes[2]!.id])).rowCount).toBe(3)
            if (finalAccepted) expect((await pool.query(`select 1 from harness_executions
              where run_id=$1 and workflow_node_id=$2`,
            [runId, fixture.version.definition.nodes[1]!.id])).rowCount).toBe(3)
            if (scenario.attemptFourth) expect((await pool.query(`select 1 from run_work_activations
              where run_id=$1 and cause_kind='limit_denial'`, [runId])).rowCount).toBe(1)
          }
          if (scenario.review) {
            const returned = (await pool.query<{ outcome: string; continuation: string | null }>(
              'select outcome,requester_continuation_activation_id as continuation from run_work_returns where run_id=$1',
              [runId])).rows
            expect(returned).toEqual([{ outcome: 'accepted', continuation: null }])
            expect((await pool.query('select 1 from run_work_activations where run_id=$1 and workflow_node_id=$2',
              [runId, fixture.version.definition.nodes[0]!.id])).rowCount).toBe(1)
          }
        }
        await production.reconcile((error) => { throw error })
        if (noRoute) {
          expect((await pool.query<{ execution_state: string }>('select execution_state from runs where id=$1',
            [runId])).rows[0]?.execution_state).toBe('waiting')
          const stop = await app.inject({ method: 'POST', headers,
            url: `/api/management/workspaces/${workspace.id}/runs/${runId}/stop`,
            payload: { workspaceId: workspace.id, runId, commandId: randomUUID() } })
          expect(stop.statusCode, stop.body).toBe(200)
          const stopDeadline = Date.now() + 30_000
          while (Date.now() < stopDeadline) {
            const row = (await pool.query<{ execution_state: string }>(
              'select execution_state from runs where id=$1', [runId])).rows[0]
            if (row?.execution_state === 'completed') break
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          expect((await pool.query<{ execution_state: string; outcome: string }>(
            `select execution_state,record->>'outcome' as outcome from runs where id=$1`,
            [runId])).rows[0]).toEqual({ execution_state: 'completed', outcome: 'canceled' })
          const stopKinds = (await pool.query<{ kind: string }>(
            `select kind from run_activity where run_id=$1
              and kind in ('run_stop_requested','run_cleanup_checked') order by sequence`,
            [runId])).rows.map((row) => row.kind)
          expect(stopKinds).toContain('run_stop_requested')
          expect(stopKinds).toContain('run_cleanup_checked')
          const stoppedActivities = await app.inject({ method: 'GET', headers,
            url: `/api/management/workspaces/${workspace.id}/runs/${runId}/activities?limit=100` })
          expect(stoppedActivities.statusCode, stoppedActivities.body).toBe(200)
          const stopPage = RunActivitiesPageSchema.parse(stoppedActivities.json())
          expect(stopPage.items.some((item) => item.kind === 'stop')).toBe(true)
          expect(stopPage.items.some((item) => item.kind === 'recovery')).toBe(true)
        }
        let cleanupPending = true
        const cleanupDeadline = Date.now() + 15_000
        while (Date.now() < cleanupDeadline) {
          cleanupPending = (await pool.query<{ pending: boolean }>(
            'select pending from run_cleanup_intents where run_id=$1', [runId])).rows[0]?.pending ?? true
          if (!cleanupPending) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(cleanupPending).toBe(false)
        const liveCredentials = (await pool.query<{ count: string }>(`select count(*)::text as count
          from worker_credential_bindings b join management_principals p on p.id=b.principal_id
          where b.run_id=$1 and p.revoked_at is null`, [runId])).rows[0]
        expect(Number(liveCredentials?.count)).toBe(0)
      }
      try { await verify() }
      catch (error) {
        failure = { error }
        const directory = process.env.ENG03_A_EVIDENCE_DIR
        if (directory) {
          try {
            const executions = observedRunId ? (await pool.query(
              'select id,record from harness_executions where run_id=$1 order by id limit 16',
              [observedRunId],
            )).rows : []
            const handoffs = observedRunId ? {
              requests: (await pool.query('select * from run_work_requests where run_id=$1', [observedRunId])).rows,
              returns: (await pool.query('select * from run_work_returns where run_id=$1', [observedRunId])).rows,
              results: (await pool.query('select * from run_work_results where run_id=$1', [observedRunId])).rows,
            } : undefined
            const evidence = nativePersistenceRedactor([...secrets]).value({
              scenario: scenario.name, runId: observedRunId, nativeFailures, cancellations, executions, handoffs,
              run: observedRunId ? (await pool.query('select record from runs where id=$1', [observedRunId])).rows : [],
              runControl: observedRunId ? (await pool.query(
                `select stop_requested_at is not null as stopped,
                  exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
                  from runs r where r.id=$1`, [observedRunId])).rows : [],
              nativeInputsAndResults: observedRunId ? (await pool.query(
                'select id,record from harness_executions where run_id=$1 order by id limit 16', [observedRunId])).rows : [],
              deliveryAttempts: observedRunId ? (await pool.query(
                `select a.interaction_id,a.state,a.error from interaction_delivery_attempts a
                  join durable_interactions i on i.id=a.interaction_id where i.run_id=$1 limit 16`, [observedRunId])).rows : [],
              failure: describeNativeFailure(error, [...secrets]),
            })
            const filename = `native-workflow-failure-${randomUUID()}.json`
            await writeNativeAcceptanceEvidence(filename, evidence)
            console.info('Private native workflow failure evidence:', join(directory, filename))
          } catch (evidenceError) {
            failure = { error: new AggregateError([error, evidenceError],
              'Native failure evidence could not be retained.', { cause: error }) }
          }
        }
      }
      executionObserver.mockRestore()
      validationObserver.mockRestore()
      attachmentObserver.mockRestore()
      sessionObserver.mockRestore()
      cancellationObserver.mockRestore()
      mcpFailureObserver.mockRestore()
      artifactObserver.mockRestore()
      const cleanupErrors: unknown[] = []
      if (artifactBoundary) {
        try { await rollbackTransaction(artifactBoundary) }
        catch (error) { cleanupErrors.push(error) }
        finally { artifactBoundary.release() }
      }
      if (failure && cleanupRun && app) {
        try {
          const current = (await pool.query<{ execution_state: string }>(
            'select execution_state from runs where id=$1', [cleanupRun.id])).rows[0]
          if (current && current.execution_state !== 'completed') {
            const stopped = await app.inject({ method: 'POST',
              headers: { host: 'localhost' },
              url: `/api/management/workspaces/${cleanupRun.workspaceId}/runs/${cleanupRun.id}/stop`,
              payload: { workspaceId: cleanupRun.workspaceId, runId: cleanupRun.id, commandId: randomUUID() } })
            if (stopped.statusCode !== 200) throw new Error(`Owned native cleanup Stop failed: ${stopped.body}`)
          }
        } catch (error) { cleanupErrors.push(error) }
      }
      const clients = await Promise.allSettled(mcpClients.map(client => client.close()))
      inspectionObserver.mockRestore()
      for (const result of clients) if (result.status === 'rejected') cleanupErrors.push(result.reason)
      try { await production?.shutdown() }
      catch (error) { cleanupErrors.push(error) }
      try { await production?.drainShutdown() }
      catch (error) { cleanupErrors.push(error) }
      const resources = await Promise.allSettled([checkpoints.close(), database.close()])
      for (const result of resources) if (result.status === 'rejected') cleanupErrors.push(result.reason)
      if (cleanupErrors.length) {
        if (failure) cleanupErrors.unshift(failure.error)
        throw new AggregateError(cleanupErrors, 'Native workflow verification or cleanup failed.',
          { cause: failure?.error ?? cleanupErrors[0] })
      }
      await removeFixtureDirectory(directory)
      if (failure) throw failure.error
    })
  }, 600000)
})
