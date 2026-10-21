import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import { DeviceSetupApproveResultSchema } from '@foreman-code/contracts/device-setup'
import { loadWorkerPairing } from '@foreman-code/contracts/device-identity-node'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { AgentHarnessSchema, ApiErrorResponseSchema, RuntimeIdentitySchema, type AgentHarness } from '@foreman-code/contracts'
import { logger } from '../../src/infrastructure/logger.js'
import { loadConfig } from '../../src/config.js'
import { createDatabase } from '../../src/infrastructure/database.js'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.js'
import { buildProductionApp } from '../../src/production.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { InstalledWorkflowConfigurationSchema } from '../../src/modules/runs/remote/installedWorkflowConfiguration.js'
import { codexQualificationSuite } from '../../src/modules/harnesses/qualification/suites/codex.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { installFixtureMcp } from './installFixtureMcp.js'
import { z } from 'zod'

const execute = promisify(execFile)
const fixtureLogger = logger.child({ component: 'http', fixture: 'native-controls' }, {
  serializers: {
    err: (error: unknown) => {
      const diagnostic = error as { code?: unknown; stack?: unknown } | null
      return { errorType: error instanceof Error ? error.constructor.name : typeof error,
        ...(typeof diagnostic?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(diagnostic.code)
          ? { errorCode: diagnostic.code } : {}),
        ...(typeof diagnostic?.stack === 'string'
          ? { stackFrames: diagnostic.stack.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 8) } : {}) }
    },
  },
})

function observeWorkerErrors(stream: Readable) {
  const lines = createInterface({ input: stream })
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 65536) return
    let value: unknown
    try { value = JSON.parse(line) } catch { return }
    const parsed = z.object({ level: z.union([z.number(), z.enum(['error', 'fatal'])]), err: z.object({
      type: z.string().optional(), code: z.string().optional(), stack: z.string().optional(),
      result: z.object({ error: z.object({ code: z.string().optional() }).optional() }).optional(),
    }).optional() }).safeParse(value)
    if (!parsed.success || typeof parsed.data.level === 'number' && parsed.data.level < 50 || !parsed.data.err) return
    const error = parsed.data.err
    const code = error.code ?? error.result?.error?.code
    fixtureLogger.error({
      errorType: error.type && /^[A-Za-z0-9_]{1,64}$/.test(error.type) ? error.type : 'WorkerError',
      ...(code && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? { errorCode: code } : {}),
      stackFrames: error.stack?.split('\n').filter(frame => /^\s+at\s/.test(frame)).slice(0, 8) ?? [],
    }, 'Installed Worker operation failed')
  })
  return lines
}
const SourceSnapshot = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.object({ path: z.string().min(1), gitBlobSha1: z.string().regex(/^[a-f0-9]{40}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(10000) }).strict()

async function verifyWorkerSource(manifest: Record<string, unknown>, commit: string) {
  const snapshot = SourceSnapshot.parse(manifest.sourceSnapshot)
  assert.equal(snapshot.commit, manifest.commit)
  const paths = snapshot.files.map(file => file.path)
  assert.equal(new Set(paths).size, paths.length)
  for (const path of paths) {
    assert.ok(!path.startsWith('/') && [...path].every(character => character.charCodeAt(0) >= 32)
      && path.split('/').every(part => part && part !== '.' && part !== '..'))
  }
  const required = ['scripts/build-worker-artifact.mjs', 'pnpm-lock.yaml',
    'apps/worker/src/workerFactory.mjs', 'apps/worker/src/cli.mjs']
  assert.ok(required.every(path => paths.includes(path)))
  const hashes = (await execute('git', ['rev-parse', ...paths.map(path => `${commit}:${path}`)],
    { maxBuffer: 2 * 1024 * 1024 })).stdout.trim().split('\n')
  assert.deepEqual(hashes, snapshot.files.map(file => file.gitBlobSha1),
    'The Worker build inputs differ from this committed checkout.')
}
const actions: ManagementAction[] = ['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update',
  'devices:read', 'capabilities:read', 'operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write',
  'workspaces:read', 'workspaces:create', 'workspace_locations:read', 'workspace_locations:provision',
  'workspace_locations:update', 'workspace_locations:validate', 'source_roots:read', 'source_roots:bind',
  'workflows:read', 'workflows:create', 'workflows:update', 'agents:read', 'agents:create', 'agents:update',
  'graph:read', 'graph:edit', 'graph:save', 'runs:read']

async function copyProfileFile(source: string, destination: string) {
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 })
  try {
    await copyFile(source, destination)
    await chmod(destination, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function workerEnvironment(home: string) {
  const original = process.env.HOME ?? homedir()
  const codexProfile = join(home, '.codex')
  const claudeProfile = join(home, '.claude')
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexProfile,
    CLAUDE_CONFIG_DIR: claudeProfile, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'),
    FOREMAN_CODE_APP_MCP_DIRECTORY: join(home, '.local/share/graphql/mcp') }
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ENG03_A_TEST_DATABASE_URL', ...APP_MCP_TOKEN_NAMES]) {
    delete environment[name]
  }
  const codex = process.env.CODEX_HOME ?? join(original, '.codex')
  for (const name of ['auth.json', 'models_cache.json']) {
    await copyProfileFile(join(codex, name), join(codexProfile, name))
  }
  await copyProfileFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(original, '.claude'), '.credentials.json'),
    join(claudeProfile, '.credentials.json'))
  return { environment, claudeProfile }
}

async function waitForWorkerExit(closed: Promise<void>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([closed, new Promise<never>((_done, fail) => {
      timer = setTimeout(() => fail(new Error('The owned Worker shutdown timed out.')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  return address.port
}

async function certificates(root: string) {
  const ca = join(root, 'ca.pem')
  const key = join(root, 'listener.key')
  const certificate = join(root, 'listener.pem')
  const request = join(root, 'listener.csr')
  const extensions = join(root, 'listener.extensions')
  await writeFile(extensions, 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\n', { mode: 0o600 })
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Native controls fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', join(root, 'ca.key'), '-out', ca])
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
    '-keyout', key, '-out', request])
  await execute('openssl', ['x509', '-req', '-in', request, '-CA', ca, '-CAkey', join(root, 'ca.key'),
    '-set_serial', '1', '-days', '1', '-extfile', extensions, '-out', certificate])
  await chmod(certificate, 0o600)
  await chmod(key, 0o600)
  return { certificateFile: certificate, privateKeyFile: key, trustCertificateFile: ca }
}

async function installerCommand(file: string, args: string[], environment: NodeJS.ProcessEnv,
  options: { input?: string; nodeArgs?: string[] } = {}) {
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), file, ...args],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let bytes = 0
  let deadlineExpired = false
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 1024 * 1024) child.kill('SIGTERM')
    else output += chunk.toString('utf8')
  })
  child.stderr.resume()
  child.stdin.end(options.input)
  const timer = setTimeout(() => {
    deadlineExpired = true
    child.kill('SIGTERM')
  }, 90_000)
  try {
    await new Promise<void>((done, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => {
        if (code === 0) return done()
        const operation = /^[a-z][a-z-]*$/.test(args[0] ?? '') ? args[0] : 'fixture setup'
        fail(new Error(`Worker fixture command ${basename(file)} (${operation}) failed: exit=${code ?? 'none'}, `
          + `signal=${signal ?? 'none'}, deadlineExpired=${deadlineExpired}, outputLimitExceeded=${bytes > 1024 * 1024}.`))
      })
    })
    assert.ok(bytes <= 1024 * 1024)
    return output.trim()
  } finally { clearTimeout(timer) }
}

/** Real production composition and an installed Worker; no execution domains or SDK outputs are substituted. */
export async function pairedWorkerApplication(options: { harnesses?: readonly AgentHarness[] } = {}) {
  const harnesses = AgentHarnessSchema.array().min(1).max(2)
    .parse(options.harnesses ?? ['codex', 'claude'])
  assert.equal(new Set(harnesses).size, harnesses.length)
  const databaseUrl = process.env.ENG03_A_TEST_DATABASE_URL
  assert.ok(databaseUrl, 'Run through the disposable native acceptance database driver.')
  const url = new URL(databaseUrl)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_test'))
  const artifact = process.env.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY
  assert.ok(artifact, 'Build the committed Worker artifact before this acceptance case.')
  const root = await privateFixtureDirectory('paired-native-controls-')
  let database: ReturnType<typeof createDatabase> | undefined
  let checkpoints: ReturnType<typeof createCheckpointStore> | undefined
  let production: ReturnType<typeof buildProductionApp> | undefined
  let worker: ChildProcess | undefined
  let workerClosed: Promise<void> | undefined
  let workerExit: number | null | undefined
  let client: Client | undefined
  let deniedClient: Client | undefined
  const previousClaudeProfile = process.env.CLAUDE_CONFIG_DIR
  const previousCodexProfile = process.env.CODEX_HOME
  const previousMcpDirectory = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  const mainClaudeProfile = join(root, 'main-claude-profile')
  const mainCodexProfile = join(root, 'main-codex-profile')
  let removed = false
  const close = async () => {
    const failures: unknown[] = []
    const release = async (operation: () => Promise<unknown>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (worker && workerExit === undefined) worker.kill('SIGTERM')
    if (workerClosed) await release(async () => {
      try { await waitForWorkerExit(workerClosed!, 60000) }
      catch (error) {
        worker?.kill('SIGKILL')
        await waitForWorkerExit(workerClosed!, 10000)
        const processes = new NativeProcessRegistry(join(root, 'worker-home/.local/state/graphql-worker/workflow-native-processes'))
        for (const owner of new Set(processes.snapshot().launches.map(launch => launch.owner))) {
          if (!await processes.closeOwner(owner)) throw new Error(
            'The original Worker native processes remain unconfirmed.', { cause: error })
        }
        throw error
      }
    })
    if (worker && workerExit !== 0) failures.push(new Error('The owned Worker did not close successfully.'))
    if (client) await release(() => client!.close())
    if (deniedClient) await release(() => deniedClient!.close())
    if (production) await release(() => production!.app.close())
    if (checkpoints) await release(() => checkpoints!.close())
    if (database) await release(() => database!.close())
    if (!failures.length && !removed) {
      if (previousClaudeProfile === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeProfile
      if (previousCodexProfile === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexProfile
      if (previousMcpDirectory === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
      else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previousMcpDirectory
      await rm(root, { recursive: true, force: true })
      removed = true
    }
    if (failures.length) throw new AggregateError(failures, `Paired native fixture cleanup remains incomplete: ${root}`)
  }
  try {
    const port = await availablePort()
    const devicePort = await availablePort()
    const browserPort = await availablePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const browserOrigin = `http://127.0.0.1:${browserPort}`
    const endpoint = `wss://127.0.0.1:${devicePort}/device/connect`
    const applicationEnvironment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port),
      DATABASE_QUERY_TIMEOUT_MS: '10000', FOREMAN_CODE_BROWSER_ORIGIN: browserOrigin,
      FOREMAN_CODE_WEB_PORT: String(browserPort),
      FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1', WORKSPACE_STORAGE_ROOT: join(root, 'main-projects'),
      FILE_STORAGE_ROOT: join(root, 'main-files'), HARNESS_WORKSPACE_ROOT: join(root, 'main-runtime') }
    delete applicationEnvironment.FOREMAN_CODE_DEV_BROWSER_ORIGIN
    delete applicationEnvironment.GRAPHQL_DEV_BROWSER_ORIGIN
    const config = loadConfig(applicationEnvironment)
    database = createDatabase(config.database)
    checkpoints = createCheckpointStore(databaseUrl, config.checkpoints.schema, config.database)
    await copyProfileFile(join(previousClaudeProfile ?? join(homedir(), '.claude'), '.credentials.json'),
      join(mainClaudeProfile, '.credentials.json'))
    for (const name of ['auth.json', 'models_cache.json']) {
      await copyProfileFile(join(previousCodexProfile ?? join(homedir(), '.codex'), name), join(mainCodexProfile, name))
    }
    process.env.CLAUDE_CONFIG_DIR = mainClaudeProfile
    process.env.CODEX_HOME = mainCodexProfile
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = join(root, 'main-app-mcp')
    for (const path of [config.workspaceStorageRoot!, config.fileStorageRoot!, config.harnesses.workspaceRoot]) {
      await mkdir(path, { mode: 0o700 })
    }
    await database.migrate()
    await checkpoints.setup()
    const tls = await certificates(root)
    const startMain = async () => {
      const main = buildProductionApp(config, database!, checkpoints!, fixtureLogger, undefined, undefined,
        { codex: codexQualificationSuite },
        { mode: 'native', deviceListener: { host: '127.0.0.1', port: devicePort, advertisedEndpoint: endpoint, ...tls } })
      production = main
      main.registerFileStorage()
      await main.initialize()
      await main.app.listen({ host: '127.0.0.1', port })
      await main.startDeviceListener()
      return main
    }
    await startMain()
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Native controls fixture', audience: 'operator',
      grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 6 * 60 * 60_000) })
    const denied = await access.issue({ name: 'Native controls reader', audience: 'operator',
      grants: [{ actions: ['capabilities:read'], scope: {} }], expiresAt: new Date(Date.now() + 6 * 60 * 60_000) })
    const connectClients = async () => {
      client = new Client({ name: 'Paired native controls fixture', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
        authProvider: { token: async () => writer.token },
      }))
      deniedClient = new Client({ name: 'Native controls denied caller', version: '1' })
      await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
        authProvider: { token: async () => denied.token },
      }))
    }
    await connectClients()
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args }, { timeout: 180000 })
      if (result.isError) {
        const content = result.content.find(value => value.type === 'text')
        const failure = content?.type === 'text'
          ? JSON.parse(content.text) as { error?: { code?: string; message?: string; details?: { issues?: unknown[] } } } : {}
        const issues = failure.error?.code === 'GRAPH_INVALID' ? failure.error.details?.issues : undefined
        throw new Error(`Product tool ${name} failed: ${failure.error?.code ?? 'UNKNOWN'}: ${failure.error?.message ?? 'No public error message.'}`
          + (issues ? ` ${JSON.stringify(issues)}` : ''))
      }
      return decodeMcpToolResult(result)
    }
    const deniedTool = (name: string, args: Record<string, unknown>) =>
      deniedClient!.callTool({ name, arguments: args }, { timeout: 180000 })
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(new URL(path, baseUrl), {
        headers: { origin: browserOrigin, 'content-type': 'application/json' },
        credentials: 'omit', signal: AbortSignal.timeout(180000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
      if (!response.ok) {
        const failure = ApiErrorResponseSchema.parse(await response.json())
        throw new Error(`Fixture product request failed: ${response.status}: ${failure.error.code}: ${failure.error.message}`)
      }
      return response.json() as Promise<unknown>
    }
    const identity = RuntimeIdentitySchema.parse(await fetch(new URL('/health/identity', baseUrl))
      .then(response => response.json()))
    const main = HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', {
      kind: 'main', mainId: identity.installationId,
    }))
    const home = join(root, 'worker-home')
    await mkdir(home, { mode: 0o700 })
    const { environment, claudeProfile } = await workerEnvironment(home)
    const manifestBytes = await readFile(join(artifact, 'manifest.json'))
    const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'))
    assert.ok(manifest && typeof manifest === 'object' && 'commit' in manifest)
    const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim()
    await verifyWorkerSource(manifest as Record<string, unknown>, sourceCommit)
    await installerCommand(join(artifact, 'src/install-cli.mjs'), ['setup', '--artifact', resolve(artifact),
      '--manifest-sha256', createHash('sha256').update(manifestBytes).digest('hex')], environment)
    const state = join(home, '.local/state/graphql-worker')
    const installed = join(home, '.local/lib/graphql-worker/current')
    const cli = join(installed, 'src/cli.mjs')
    const code = await installerCommand(cli, ['identity-request', '--state', state], environment)
    const approval = DeviceSetupApproveResultSchema.parse(await tool('device_setup_code_create', {
      commandId: randomUUID(), identityRequestCode: code, endpoint, scopes: ['connect', 'heartbeat', 'metrics:report'],
    }))
    await installerCommand(cli, ['pair', '--state', state, '--enrollment-stdin'], environment,
      { input: approval.enrollmentCode })
    const pairing = await loadWorkerPairing(state)
    assert.equal(pairing.mainId, identity.installationId)
    assert.equal(pairing.deviceId, approval.registration.deviceId)
    const project = join(root, 'worker-projects')
    const runtime = join(root, 'worker-runtime')
    await mkdir(project, { mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const hostRef = { kind: 'device' as const, mainId: pairing.mainId, deviceId: pairing.deviceId }
    const roots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1', managedRuntimeRoot: runtime,
      bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only', 'read-write'] }] })
    await writeFile(join(state, 'approved-roots.json'), JSON.stringify(roots), { mode: 0o600, flag: 'wx' })
    const installedHarness = (driver: string) => {
      const value = main.installations.find(entry => entry.driverId === driver && entry.installed)
      assert.ok(value?.launcher.resolvedLauncher, `The selected ${driver} installation is unavailable.`)
      return value.launcher.resolvedLauncher
    }
    const mcpHarnesses = harnesses.filter(harness => harness === 'codex')
    if (mcpHarnesses.length) {
      const mcpInput = { databaseUrl, endpoint: `${baseUrl}/mcp`, directory: project, harnesses: mcpHarnesses,
        codexBinary: harnesses.includes('codex') ? installedHarness('codex') : config.harnesses.codexBinary }
      const mainMcpInput = join(root, 'main-mcp-install.json')
      await writeFile(mainMcpInput, JSON.stringify({ ...mcpInput, directory: config.harnesses.workspaceRoot,
        recoveryRoot: join(root, 'main-mcp-processes') }), { mode: 0o600, flag: 'wx' })
      await installFixtureMcp(mainMcpInput)
      const workerMcpInput = join(root, 'worker-mcp-install.json')
      await writeFile(workerMcpInput, JSON.stringify({ ...mcpInput,
        recoveryRoot: join(root, 'worker-mcp-processes') }), { mode: 0o600, flag: 'wx' })
      await installerCommand(fileURLToPath(new URL('./installFixtureMcp.ts', import.meta.url)), [workerMcpInput],
        environment, { nodeArgs: ['--import', 'tsx'] })
    }
    const selection = InstalledWorkflowConfigurationSchema.parse({ schemaVersion: 1,
      codexBinary: installedHarness('codex'), expectedVersion: '0.154.0', payloadPaths: [],
      appMcpLauncher: join(home, '.local/share/graphql/mcp/launcher.mjs'),
      ...(harnesses.includes('claude') ? { claude: { binary: installedHarness('claude'),
        sdkEntrypoint: createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
        installedLockPath: fileURLToPath(new URL('../../../../pnpm-lock.yaml', import.meta.url)) } } : {}) })
    await writeFile(join(state, 'workflow-runtime.json'), JSON.stringify(selection), { mode: 0o600, flag: 'wx' })
    await installerCommand(cli, ['initialize-native-runtime', '--state', state], environment)
    worker = spawn(process.execPath, [cli, 'run', '--state', state], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const workerOutput = [observeWorkerErrors(worker.stdout!), observeWorkerErrors(worker.stderr!)]
    workerClosed = new Promise<void>((done, fail) => {
      worker!.once('error', fail)
      worker!.once('close', code => {
        workerOutput.forEach(output => output.close())
        workerExit = code
        done()
      })
    })
    const deadline = Date.now() + 60000
    let inventory: ReturnType<typeof HarnessRegistryReadbackSchema.parse> | undefined
    while (Date.now() < deadline && workerExit === undefined) {
      inventory = HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', hostRef))
      if (inventory.hostMetadata?.connection?.phase === 'ready') break
      await delay(50)
    }
    assert.equal(inventory?.hostMetadata?.connection?.phase, 'ready', 'The installed Worker did not connect.')
    assert.equal(inventory.hostMetadata.applicationInstallationId, pairing.workerInstallationId)
    const restartMain = async () => {
      await client!.close()
      await deniedClient!.close()
      await production!.app.close()
      production = undefined
      const restarted = await startMain()
      await connectClients()
      const recoveryFailures: unknown[] = []
      await restarted.reconcile(error => { recoveryFailures.push(error) })
      if (recoveryFailures.length) throw new AggregateError(recoveryFailures, 'Main recovery failed after restart.')
      assert.deepEqual(RuntimeIdentitySchema.parse(await fetch(new URL('/health/identity', baseUrl))
        .then(response => response.json())), identity)
      const deadline = Date.now() + 60000
      while (Date.now() < deadline && workerExit === undefined) {
        const connected = HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', hostRef))
        if (connected.hostMetadata?.connection?.phase === 'ready') {
          assert.equal(connected.hostMetadata.connection.binding.workerInstallationId, pairing.workerInstallationId)
          return
        }
        await delay(50)
      }
      throw new Error('The installed Worker did not reconnect after Main restarted.')
    }
    return { root, baseUrl, browserOrigin, identity, hostRef, roots, inventory, tool, deniedTool, request, close, restartMain,
      sourceCommit, mainProfile: mainClaudeProfile, workerProfile: claudeProfile,
      mainProjects: config.workspaceStorageRoot! }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Paired native fixture setup and cleanup failed.', { cause: cleanupError })
    }
    throw error
  }
}
