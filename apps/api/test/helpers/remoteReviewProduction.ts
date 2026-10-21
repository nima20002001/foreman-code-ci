import { readUntil } from './observableCondition.js'
import { callProductionMcpTool } from './productionMcpCall.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID, sign, X509Certificate } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  DurableInteractionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { HarnessOptionsResultSchema, ManagedWorkspaceSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { ComputerSyncStatusSchema } from '@foreman-code/contracts/computer-accounts'
import { DevicePairingGrantResultSchema, DevicePairingResultSchema, MainDeviceIdentityPublicSchema,
  WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { loadOrCreateWorkerIdentity, persistWorkerPairing, pairingProof } from '@foreman-code/contracts/device-identity-node'
import { HarnessRegistryReadbackSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import { SourceApproveResultSchema, SourceRootBindResultSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootListResultSchema } from '@foreman-code/contracts/workspace-root-policies'
import { WorkspaceBoundLocationSetResultSchema,
  WorkspaceRootConfigurationAdoptResultSchema } from '@foreman-code/contracts/workspace-bound-location'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  ManualRunStartResultSchema, SavedRunDetailsSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { loadConfig } from '../../src/config.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { installManagedLauncher } from '../../src/modules/harnesses/appMcpLauncher.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { InstalledWorkflowRecovery } from '../../src/modules/runs/remote/installedWorkflowRecovery.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { seedAgent3 } from './wave25Agent3.js'
import { migratedDatabase } from './migratedDatabase.js'
import { buildRemoteReviewWorkerRelease, createRemoteReviewProvider, createRemoteReviewTls,
  createRemoteReviewClaudeInventory } from './remoteReviewProvider.js'
import { createRemoteReviewTransport } from './remoteReviewTransport.js'
import { gitFixtureEnvironment } from './gitFixture.js'
import { remoteReviewEnvironment } from './remoteReviewEnvironment.js'
import { configureRemoteReviewGitHub } from './remoteReviewGitHub.js'
import { waitForChildReady } from './remoteReviewReadiness.js'
import { measureIntegrationPhase, reportIntegrationPhase } from './integrationPhase.js'
import { remoteReviewWorkerArtifacts } from './remoteReviewWorkerArtifacts.js'
import { testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'
import { remoteReviewChanges } from './remoteReviewChanges.js'
import { remoteReviewReconciliation } from './remoteReviewReconciliation.js'
import { installedRestartService } from './installedRestartService.js'
import type { RuntimeTimingRecord } from '../../src/modules/diagnostics/runtimeTiming.js'

const execute = promisify(execFile)
const tsxLoader = createRequire(import.meta.url).resolve('tsx')

export async function waitForRemoteReview<T>(read: () => Promise<T>, accept: (value: T) => boolean,
  description: string, subscribe?: (changed: () => void) => () => void): Promise<T> {
  return readUntil(read, accept, {
    timeoutMs: 90_000,
    description,
    minimumReadIntervalMs: 1_000,
    ...(subscribe ? { subscribe } : {}),
  })
}

/** Probed ports are released before use, so a later probe can return one already reserved for Main. */
async function freePort(...taken: number[]): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port.')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return taken.includes(address.port) ? freePort(...taken) : address.port
}

async function postDeviceJson(endpoint: string, certificate: Buffer, payload: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const call = request(endpoint, { method: 'POST', ca: certificate,
      headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Device pairing returned ${response.statusCode}.`))
          return
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
      response.on('error', reject)
    })
    call.on('error', reject)
    call.end(JSON.stringify(payload))
  })
}

/** Fresh production instances share only persisted data; the Worker runs the
 * shipped installed domains in a separate process with its own native owners. */
export async function remoteReviewProduction(options: {
  workflow?: 'approval' | 'sequential' | 'single' | 'interval'
  modelCatalog?: 'empty-at-startup'; executionHost?: 'main' | 'worker'
  claudeInventory?: boolean; parallelProfileChecks?: boolean; reuseMatchingProfiles?: boolean
  workerRelease?: string | Promise<string>
  installationRefreshIntervalMs?: number; parallelSetup?: boolean; includeNodeRuntimePayload?: boolean
  installedMainService?: boolean
  sourceAccessMode?: 'read-only' | 'exclusive-write'
  artifactOutputKeys?: string[]
  profilePostgres?: true
  reportPhase?: (phase: string, elapsedMs: number) => void
} = {}) {
  const rootAccessMode = options.sourceAccessMode === 'exclusive-write' ? 'read-write' : 'read-only'
  const reportPhase = (phase: string, elapsedMs: number) => {
    reportIntegrationPhase(phase, elapsedMs)
    options.reportPhase?.(phase, elapsedMs)
  }
  let phase = 'fixture resources'
  let phaseStarted = performance.now()
  const beginPhase = (next: string) => {
    reportPhase(phase, performance.now() - phaseStarted)
    phase = next
    phaseStarted = performance.now()
  }
  const closes: Array<() => Promise<void>> = []
  const mcpClients = new Set<Client>()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(cleanup)
    return closing
  }
  const cleanup = async () => {
    // Client streams must release their HTTP requests before Main drains its listener.
    const clientClosures = await Promise.allSettled([...mcpClients].map(client => client.close()))
    mcpClients.clear()
    const errors: unknown[] = clientClosures.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [])
    while (closes.length) {
      try { await closes.pop()!() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Remote review fixture cleanup failed.')
  }
  try {
    const directory = await privateFixtureDirectory('remote-review-production-')
    closes.push(() => rm(directory, { recursive: true, force: true }))
    const launcher = join(directory, 'app-mcp', 'launcher.mjs')
    const claudeDirectory = join(directory, 'claude-inventory')
    const setupDatabase = () => measureIntegrationPhase('fixture database', async () => {
      const db = await migratedDatabase()
      closes.push(db.close)
      return db
    })
    const setupProvider = () => measureIntegrationPhase('provider fixture', async () => {
      await installManagedLauncher(new URL('../../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
      return createRemoteReviewProvider(join(directory, 'provider'), launcher)
    })
    const workerReleaseResult = Promise.allSettled([
      options.workerRelease ?? buildRemoteReviewWorkerRelease(directory),
    ] as const)
    closes.push(async () => { await workerReleaseResult })
    const setupClaude = () => measureIntegrationPhase('Claude fixture',
      () => createRemoteReviewClaudeInventory(claudeDirectory))
    const setupTls = () => measureIntegrationPhase('fixture TLS', () => createRemoteReviewTls(join(directory, 'tls')))
    const setup = async () => {
      if (!options.parallelSetup) {
        return [await setupDatabase(), await setupProvider(),
          await setupClaude(), await setupTls()] as const
      }
      const tasks = [setupDatabase(), setupProvider(), setupClaude(), setupTls()] as const
      try {
        return await Promise.all(tasks)
      } catch (error) {
        // Setup processes must settle before cleanup removes their working directories.
        await Promise.allSettled(tasks)
        throw error
      }
    }
    const [db, provider, claudeCommands, tls] = await setup()
    const changes = await remoteReviewChanges(db.pool)
    closes.push(changes.close)
    beginPhase('source repository and workflow seed')
    const claudeInventory = options.claudeInventory ? claudeCommands : undefined
    if (options.modelCatalog) await provider.hideModels()
    const certificate = await readFile(tls.certificateFile)
    const project = join(directory, 'projects', 'project')
    const runtime = join(directory, 'main-runtime')
    const stateDirectory = join(directory, 'worker-state')
    const workerProject = join(directory, 'worker-projects', 'project')
    const workerRuntime = join(directory, 'worker-runtime')
    const claudeProfile = join(directory, 'claude-profile')
    const logEnvironment = remoteReviewEnvironment(claudeDirectory, claudeProfile, launcher)
    const workerEnvironment = remoteReviewEnvironment(join(directory, 'worker-home'), claudeProfile, launcher,
      logEnvironment)
    for (const path of [project, runtime, stateDirectory, workerProject, workerRuntime, claudeProfile]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
    for (const environment of [logEnvironment, workerEnvironment]) {
      for (const key of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
        'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
        await mkdir(environment[key]!, { recursive: true, mode: 0o700 })
      }
    }
    // The Codex fixture never chooses an ambient Claude model during startup.
    const claude = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'claude-haiku-4-5-20251001',
      configDirectory: claudeProfile, authMode: 'subscription', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: [], permissionRules: [], instructions: '', mcpServers: {} })
    await db.pool.query(`insert into application_settings(key,record,revision)
      values('harness-defaults',$1::jsonb,1)`, [JSON.stringify({ claude })])
    await writeFile(join(project, 'README.md'), '# Remote review fixture\n', { mode: 0o600 })
    const gitOptions = { env: gitFixtureEnvironment() }
    await execute('git', ['init', '--quiet', '--initial-branch=main', project], gitOptions)
    await execute('git', ['-C', project, 'add', 'README.md'], gitOptions)
    await execute('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Source fixture'], gitOptions)
    const commit = (await execute('git', ['-C', project, 'rev-parse', 'HEAD'], gitOptions)).stdout.trim()
    const repository = { provider: 'github', owner: 'remote-review-fixture',
      name: randomUUID(), defaultBranch: 'main' }
    const repositoryName = `${repository.owner}/${repository.name}`
    await configureRemoteReviewGitHub({ project, origin: join(directory, 'github.git'), repository: repositoryName,
      homes: [logEnvironment.HOME!, workerEnvironment.HOME!] })
    const shape = options.workflow === 'interval' ? 'sequential' : options.workflow ?? 'approval'
    const seed = makeCurrentWorkflowFixture(randomUUID(), shape)
    if (options.artifactOutputKeys) seed.version.definition.nodes[0]!.artifactOutputs = {
      version: 1, outputKeys: options.artifactOutputKeys,
    }
    if (options.workflow === 'interval') {
      seed.version.definition.handoffs = { contractVersion: 1 }
      seed.version.definition.nodes[0]!.interval = { everySeconds: 10 }
      seed.version.definition.executionPolicy!.maxParallelism = 2
    }
    seed.configurations = seed.configurations.map((configuration, index) => {
      let systemPrompt = shape === 'sequential' || index === 0 ? 'fixture-reviewer' : 'fixture-requester'
      if (options.workflow === 'interval') systemPrompt += ' fixture-work-handoff'
      if (options.sourceAccessMode === 'exclusive-write') systemPrompt += ' fixture-write-source'
      return AgentConfigurationVersionSchema.parse({
        ...configuration, prompt: { system: systemPrompt },
        harness: { ...configuration.harness, model: 'test-model',
          ...(options.sourceAccessMode === 'exclusive-write' ? { sandbox: 'workspace-write' } : {}),
          ...(options.artifactOutputKeys ? { advanced: {
            ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
            workspaceWrite: { networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          } } : {}),
          ...(options.workflow === 'interval' ? { advanced: {
            ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never',
          } } : {}) },
      })
    })
    const saved = await seedAgent3(db.pool, project, seed, { run: false })
    const config = loadConfig({ DATABASE_URL: db.databaseUrl, PORT: String(await freePort()),
      HARNESS_WORKSPACE_ROOT: runtime, FILE_STORAGE_ROOT: join(directory, 'files'),
      CODEX_BINARY: provider.binary,
      DATABASE_QUERY_TIMEOUT_MS: '10000', FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1' })
    config.workspaceStorageRoot = join(directory, 'projects')
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Remote review owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 900_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
    let devicePort = await freePort(config.port)
    let deviceEndpoint = `wss://127.0.0.1:${devicePort}/device/connect`
    const infrastructure = { mode: 'native' as const,
      installationRefreshIntervalMs: options.installationRefreshIntervalMs,
      deviceListener: { ...tls, host: '127.0.0.1', port: devicePort, advertisedEndpoint: deviceEndpoint } }
    const mainConfiguration = join(directory, 'main-configuration.json')
    await writeFile(mainConfiguration, JSON.stringify({ config, infrastructure, claudeInventory: claudeInventory?.sdk }),
      { mode: 0o600 })
    const [release] = await workerReleaseResult
    if (release.status === 'rejected') throw release.reason
    const workerRelease = release.value
    logEnvironment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY = await measureIntegrationPhase(
      'Worker update artifacts', () => remoteReviewWorkerArtifacts(workerRelease, testFixtureCacheRoot(),
        { publication: 'published' }))
    workerEnvironment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY = logEnvironment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY
    let main: ChildProcess | undefined
    const mainService = options.installedMainService
      ? await installedRestartService(directory, mainConfiguration, logEnvironment, runtime) : undefined
    if (mainService) closes.push(mainService.close)
    if (mainService) await execute(provider.binary, ['--version'], { env: logEnvironment })
    let mainFailure = ''
    let workerFailure = ''
    const failures: Array<{ code: string; runId: string | null; namespace?: unknown; tool?: unknown;
      phase?: unknown; errorType?: unknown; errorLocation?: unknown; errorDetail?: string | undefined;
      role?: 'Main' | 'Worker'; message?: string | undefined; reason?: string | undefined; time?: unknown }> = []
    let failuresSeen = 0
    let databaseProfile: unknown
    let origin = ''
    const stopMain = async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (mainService) {
        if (signal !== 'SIGTERM') throw new Error('Installed restart fixtures use graceful systemd shutdown.')
        await mainService.stop()
        return
      }
      if (!main || main.exitCode !== null || main.signalCode !== null) return
      const stopped = main
      await new Promise<void>((resolve, reject) => {
        stopped.once('error', reject)
        stopped.once('exit', code => {
          if (signal === 'SIGTERM' && code !== 0) reject(new Error(`Production Main cleanup failed: ${mainFailure}\nNative failure codes: ${JSON.stringify(failures.slice(-16))}`))
          else resolve()
        })
        stopped.kill(signal)
      })
    }
    closes.push(stopMain)
    const collectFailures = (child: ChildProcess, role: 'Main' | 'Worker') => {
      let pendingLog = ''
      child.stdout!.on('data', chunk => {
        pendingLog = `${pendingLog}${String(chunk)}`.slice(-65536)
        const lines = pendingLog.split('\n')
        pendingLog = lines.pop()!
        for (const line of lines) {
          let parsed: unknown
          try { parsed = JSON.parse(line) } catch { continue }
          if (!parsed || typeof parsed !== 'object') continue
          if ('diagnostic' in parsed && parsed.diagnostic === 'runtime-timing' && options.reportPhase) {
            const timing = parsed as RuntimeTimingRecord & { diagnostic: 'runtime-timing' }
            // Per-query logging fills the runner's log cap before native failures are reported.
            if (timing.component === 'db') continue
            console.info(`[remote-review] ${role} timing`, {
              component: timing.component, phase: timing.phase, operation: timing.operation,
              startedAt: timing.startedAt, finishedAt: timing.finishedAt, durationMs: timing.durationMs,
              intervalMs: timing.intervalMs, reused: timing.reused, count: timing.count,
              runId: timing.runId, executionId: timing.executionId, nativeSessionId: timing.nativeSessionId,
              laneId: timing.laneId, correlationId: timing.correlationId, ownerId: timing.ownerId,
              nativeTurnId: timing.nativeTurnId, eventType: timing.eventType, success: timing.success,
            })
          }
          const event = parsed as { level?: unknown; code?: unknown; errorCode?: unknown; stackFrames?: unknown;
            namespace?: unknown; tool?: unknown; runId?: unknown; err?: { code?: unknown; stack?: unknown; message?: unknown;
              type?: unknown; cause?: { stack?: unknown } }; msg?: unknown;
            phase?: unknown; errorType?: unknown; errorLocation?: unknown; reason?: unknown }
          const code = event.err?.code ?? event.code ?? event.errorCode
            ?? (event.msg === 'Device extension request failed' ? 'DEVICE_EXTENSION_FAILED' : undefined)
            ?? (event.msg === 'Operator tool failed' ? 'OPERATOR_TOOL_FAILED' : undefined)
          if (!['warn', 'error', 'fatal'].includes(String(event.level)) || typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(code)) continue
          const frames = Array.isArray(event.stackFrames)
            ? event.stackFrames.filter((frame): frame is string => typeof frame === 'string').slice(0, 4) : []
          if (typeof event.err?.cause?.stack === 'string') {
            frames.push(...event.err.cause.stack.split('\n').slice(1, 5).map(frame => `cause: ${frame}`))
          }
          const sourceMessage = event.err?.message
          const errorDetail = code === 'source-reconciliation-unconfirmed' && typeof sourceMessage === 'string'
            && /^Process \d+ (?:still |could not be inspected|exceeded )/.test(sourceMessage)
            ? sourceMessage.slice(0, 200)
            : typeof sourceMessage === 'string'
              && /^(The submitted native turn was not found|Reconcile the correlation|A different native turn is still active|More than one native turn has this correlation|The original physical reply|Session continuation requires the closed execution)/.test(sourceMessage)
              ? sourceMessage.slice(0, 200) : undefined
          failuresSeen += 1
          const reason = event.reason
          failures.push({ role, reason: typeof reason === 'string' && /^[a-z][a-z0-9_]{1,64}$/.test(reason)
            ? reason : undefined, message: typeof event.msg === 'string' ? event.msg.slice(0, 160) : undefined,
            time: (parsed as { time?: unknown }).time, code, phase: event.phase, errorType: event.errorType ?? event.err?.type,
            errorDetail, tool: typeof event.tool === 'string' ? event.tool : undefined,
            namespace: typeof event.namespace === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(event.namespace)
              ? event.namespace : undefined,
            errorLocation: event.errorLocation ?? (frames.length ? frames.map(frame => frame.trim()).join(' ') : undefined)
              ?? (typeof event.err?.stack === 'string'
              ? event.err.stack.split('\n').slice(1, 5).map(line => line.trim()).join(' ') : undefined),
            runId: typeof event.runId === 'string' && /^run-[a-z0-9-]{1,100}$/.test(event.runId) ? event.runId : null })
          if (failures.length > 32) failures.splice(16, 1)
        }
      })
    }
    const startMain = async (workingDirectory = fileURLToPath(new URL('../../../..', import.meta.url))) => {
      if (mainService) {
        const ready = await mainService.start()
        if (!ready) throw new Error('Installed API readiness was not published.')
        origin = ready.origin
        return
      }
      let ready = false
      mainFailure = ''
      const started = spawn(process.execPath, [
        '--import', tsxLoader,
        ...(options.profilePostgres
          ? ['--import', fileURLToPath(new URL('../fixtures/postgres-profile.mjs', import.meta.url))] : []),
        fileURLToPath(new URL('../fixtures/remote-review-main.mjs', import.meta.url)), mainConfiguration], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: logEnvironment,
      })
      main = started
      collectFailures(started, 'Main')
      started.stderr!.on('data', chunk => { mainFailure = `${mainFailure}${String(chunk)}`.slice(-16384) })
      started.on('message', message => {
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'pg-profile') databaseProfile = message
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'ready'
          && 'origin' in message && typeof message.origin === 'string') {
          origin = message.origin
          ready = true
        }
      })
      await waitForChildReady(started, () => ready, 'production Main startup',
        () => `Production Main exited: ${mainFailure}`)
    }
    beginPhase('Main startup')
    for (let attempt = 0; ; attempt++) {
      try {
        await startMain()
        break
      } catch (error) {
        if (mainService || attempt >= 2 || main?.exitCode === null || !mainFailure.includes('EADDRINUSE')) {
          throw error
        }
        // Port probes release their sockets before the child binds; another listener can win that race.
        config.port = await freePort()
        devicePort = await freePort(config.port)
        deviceEndpoint = `wss://127.0.0.1:${devicePort}/device/connect`
        infrastructure.deviceListener.port = devicePort
        infrastructure.deviceListener.advertisedEndpoint = deviceEndpoint
        await writeFile(mainConfiguration,
          JSON.stringify({ config, infrastructure, claudeInventory: claudeInventory?.sdk }), { mode: 0o600 })
      }
    }
    beginPhase('startup model catalog')
    const clients = new Map<string, Promise<Client>>()
    let startupCatalog: ReturnType<typeof HarnessOptionsResultSchema.parse> | undefined
    if (options.modelCatalog) {
      await waitForRemoteReview(async () => (await db.pool.query<{ record: unknown }>(
        "select record from application_settings where key='harness-default-model-unavailable'",
      )).rows[0]?.record, value => Array.isArray(value) && value.includes('codex'),
      'persisted unavailable startup model defaults')
      startupCatalog = HarnessOptionsResultSchema.parse(await value('harness_options_get', { harness: 'codex' }))
      await provider.showModels()
    }
    async function call(name: string, args: Record<string, unknown>, token = writer.token) {
      let connected = clients.get(token)
      if (!connected) {
        // One SDK counter per credential keeps parallel calls distinct on the stateless endpoint.
        const client = new Client({ name: 'Production remote review integration', version: '1' })
        mcpClients.add(client)
        connected = client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
          authProvider: { token: async () => token },
        })).then(() => client)
        clients.set(token, connected)
      }
      const client = await connected
      return callProductionMcpTool(client, { name, arguments: args })
    }
    async function value(name: string, args: Record<string, unknown>) {
      const seenBefore = failuresSeen
      const response = await call(name, args)
      if (response.isError) {
        // Main logs an unclassified tool failure asynchronously; report it with the error instead of a stale list.
        if (JSON.stringify(response.content).includes('INTERNAL_ERROR')) {
          await readUntil(async () => failures.slice(Math.max(0, failures.length - (failuresSeen - seenBefore))),
            recent => recent.some(failure => failure.tool === name),
            { timeoutMs: 1_000, minimumReadIntervalMs: 25, description: `the Main log of the failed ${name}` })
            .catch((error: unknown) => {
              // ignore: the failure is reported below without the Main log line when none arrives.
              void error
            })
        }
        throw new Error(`${name}: ${JSON.stringify(response.content)}\nNative failure codes: ${JSON.stringify(failures.slice(-8))}`
          + `\nMain stderr: ${mainFailure.slice(-2000)}\nWorker stderr: ${workerFailure.slice(-2000)}`)
      }
      return decodeMcpToolResult(response)
    }
    const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    beginPhase('source approval and Worker pairing')
    const mainHost = { kind: 'main' as const, mainId }
    // This fixture exercises native review and source transfer without installing shared-file services.
    const syncTarget = { hostRef: mainHost, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }
    await value('computer_sync_update', {
      commandId: randomUUID(), workspaceId: saved.scope.workspaceId, expectedRevision: 0, enabled: false,
      target: syncTarget,
    })
    const sync = ComputerSyncStatusSchema.parse(await value('computer_sync_status', { target: syncTarget }))
    if (!sync.folders.some(folder => folder.workspaceId === saved.scope.workspaceId && !folder.enabled)) {
      throw new Error('Remote review fixture shared-file sync was not disabled.')
    }
    const approveSource = async () => {
      const mainChoices = WorkspaceRootListResultSchema.parse(await value('workspace_root_choices_list', {
        workspaceId: saved.scope.workspaceId,
      }))
      const mainAllowlist = mainChoices.allowlists.find(allowlist => allowlist.hostRef.kind === 'main')!
      const mainLocation = WorkspaceBoundLocationSetResultSchema.parse(await value('workspace_root_location_set', {
        workspaceId: saved.scope.workspaceId, commandId: randomUUID(), hostRef: mainHost,
        allowedBaseId: mainAllowlist.bases[0]!.baseId, configurationRevision: mainAllowlist.configurationRevision,
        relativePath: 'project', accessMode: rootAccessMode,
        expectedLocationRevision: 1, expectedRootPolicyRevision: 0,
      })).value
      const workspace = ManagedWorkspaceSchema.parse(await value('workspace_get', {
        workspaceId: saved.scope.workspaceId,
      }))
      await value('workspace_update', { workspaceId: saved.scope.workspaceId, commandId: randomUUID(),
        expectedRevision: workspace.revision, repository })
      const configured = ManagedWorkspaceSchema.parse(await value('workspace_get', {
        workspaceId: saved.scope.workspaceId,
      }))
      const persistedRepository = configured.workspace.repository
      if (!persistedRepository || `${persistedRepository.owner}/${persistedRepository.name}` !== repositoryName) {
        throw new Error('Remote review workspace GitHub repository was not persisted.')
      }
      const approved = SourceApproveResultSchema.parse(await value('source_approve', {
        workspaceId: saved.scope.workspaceId, commandId: randomUUID(),
        expectedLocationRevision: mainLocation.locationRevision, commit,
        executablePolicy: 'strip',
      })).value
      return { mainLocation, approved }
    }
    const pairWorker = async () => {
      const identity = await loadOrCreateWorkerIdentity(stateDirectory)
      const grant = DevicePairingGrantResultSchema.parse(await value('device_pairing_grant_create', {
        commandId: randomUUID(), workerInstallationId: identity.workerInstallationId,
        publicKey: identity.publicKey, expectedFingerprint: identity.publicKeyFingerprint, scopes: ['connect', 'heartbeat'],
      }))
      const publicMain = MainDeviceIdentityPublicSchema.parse(await value('device_main_identity_get', {}))
      const unsignedPairing = { mainId, workerInstallationId: identity.workerInstallationId,
        publicKey: identity.publicKey, grant: grant.grant, requestId: randomUUID() }
      const pairingRequest = { ...unsignedPairing, signature: sign(null, Buffer.from(pairingProof(unsignedPairing)),
        identity.privateKey).toString('base64url') }
      const paired = DevicePairingResultSchema.parse(await postDeviceJson(
        `https://127.0.0.1:${devicePort}/device/pair`, certificate, pairingRequest))
      return { identity, publicMain, paired }
    }
    // Both chains use the real endpoint; neither depends on the other's persisted result.
    const [sourceResult, pairingResult] = await Promise.allSettled([
      measureIntegrationPhase('source approval', approveSource),
      measureIntegrationPhase('Worker pairing', pairWorker),
    ])
    if (sourceResult.status === 'rejected' || pairingResult.status === 'rejected') {
      const errors = [sourceResult, pairingResult].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      throw new AggregateError(errors, 'Remote source approval or Worker pairing failed.')
    }
    const { mainLocation, approved } = sourceResult.value
    const { identity, publicMain, paired } = pairingResult.value
    let denyReservedResponse = false
    let pausedDiscovery: {
      entered(): void; release(outcome?: 'cancel'): void; waiting: Promise<void | 'cancel'>
    } | undefined
    const releaseWorkerDiscovery = async () => {
      pausedDiscovery?.release()
      pausedDiscovery = undefined
    }
    closes.push(releaseWorkerDiscovery)
    let deniedResponse: ReturnType<typeof RemoteOwnerControlSchema.parse> | undefined
    const transport = await createRemoteReviewTransport({ ...tls, endpoint: deviceEndpoint,
      beforeCompactionResponse: async () => {
        await waitForRemoteReview(provider.calls, calls => calls.some(call => call.compactedSession),
          'native compaction completion before acknowledgement loss')
      },
      beforeDiscovery: async () => {
        const paused = pausedDiscovery
        if (paused) { paused.entered(); return paused.waiting }
      },
      beforeAuthorization: async authorization => {
        if (!denyReservedResponse || authorization.action !== 'control') return
        const serialized = JSON.parse(await readFile(join(stateDirectory, 'workflow-operations.json'), 'utf8')) as {
          receipts: unknown[]; controlDeliveries: Array<{ operationId: string; commandId: string; phase: string }>
        }
        const receipt = serialized.receipts.map(value => RemoteOperationReceiptSchema.safeParse(value))
          .find(value => value.success && value.data.intent.operationId === authorization.intent.operationId)
        if (!receipt?.success) return
        const command = receipt.data.controls.find(command => command.action.kind === 'respond'
          && serialized.controlDeliveries.some(delivery => delivery.operationId === command.operationId
            && delivery.commandId === command.commandId && delivery.phase === 'reserved'))
        if (!command) return
        denyReservedResponse = false
        deniedResponse = RemoteOwnerControlSchema.parse(command)
        const changed = await db.pool.query(`update execution_dispatch_owner_grants set revoked=true
          where execution_id=$1 and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked`,
        [command.executionId, command.operationId, command.owner.grantId, command.owner.epoch])
        if (changed.rowCount !== 1) throw new Error('The original response grant was unavailable for the denial scenario.')
      } })
    closes.splice(closes.indexOf(stopMain), 0, transport.close)
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId,
      deviceId: paired.registration.deviceId, workerInstallationId: identity.workerInstallationId,
      keyRevision: paired.registration.keyRevision, authorizationRevision: paired.registration.authorizationRevision,
      endpoint: transport.endpoint, credential: paired.credential, mainPublicKeyFingerprint: publicMain.mainPublicKeyFingerprint,
      expiresAt: paired.expiresAt, tlsTrust: { certificatePem: certificate.toString('utf8'),
        sha256: createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex') },
    })
    await persistWorkerPairing(stateDirectory, pairing)
    const hostRef = { kind: 'device' as const, mainId, deviceId: pairing.deviceId }
    const roots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
      applicationInstallationId: identity.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: join(directory, 'worker-projects'),
        accessModes: [rootAccessMode] }],
      managedRuntimeRoot: workerRuntime })
    await writeFile(join(stateDirectory, 'approved-roots.json'), JSON.stringify(roots), { mode: 0o600 })
    // Harness replacement fixtures leave Node identity to the installed Worker's runtime validation.
    const payloadPaths = options.includeNodeRuntimePayload === false
      ? provider.payloadPaths.filter(path => path !== process.execPath) : provider.payloadPaths
    await writeFile(join(stateDirectory, 'workflow-runtime.json'), JSON.stringify({ schemaVersion: 1,
      codexBinary: provider.binary, expectedVersion: 'codex-cli 0.154.0',
      appMcpLauncher: launcher, payloadPaths }), { mode: 0o600 })
    const workerEntrypoint = fileURLToPath(new URL('../fixtures/remote-review-worker.mjs', import.meta.url))
    beginPhase('Worker release readiness')
    beginPhase('installed Worker initialization')
    const needsWorker = !options.installedMainService || options.executionHost !== 'main'
    if (needsWorker) {
      await execute(process.execPath, [workerEntrypoint, stateDirectory, workerRelease, 'initialize'], {
        env: workerEnvironment,
      })
    }
    let worker: ChildProcess | undefined
    let ready = false
    let workerStateRevision = 0
    let workerPhase = 'starting'
    let workerConnectionFailure = 'none'
    const startWorker = async () => {
      ready = false
      workerFailure = ''
      let phase: unknown
      const started = spawn(process.execPath, [workerEntrypoint, stateDirectory, workerRelease], {
        cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: workerEnvironment,
      })
      worker = started
      collectFailures(started, 'Worker')
      started.stderr!.on('data', chunk => { workerFailure = `${workerFailure}${String(chunk)}`.slice(-16384) })
      started.on('message', message => {
        if (message && typeof message === 'object' && 'view' in message) {
          const view = message.view
          if (view !== null && typeof view === 'object' && 'phase' in view && view.phase !== phase) {
            phase = view.phase
            console.info('[remote-review] Worker connection state', {
              phase, failure: 'failure' in view ? view.failure : null,
            })
          }
          if (view && typeof view === 'object' && 'phase' in view) workerPhase = String(view.phase)
          if (view && typeof view === 'object' && 'failure' in view) workerConnectionFailure = String(view.failure)
          ready = view !== null && typeof view === 'object' && 'phase' in view && view.phase === 'ready'
          if (!ready) workerStateRevision++
        }
      })
      await waitForChildReady(started, () => ready, 'authenticated installed Worker connection',
        () => `Installed Worker phase: ${workerPhase}; failure: ${workerConnectionFailure}; diagnostics: ${workerFailure}`)
    }
    const stopWorker = async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
      const stopped = worker
      await new Promise<void>((resolve, reject) => {
        stopped.once('error', reject)
        stopped.once('exit', code => {
          if (signal === 'SIGTERM' && code !== 0) reject(new Error(`Installed Worker cleanup failed: ${workerFailure}`))
          else resolve()
        })
        stopped.kill(signal)
      })
    }
    // Main closes its native sessions while the Worker transport is still available.
    closes.splice(closes.indexOf(stopMain), 0, () => stopWorker())
    beginPhase('Worker connection')
    if (needsWorker) await startWorker()
    beginPhase('Worker inventory')
    const executionHostRef = options.executionHost === 'main' ? mainHost : hostRef
    const inventory = await waitForRemoteReview(async () => HarnessRegistryReadbackSchema.parse(
      await value('harness_registry_get', executionHostRef)), value => value.installations.some(
      installation => installation.driverId === 'codex' && installation.installationFingerprint !== null), 'remote Codex inventory')
    const installation = inventory.installations.find(installation => installation.driverId === 'codex')!
    if (options.executionHost === 'main') {
      beginPhase('Main native qualification')
      await value('harness_qualification_run', { harness: 'codex' })
      await waitForRemoteReview(async () => (await db.pool.query<{ status: string }>(
        'select status from harness_qualifications order by started_at desc limit 1')).rows[0]?.status,
      status => status === 'passed', 'Main native qualification')
    }
    const target = { hostRef: executionHostRef,
      applicationInstallationId: options.executionHost === 'main' ? mainId : identity.workerInstallationId,
      harnessInstallationId: installation.harnessInstallationId, installationFingerprint: installation.installationFingerprint! }
    const qualifyProfile = async (configuration: typeof saved.configurations[number]) => {
      const profile = HostHarnessOverrideSaveResultSchema.parse(await value('harness_instance_save', {
        commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target,
        presetId: 'remote-review-fixture', enabled: true, configuration: configuration.harness,
      })).value
      const checked = HostHarnessInstanceCheckResultSchema.parse(await value('harness_instance_check', {
        commandId: randomUUID(), instanceId: profile.instanceId, expectedRevision: profile.revision, target,
      }))
      if (!checked.proof.qualified) throw new Error(`Remote profile qualification failed: ${JSON.stringify(checked.proof)}`)
      return checked.value
    }
    const matchingProfiles = new Map<string, ReturnType<typeof qualifyProfile>>()
    const prepareProfile = (configuration: typeof saved.configurations[number]) => {
      if (!options.reuseMatchingProfiles) return qualifyProfile(configuration)
      const key = JSON.stringify(configuration.harness)
      let profile = matchingProfiles.get(key)
      if (!profile) {
        profile = qualifyProfile(configuration)
        matchingProfiles.set(key, profile)
      }
      return profile
    }
    const profiles = []
    beginPhase('native profile qualification')
    if (options.parallelProfileChecks) {
      // Drain every native check before setup cleanup can stop Main or Worker.
      const results = await Promise.allSettled(saved.configurations.map(prepareProfile))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Remote profile qualification failed.')
      for (const result of results) {
        if (result.status === 'fulfilled') profiles.push(result.value)
      }
    } else {
      for (const configuration of saved.configurations) profiles.push(await prepareProfile(configuration))
    }
    let location = mainLocation
    beginPhase('root binding and workflow save')
    if (options.executionHost !== 'main') {
      const adopted = WorkspaceRootConfigurationAdoptResultSchema.parse(await value('workspace_root_configuration_adopt', {
        workspaceId: saved.scope.workspaceId, commandId: randomUUID(), hostRef,
      })).value
      location = WorkspaceBoundLocationSetResultSchema.parse(await value('workspace_root_location_set', {
        workspaceId: saved.scope.workspaceId, commandId: randomUUID(), hostRef, allowedBaseId: roots.bases[0]!.baseId,
        configurationRevision: adopted.configurationRevision, relativePath: 'project',
        accessMode: rootAccessMode,
        expectedLocationRevision: mainLocation.locationRevision, expectedRootPolicyRevision: 0,
      })).value
    }
    if (location.evidence !== 'bound') throw new Error('Remote source requires a bound workspace root.')
    const source = { approvedSourceId: approved.manifest.approvedSourceId,
      snapshotId: approved.manifest.snapshotId, manifestDigest: approved.manifest.manifestDigest }
    const bound = SourceRootBindResultSchema.parse(await value('source_root_bind', {
      workspaceId: saved.scope.workspaceId, commandId: randomUUID(), source,
      selection: { hostRef: executionHostRef, rootPolicyId: location.binding.rootPolicyId,
        rootPolicyRevision: location.binding.rootPolicyRevision, locationRevision: location.binding.locationRevision },
      expectedBindingRevision: 0, accessMode: options.sourceAccessMode ?? 'read-only',
    })).value
    const workflowScope = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId }
    const before = CurrentWorkflowReadResultSchema.parse(await value(CURRENT_WORKFLOW_TOOLS.saved, workflowScope))
    const graph = structuredClone(before.version.definition)
    for (let index = 0; index < graph.nodes.length; index++) {
      const node = graph.nodes[index]!
      if (node.kind === 'job') throw new Error('Expected an Agent fixture node.')
      const profile = profiles[index]!
      node.placement = { schemaVersion: 1, hostRef: executionHostRef, rootPolicyId: location.binding.rootPolicyId,
        rootPolicyRevision: location.binding.rootPolicyRevision, locationRevision: location.binding.locationRevision,
        projectRoot: location.binding.canonicalProjectRoot, cwdPolicy: 'project-root', relativeCwd: '',
        instanceId: profile.instanceId, instanceRevision: profile.instanceRevision,
        harnessInstallationId: installation.harnessInstallationId, source,
        rootBinding: { rootId: bound.binding.rootId, bindingRevision: bound.binding.bindingRevision } }
    }
    const version = CurrentWorkflowSaveResultSchema.parse(await value(CURRENT_WORKFLOW_TOOLS.save, {
      ...workflowScope, commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: before.revision,
      expectedWorkflowVersionId: before.version.id,
      expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph,
    })).value.version
    async function start() {
      const current = CurrentWorkflowReadResultSchema.parse(await value(CURRENT_WORKFLOW_TOOLS.saved, workflowScope))
      return ManualRunStartResultSchema.parse(await value('run_start', { ...workflowScope,
        workflowVersionId: version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedWorkflowRevision: current.revision, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
        expectedLocationRevision: location.locationRevision, input: {},
      }))
    }
    const requestReconciliation = (kind: 'reconcile' | 'reconcile-reviews') => new Promise<void>((resolve, reject) => {
      if (!main || !main.connected) {
        reject(new Error('Production Main reconciliation is disconnected.'))
        return
      }
      const child = main
      const requestId = randomUUID()
      const finish = (error?: Error) => {
        clearTimeout(timer)
        child.off('message', settled)
        child.off('exit', exited)
        if (error) reject(error)
        else resolve()
      }
      const exited = () => {
        const code = /\bcode: ['"]([A-Z][A-Z0-9_]{1,127})['"]/.exec(mainFailure)?.[1]
        const detail = code ? ` (${code})` : ''
        finish(new Error(`Production Main exited during reconciliation${detail}.`))
      }
      const settled = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('requestId' in message)
          || message.requestId !== requestId || !('kind' in message)) return
        if (message.kind === 'reconciled') finish()
        else {
          const code = 'code' in message && typeof message.code === 'string'
            && /^[A-Z][A-Z0-9_]{1,127}$/.test(message.code) ? message.code : undefined
          const detail = 'message' in message ? String(message.message) : 'Main reconciliation failed.'
          const reason = 'details' in message ? JSON.stringify(message.details) : ''
          const nativeFailures = JSON.stringify(failures.slice(-8))
          const error = new Error(`${code ? `${code}: ` : ''}${detail}${reason ? ` (${reason})` : ''}\nNative failure codes: ${nativeFailures}`)
          if ('stack' in message && typeof message.stack === 'string') error.stack = message.stack
          if (reason) error.stack = `${error.stack}\nDetails: ${reason}`
          error.stack = `${error.stack}\nNative failure codes: ${nativeFailures}`
          finish(error)
        }
      }
      const timer = setTimeout(() => finish(new Error('Production Main reconciliation timed out.')), 30_000)
      child.on('message', settled)
      child.once('exit', exited)
      child.send({ kind, requestId }, error => { if (error) finish(error) })
    })
    const serviceReconciliation = async (kind: string) => {
      const response = await fetch(`${origin}/__fixture-reconcile`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${writer.token}` },
        body: JSON.stringify({ kind }) })
      if (!response.ok) throw new Error(`Installed API reconciliation failed: ${await response.text()}`)
    }
    const reconcile = () => mainService ? serviceReconciliation('reconcile') : requestReconciliation('reconcile')
    const reconcileReviews = remoteReviewReconciliation(() => mainService
      ? serviceReconciliation('reconcile-reviews') : requestReconciliation('reconcile-reviews'))
    async function details(runId: string) {
      const response = await fetch(`${origin}/api/management/workspaces/${saved.scope.workspaceId}/runs/${runId}`, {
        headers: { authorization: `Bearer ${writer.token}` } })
      if (!response.ok) throw new Error(`Run read failed: ${await response.text()}`)
      return SavedRunDetailsSchema.parse(await response.json())
    }
    const registry = new NativeProcessRegistry(join(stateDirectory, 'workflow-native-processes'))
    reportPhase(phase, performance.now() - phaseStarted)
    return { db, directory, stateDirectory, provider, claudeInventory, access, writer, repositoryName,
      sourceManifest: approved.manifest,
      hostRef: executionHostRef, profiles, version, startupCatalog,
      start, call, value, details, reconcile, reconcileReviews, registry, close, origin: () => origin,
      subscribeNativeChanges: changes.subscribe,
      failures: () => structuredClone(failures),
      databaseProfile: () => databaseProfile,
      async workerWorkflowStartup() {
        const journal = JSON.parse(await readFile(join(stateDirectory, 'workflow-operations.json'), 'utf8')) as {
          receipts: unknown[]
        }
        return journal.receipts.flatMap(raw => {
          const parsed = RemoteOperationReceiptSchema.safeParse(raw)
          if (!parsed.success) return []
          const receipt = parsed.data
          return [{ executionId: receipt.intent.executionId, operationId: receipt.intent.operationId,
            phase: receipt.phase, sequence: receipt.sequence, entryAttempted: receipt.entryAttempted,
            turnEntryAttempted: receipt.turnEntryAttempted, stopFence: receipt.stopFence,
            sessionId: receipt.native?.sessionId, turnId: receipt.native?.turnId,
            terminal: receipt.terminal?.kind }]
        })
      },
      entryCapture: (operationId: string) => new InstalledWorkflowRecovery(
        join(stateDirectory, 'workflow-recovery'), registry).readEntry(operationId),
      workerPid: () => worker?.pid,
      mainService,
      inventory: () => value('harness_registry_get', executionHostRef).then(HarnessRegistryReadbackSchema.parse),
      blockWorkerDiscovery() {
        let entered!: () => void
        const discovering = new Promise<void>(resolve => { entered = resolve })
        let release!: (outcome?: 'cancel') => void
        const waiting = new Promise<void | 'cancel'>(resolve => { release = resolve })
        pausedDiscovery = { entered, release, waiting }
        return discovering
      },
      cancelWorkerDiscovery() {
        if (!pausedDiscovery) throw new Error('Worker discovery is not blocked.')
        pausedDiscovery.release('cancel')
        pausedDiscovery.waiting = Promise.resolve('cancel')
      },
      releaseWorkerDiscovery,
      denyNextReservedResponse: () => { denyReservedResponse = true },
      deniedResponse: () => deniedResponse,
      deliveryReads: transport.deliveryReads,
      pauseWorkerConnection: transport.pauseConnections,
      resumeWorkerConnection: transport.resumeConnections,
      dropNextPhysicalReadout: transport.dropNextPhysicalReadout,
      dropNextSettlement: transport.dropNextSettlement,
      holdNextRetirementReply: transport.holdNextRetirementReply,
      loseNextCompactionResponse: transport.loseNextCompactionResponse,
      conversationRequests: transport.conversationRequests,
      async restoreOriginalResponseGrant() {
        const command = deniedResponse
        if (!command) throw new Error('No original reserved response was denied.')
        const changed = await db.pool.query(`update execution_dispatch_owner_grants set revoked=false
          where execution_id=$1 and operation_id=$2 and grant_id=$3 and epoch=$4 and revoked`,
        [command.executionId, command.operationId, command.owner.grantId, command.owner.epoch])
        if (changed.rowCount !== 1) throw new Error('The original response grant changed before retry.')
      },
      async restartMain(options: { mode?: 'crash' | 'graceful'; workingDirectory?: string;
        afterShutdown?: () => Promise<void> } = {}) {
        const previousWorkerState = workerStateRevision
        ready = false
        await stopMain(options.mode === 'graceful' ? 'SIGTERM' : 'SIGKILL')
        if (!transport.paused()) await waitForRemoteReview(async () => workerStateRevision,
          value => value > previousWorkerState, 'Worker observing the stopped Main connection')
        await options.afterShutdown?.()
        await startMain(options.workingDirectory)
        await waitForRemoteReview(async () => ready, value => value, 'Worker reconnect after Main restart')
      },
      async restartWorker(afterCrash?: () => void) {
        const previous = HarnessRegistryReadbackSchema.parse(await value('harness_registry_get', hostRef))
          .hostMetadata!.connection!.binding.connectionEpoch
        await stopWorker('SIGKILL')
        afterCrash?.()
        await waitForRemoteReview(async () => HarnessRegistryReadbackSchema.parse(
          await value('harness_registry_get', hostRef)),
        inventory => inventory.hostMetadata?.connection?.phase === 'offline'
          || inventory.hostMetadata?.connection === null, 'Main observing the stopped Worker connection')
        await startWorker()
        await waitForRemoteReview(async () => HarnessRegistryReadbackSchema.parse(
          await value('harness_registry_get', hostRef)), inventory => {
          const connection = inventory.hostMetadata?.connection
          return connection?.phase === 'ready' && connection.binding.connectionEpoch !== previous
        }, 'Main observing the replacement Worker connection')
      },
      async pending(runId: string) {
        changes.assertHealthy()
        const rows = await db.pool.query<{ record: unknown }>(
          "select record from durable_interactions where run_id=$1 and status='pending' order by id", [runId])
        return rows.rows.map(row => DurableInteractionSchema.parse(row.record))
      },
      async executions(runId: string) {
        const rows = await db.pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1', [runId])
        return rows.rows.map(row => HarnessExecutionSchema.parse(row.record))
      },
    }
  } catch (error) {
    reportPhase(phase, performance.now() - phaseStarted)
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Remote review setup and cleanup failed.', { cause: cleanupError })
    }
    throw error
  }
}
