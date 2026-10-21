import { decodeMcpToolResult } from '../packages/contracts/dist/operatorMcp.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { hasNativeTurnStarted, preserveOperatorConfiguration, publish, readEnvironment, readProductionIdentity,
  renderEnvironment, waitForProductionReady,
  withInstallationLock } from './local-production-runtime.mjs'

if (readProductEnvironment(process.env, 'TEST_ROOT') || readProductEnvironment(process.env, 'TEST_OWNER')) {
  throw new Error('Installed production verification cannot run inside disposable test resources')
}

const execute = promisify(execFile)
const home = homedir()
const app = join(home, '.local/lib/graphql-production')
const config = join(home, '.config/graphql-production')
const unit = 'graphql-operator-api.service'
const databaseUnit = 'graphql-production-db.service'
const origin = 'http://127.0.0.1:3041'

async function systemctl(...args) {
  const { stdout } = await execute('/usr/bin/systemctl', ['--user', ...args], { timeout: 120_000 })
  return stdout.trim()
}

async function localRequest(path, { token, method = 'GET', body }) {
  assert.ok(token, 'Automated agent HTTP requests require an application credential')
  const response = await fetch(new URL(path, origin), {
    method, credentials: 'omit', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

async function waitUntil(read, accept, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function observeOperatorErrors(conversationId, token, events) {
  const cancellation = new AbortController()
  const response = await fetch(new URL(`/api/operator/conversations/${conversationId}/events`, origin), {
    headers: { authorization: `Bearer ${token}` }, signal: cancellation.signal,
  })
  if (response.status !== 200) await response.body?.cancel()
  assert.equal(response.status, 200, 'Operator diagnostics must use the authenticated event stream')
  assert.ok(response.body)
  const observing = (async () => {
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n')
      assert.ok(pending.length < 512 * 1024, 'Operator diagnostic frame exceeded its bound')
      let boundary
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (frame.startsWith('event: error\n') && events.length < 32) {
          const payload = frame.split('\n').filter(line => line.startsWith('data: '))
            .map(line => line.slice(6)).join('\n')
          events.push({ receivedAt: new Date().toISOString(), event: JSON.parse(payload) })
        }
      }
    }
  })().catch(error => {
    if (!cancellation.signal.aborted) events.push({ observerError: error.message })
  })
  return async () => { cancellation.abort(); await observing }
}

async function observeDatabaseWaits(pool, samples) {
  const cancellation = new AbortController()
  const observing = (async () => {
    while (!cancellation.signal.aborted) {
      const started = Date.now()
      try {
        const { rows } = await pool.query(`select pid,application_name,state,wait_event_type,wait_event,
          floor(extract(epoch from(clock_timestamp()-xact_start))*1000)::text as transaction_ms,
          floor(extract(epoch from(clock_timestamp()-query_start))*1000)::text as query_ms,
          pg_blocking_pids(pid) as blockers,md5(query) as statement_id
          from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
          and state<>'idle' and (wait_event_type='Lock' or query_start<clock_timestamp()-interval '250 milliseconds')
          order by query_start limit 16`)
        if (rows.length) samples.push({ observedAt: new Date().toISOString(), probeMs: Date.now() - started, rows })
      } catch (error) {
        // Database restart is part of this test. Record the failed diagnostic
        // probe without substituting for or weakening any product assertion.
        samples.push({ observedAt: new Date().toISOString(), probeMs: Date.now() - started,
          probeError: typeof error.code === 'string' ? error.code : 'query_failed' })
      }
      if (samples.length > 128) samples.splice(0, samples.length - 128)
      await delay(250, undefined, { signal: cancellation.signal }).catch(error => {
        if (!cancellation.signal.aborted) throw error
      })
    }
  })()
  return async () => { cancellation.abort(); await observing }
}

async function recoverFailedDatabaseStartup(environment, ready) {
  const directory = await mkdtemp(join(config, 'database-startup-regression-'))
  const faultEnvironment = join(directory, 'database.env')
  const dropIn = join(home, '.config/systemd/user', `${databaseUnit}.d`, `regression-${randomUUID()}.conf`)
  let recovered = false
  try {
    await systemctl('stop', unit, databaseUnit)
    // Compose's required password check fails the real database activation before touching its volume.
    await publish(faultEnvironment, renderEnvironment({ GRAPHQL_PRODUCTION_DB_PASSWORD: '' }))
    await publish(dropIn, `[Service]\nEnvironmentFile=${faultEnvironment}\n`)
    await systemctl('daemon-reload')
    await systemctl('start', '--no-block', unit)
    await waitUntil(() => systemctl('show', '--property=Result', '--value', databaseUnit),
      value => value === 'exit-code', 'failed first database activation', 30_000)
    await publish(faultEnvironment, renderEnvironment({
      GRAPHQL_PRODUCTION_DB_PASSWORD: readProductEnvironment(environment, 'PRODUCTION_DB_PASSWORD'),
    }))
    await ready()
    assert.ok(Number(await systemctl('show', '--property=NRestarts', '--value', databaseUnit)) >= 1,
      'The database must recover by automatic retry')
    assert.equal(await systemctl('is-active', databaseUnit), 'active')
    recovered = true
  } finally {
    await rm(dropIn, { force: true })
    await rm(directory, { recursive: true, force: true })
    await systemctl('daemon-reload')
    if (!recovered) await systemctl('start', databaseUnit, unit)
  }
}

async function qualifyEnvironmentMigration(release) {
  const directory = await mkdtemp(join(config, 'environment-regression-'))
  const envFile = join(directory, 'production.env')
  const operatorFile = join(directory, 'operator.json')
  const settings = {
    CODEX_BINARY: '/opt/native "qualified"/codex',
    OPENAI_API_KEY: "test-only\\secret\"quote'single$literal`tick\nsecond line\\",
    ANTHROPIC_API_KEY: 'test-only-provider-credential',
    HARNESS_TIMEOUT_MS: '600000',
  }
  const owned = { NODE_ENV: 'production', FOREMAN_CODE_LOCAL_PRODUCTION: '1', HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://owner:password@127.0.0.1:55440/graphql_production',
    GRAPHQL_PRODUCTION_DB_PASSWORD: 'test-only-database-credential' }
  const { loadConfig } = await import(pathToFileURL(join(release, 'apps/api/dist/config.js')))
  const readEffective = async () => {
    const code = 'const keys = JSON.parse(process.argv[1]); '
      + 'console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));'
    const { stdout } = await execute('/usr/bin/systemd-run', ['--user', '--wait', '--pipe', '--collect', '--quiet',
      `--unit=graphql-environment-regression-${randomUUID()}`, `--property=EnvironmentFile=${envFile}`,
      join(release, 'node'), '-e', code, JSON.stringify(Object.keys(settings))], { timeout: 30_000 })
    return JSON.parse(stdout)
  }
  try {
    await publish(envFile, renderEnvironment({ ...settings, ...owned }))
    assert.deepEqual(await readEffective(), settings, 'Initial settings must match the actual systemd environment')
    const migrated = await preserveOperatorConfiguration(operatorFile, await readEnvironment(envFile), owned, loadConfig)
    assert.equal(loadConfig(migrated).harnesses.codexBinary, settings.CODEX_BINARY)
    assert.deepEqual(JSON.parse(await readFile(operatorFile, 'utf8')), settings)
    await publish(envFile, renderEnvironment(migrated))
    assert.deepEqual(await readEffective(), settings, 'Migration must preserve effective settings')
    const updated = await preserveOperatorConfiguration(operatorFile, await readEnvironment(envFile), owned, loadConfig)
    await publish(envFile, renderEnvironment(updated))
    assert.deepEqual(await readEffective(), settings, 'Update must preserve effective settings')
    const module = pathToFileURL(join(release, 'apps/api/dist/modules/harnesses/secrets.js')).href
    const code = `const { inheritedAgentEnvironment } = await import(${JSON.stringify(module)});\n`
      + 'const native = inheritedAgentEnvironment();\n'
      + 'console.log(JSON.stringify({ providerCredentialDelivered: !!process.env.ANTHROPIC_API_KEY\n'
      + '&& native.ANTHROPIC_API_KEY === process.env.ANTHROPIC_API_KEY,\n'
      + 'databaseCredentialRemoved: !Object.hasOwn(native, "GRAPHQL_PRODUCTION_DB_PASSWORD")\n'
      + '&& !Object.hasOwn(native, "DATABASE_URL") }));'
    const { stdout } = await execute('/usr/bin/systemd-run', ['--user', '--wait', '--pipe', '--collect', '--quiet',
      '--expand-environment=no', `--unit=graphql-native-environment-regression-${randomUUID()}`,
      `--property=EnvironmentFile=${envFile}`, join(release, 'node'), '--input-type=module', '-e', code],
    { timeout: 30_000 })
    assert.deepEqual(JSON.parse(stdout), { providerCredentialDelivered: true, databaseCredentialRemoved: true })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  const environment = await readEnvironment(join(config, 'production.env'))
  assert.equal(readProductEnvironment(environment ?? {}, 'LOCAL_PRODUCTION'), '1', 'Install the compiled local production release first')
  assert.equal(environment.HOST, '127.0.0.1')
  assert.equal(new URL(environment.DATABASE_URL).port, '55440')
  const release = await realpath(join(app, 'current'))
  await import(pathToFileURL(join(release, 'apps/api/dist/app.js')).href)
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  const contracts = join(release, 'apps/api/node_modules/@foreman-code/contracts/dist')
  const { ManagementActionSchema, LocalHumanAccessSchema, WorkspaceUpdateInputSchema } =
    await import(pathToFileURL(join(contracts, 'management/index.js')))
  const { makeCurrentWorkflowFixture } = await import(pathToFileURL(join(contracts, 'wave25/index.js')))
  const { PostgresAccessService } = await import(pathToFileURL(join(release, 'apps/api/dist/modules/access/postgres.js')))
  const recoveryModules = join(release, 'apps/api/dist/modules/harnesses/recovery')
  const { NativeProcessRegistry } = await import(pathToFileURL(join(recoveryModules, 'processRegistry.js')))
  const { cgroupRemoved } = await import(pathToFileURL(join(recoveryModules, 'cgroupBoundary.js')))
  const registry = new NativeProcessRegistry(join(environment.HARNESS_WORKSPACE_ROOT, 'native-process-registry'))
  const expected = await readProductionIdentity(release, environment.DATABASE_URL)
  const ready = () => waitForProductionReady({ origin, expected })
  await ready()
  const dashboard = await fetch(new URL('/workspaces', origin), { credentials: 'omit' })
  assert.equal(dashboard.status, 200)
  assert.match(dashboard.headers.get('content-type'), /text\/html/)
  assert.match(await dashboard.text(), /\/assets\//)
  await qualifyEnvironmentMigration(release)
  assert.equal(await systemctl('show', '--property=Delegate', '--value', unit), 'yes')
  assert.equal(await systemctl('show', '--property=Restart', '--value', unit), 'always')
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, query_timeout: 10_000 })
  pool.on('error', error => console.error('Regression database connection closed:', error.message))
  const access = new PostgresAccessService(pool)
  const clients = []
  const credentials = []
  const secretValues = Object.entries(environment)
    .filter(([key]) => /SECRET|PASSWORD|TOKEN|API_KEY|DATABASE_URL/.test(key)).map(([, value]) => value)
  const runScopes = []
  const operatorErrors = []
  const databaseWaits = []
  const stopDatabaseObserver = await observeDatabaseWaits(pool, databaseWaits)
  let stopOperatorObserver
  let workspaceId
  let conversationId
  const issue = async grants => {
    const issued = await access.issue({ name: 'Installed production regression', audience: 'operator', grants,
      expiresAt: new Date(Date.now() + 30 * 60_000) })
    credentials.push(issued.principal.id)
    secretValues.push(issued.token)
    return issued
  }
  const connect = async issued => {
    const client = new Client({ name: 'local-production-regression', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return client
  }
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
    return decodeMcpToolResult(result)
  }
  let writer
  let writerCredential
  let failure
  const codexModel = process.env.ENG03_CODEX_MODEL ?? 'gpt-5.6-luna'
  try {
    writerCredential = await issue([{ actions: ManagementActionSchema.options, scope: {} }])
    const readClientAccess = async () => LocalHumanAccessSchema.parse(await localRequest('/api/local-human',
      { token: writerCredential.token }))
    assert.equal((await readClientAccess()).principal.id, writerCredential.principal.id)
    const deniedCredential = await issue([{ actions: ['operator_chat:read', 'harnesses:read'], scope: {} }])
    writer = await connect(writerCredential)
    let denied = await connect(deniedCredential)
    await assert.rejects(call(denied, 'operator_chat_create'), /not found|ACCESS_DENIED/)
    const created = await call(writer, 'workspace_create', { commandId: randomUUID(),
      name: `Production regression ${randomUUID()}`, parentPath: environment.WORKSPACE_STORAGE_ROOT })
    workspaceId = created.value.workspace.id
    const workspace = await call(writer, 'workspace_get', { workspaceId })
    const localWorkspace = await localRequest(`/api/management/workspaces/${workspaceId}`, { token: writerCredential.token })
    assert.equal(localWorkspace.workspace.id, workspaceId)
    const update = WorkspaceUpdateInputSchema.parse({ workspaceId, commandId: randomUUID(),
      expectedRevision: workspace.revision, description: 'Scoped agent HTTP update' })
    const deniedUpdate = await fetch(new URL(`/api/management/workspaces/${workspaceId}`, origin), {
      method: 'PATCH', headers: { origin, authorization: `Bearer ${deniedCredential.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(update), signal: AbortSignal.timeout(30_000),
    })
    assert.equal(deniedUpdate.status, 403)
    assert.equal((await deniedUpdate.json()).error.code, 'ACCESS_DENIED')
    const changed = await localRequest(`/api/management/workspaces/${workspaceId}`,
      { token: writerCredential.token, method: 'PATCH', body: update })
    const persistedWorkspace = await call(writer, 'workspace_get', { workspaceId })
    assert.equal(persistedWorkspace.revision, changed.value.revision)
    assert.equal(persistedWorkspace.workspace.description, update.description)
    const conversation = await call(writer, 'operator_chat_create', {
      commandId: randomUUID(), title: 'Production regression',
    })
    conversationId = conversation.conversation.id
    stopOperatorObserver = await observeOperatorErrors(conversationId, writerCredential.token, operatorErrors)
    const beforeChat = await call(writer, 'operator_chat_get', { conversationId: conversation.conversation.id })
    assert.ok(beforeChat.settings, 'Read the accepted Operator settings before native verification')
    const chatSettings = { ...beforeChat.settings }
    if (chatSettings.harness === 'codex') {
      chatSettings.model = codexModel
      chatSettings.reasoningEffort = 'medium'
    } else if (chatSettings.harness === 'claude') {
      chatSettings.model = 'claude-haiku-4-5-20251001'
    }
    await call(writer, 'operator_chat_send', { conversationId: conversation.conversation.id, request: {
      requestId: randomUUID(), configurationVersionId: beforeChat.conversation.operatorConfigurationVersionId,
      settings: chatSettings,
      content: 'Do not use tools. Reply with exactly LOCAL_PRODUCTION_OPERATOR.',
    } })
    const chat = await waitUntil(() => call(writer, 'operator_chat_get', { conversationId: conversation.conversation.id }),
      state => state.turnState === 'idle' || state.turnState === 'error', 'native Operator reply')
    assert.equal(chat.turnState, 'idle', chat.error)
    assert.ok(chat.messages.some(message => message.role === 'assistant'
      && message.content.includes('LOCAL_PRODUCTION_OPERATOR')), 'Missing real native Operator reply')
    await stopOperatorObserver()
    stopOperatorObserver = undefined

    const startWorkflow = async (harness, task) => {
      const catalog = await call(writer, 'harness_get', { harness })
      assert.equal(catalog.discoveryError, null, `${harness} must pass native qualification`)
      const configuration = { ...catalog.defaults }
      if (harness === 'codex') {
        configuration.model = codexModel
        configuration.reasoningEffort = 'medium'
      }
      const agent = (await call(writer, 'agent_create', { workspaceId, commandId: randomUUID(),
        agentId: randomUUID(), name: `Production ${harness}`, configuration,
        prompt: { system: 'Follow the Foreman Code work-handoff output contract. Do not use tools.' } })).value.agent
      const managed = (await call(writer, 'workflow_create', { workspaceId, commandId: randomUUID(),
        name: `Production ${harness}` })).value
      const definition = makeCurrentWorkflowFixture(randomUUID(), 'single').version.definition
      const graph = { ...managed.workflow, workspaceId, entryNodeId: definition.entryNodeId,
        executionPolicy: definition.executionPolicy, approval: { handler: 'user' }, edges: [],
        nodes: [{ ...definition.nodes[0], agentId: agent.id, initialPrompt: task }] }
      const saved = await call(writer, 'workflow_save_v3', { workspaceId, workflowId: managed.workflow.id,
        commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
        expectedWorkflowVersionId: null, expectedLocationRevision: workspace.locationRevision,
        expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId }, graph })
      const input = { workspaceId, workflowId: managed.workflow.id, commandId: randomUUID(),
        executionSemanticsVersion: 3, workflowVersionId: saved.value.version.id,
        expectedWorkflowRevision: saved.value.revision, expectedLocationRevision: workspace.locationRevision,
        expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds, input: {} }
      await assert.rejects(call(denied, 'run_start', input), /not found|ACCESS_DENIED/)
      const started = await call(writer, 'run_start', input)
      const scope = { workspaceId, runId: started.run.id }
      runScopes.push(scope)
      return scope
    }
    const settled = scope => waitUntil(() => call(writer, 'run_record_get', scope),
      record => record.run.executionState === 'completed' && !record.cleanupPending, 'native run settlement')
    const nativeSessions = async scope => (await pool.query(
      `select id,record->>'nativeSessionId' as session from harness_executions
       where run_id=$1 and record->>'nativeSessionId' is not null order by id`, [scope.runId])).rows
    const positivelyStarted = (scope, harness) => waitUntil(async () => (await pool.query(
      `select he.record as execution, ne.record as event
       from harness_native_events ne join harness_executions he on he.id=ne.execution_id
       where he.run_id=$1`, [scope.runId])).rows.some(({ execution, event }) =>
      hasNativeTurnStarted(harness, execution, event)), started => started, `${harness} native startup`)
    for (const harness of ['codex', 'claude']) {
      const scope = await startWorkflow(harness,
        'Finish with routing.kind finish, latestDeliverable {"marker":"LOCAL_PRODUCTION_WORKFLOW"}, remainingFindings [].')
      const record = await settled(scope)
      assert.equal(record.run.outcome, 'succeeded')
      assert.equal((await nativeSessions(scope)).length, 1, 'Workflow must bind a real native session')
    }
    const longTask = 'Write every integer from 1 to 10000 and its square in latestDeliverable.rows. '
      + 'Compute it yourself without tools. Follow the work-handoff output contract.'
    const canceled = await startWorkflow('codex', longTask)
    await positivelyStarted(canceled, 'codex')
    await call(writer, 'run_stop', { ...canceled, commandId: randomUUID() })
    assert.equal((await settled(canceled)).run.outcome, 'canceled')

    await recoverFailedDatabaseStartup(environment, ready)
    await Promise.all(clients.map(client => client.close()))
    clients.length = 0
    writer = await connect(writerCredential)
    denied = await connect(deniedCredential)
    await assert.rejects(call(denied, 'workspace_get', { workspaceId }), /not found|ACCESS_DENIED/)
    assert.equal((await call(writer, 'workspace_get', { workspaceId })).workspace.id, workspaceId)
    assert.equal((await readClientAccess()).principal.id, writerCredential.principal.id)
    assert.equal((await localRequest(`/api/management/workspaces/${workspaceId}`,
      { token: writerCredential.token })).workspace.description, 'Scoped agent HTTP update')
    const afterStartup = await call(writer, 'run_record_get', canceled)
    assert.equal(afterStartup.run.outcome, 'canceled')
    assert.equal(afterStartup.cleanupPending, false)
    assert.ok((await call(writer, 'operator_chat_get', { conversationId })).messages
      .some(message => message.content.includes('LOCAL_PRODUCTION_OPERATOR')))

    const pid = await systemctl('show', '--property=MainPID', '--value', unit)
    await execute('/usr/bin/docker', ['compose', '--project-name', 'graphql-local-production',
      '--file', join(app, 'compose.production.yaml'), 'restart', 'postgres'], { timeout: 90_000,
      env: { ...process.env, ...environment } })
    await waitUntil(() => systemctl('show', '--property=MainPID', '--value', unit),
      value => value !== '0' && value !== pid, 'API restart after PostgreSQL ownership loss', 120_000)
    await ready()
    await Promise.all(clients.map(client => client.close()))
    clients.length = 0
    writer = await connect(writerCredential)
    denied = await connect(deniedCredential)
    assert.equal((await call(writer, 'run_record_get', canceled)).run.outcome, 'canceled')
    const persistedChat = await call(writer, 'operator_chat_get', { conversationId: conversation.conversation.id })
    assert.ok(persistedChat.messages.some(message => message.content.includes('LOCAL_PRODUCTION_OPERATOR')))

    const recovering = await startWorkflow('claude', longTask)
    await positivelyStarted(recovering, 'claude')
    const sessions = await nativeSessions(recovering)
    const beforeCrash = await systemctl('show', '--property=MainPID', '--value', unit)
    await systemctl('kill', '--kill-whom=main', '--signal=KILL', unit)
    await waitUntil(() => systemctl('show', '--property=MainPID', '--value', unit),
      value => value !== '0' && value !== beforeCrash, 'API crash restart', 120_000)
    await ready()
    await Promise.all(clients.map(client => client.close()))
    clients.length = 0
    writer = await connect(writerCredential)
    await settled(recovering)
    assert.deepEqual(await nativeSessions(recovering), sessions, 'Recovery must retain original execution/session bindings')

    for (const harness of ['codex', 'claude']) {
      denied = await connect(deniedCredential)
      const killed = await startWorkflow(harness, longTask)
      await positivelyStarted(killed, harness)
      const bindings = await nativeSessions(killed)
      const owners = new Set(bindings.map(binding => `execution:${binding.id}`))
      const launches = registry.snapshot().launches
        .filter(launch => owners.has(launch.owner) && launch.lifecycle === 'active')
      assert.ok(launches.length > 0, 'Native work must have registered launch boundaries')
      for (const launch of launches) assert.ok(launch.boundary, 'Native work must be contained before the crash')
      const beforeKill = await systemctl('show', '--property=MainPID', '--value', unit)
      await systemctl('kill', '--kill-whom=all', '--signal=KILL', unit)
      await waitUntil(() => systemctl('show', '--property=MainPID', '--value', unit),
        value => value !== '0' && value !== beforeKill, 'service-wide SIGKILL restart', 120_000)
      await ready()
      for (const launch of launches) {
        assert.equal(cgroupRemoved(launch.boundary), true, 'Systemd must have pruned the killed native tree')
      }
      await Promise.all(clients.map(client => client.close()))
      clients.length = 0
      writer = await connect(writerCredential)
      denied = await connect(deniedCredential)
      await assert.rejects(call(denied, 'run_stop', { ...killed, commandId: randomUUID() }), /not found|ACCESS_DENIED/)
      await call(writer, 'run_stop', { ...killed, commandId: randomUUID() })
      const stopped = await settled(killed)
      assert.notEqual(stopped.run.outcome, 'pending')
      assert.deepEqual(await nativeSessions(killed), bindings, 'Stop must retain the killed execution/session bindings')
      await systemctl('restart', unit)
      await ready()
      await Promise.all(clients.map(client => client.close()))
      clients.length = 0
      writer = await connect(writerCredential)
      const persisted = await call(writer, 'run_record_get', killed)
      assert.equal(persisted.cleanupPending, false, 'Confirmed cleanup must survive another API restart')
      assert.equal(persisted.run.outcome, stopped.run.outcome)
      assert.deepEqual(await nativeSessions(killed), bindings)
    }
  } catch (error) {
    failure = error
  } finally {
    const errors = failure ? [failure] : []
    if (stopOperatorObserver) await stopOperatorObserver()
    if (failure && conversationId) {
      try {
        const { nativePersistenceRedactor } = await import(pathToFileURL(
          join(release, 'apps/api/dist/modules/interactions/nativePersistence.js')))
        const state = (await pool.query(`select harness,native_session_id,active_request_id,
          active_native_turn_id,turn_state,active_phase,cancel_requested,last_error
          from operator_conversations where id=$1`, [conversationId])).rows[0]
        const diagnostic = join(process.cwd(), '.logs/production-installed', `${conversationId}.json`)
        await publish(diagnostic, JSON.stringify(nativePersistenceRedactor(secretValues).value({
          conversationId, error: failure.message, state, operatorErrors, databaseWaits,
        }), null, 2) + '\n')
        console.log(`Installed Operator failure evidence: ${diagnostic}`)
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      if (writerCredential) {
        const cleanupClient = await connect(writerCredential)
        const cleanup = async action => {
          try { await action() } catch (error) { errors.push(error) }
        }
        if (conversationId) await cleanup(async () => {
          const chat = await call(cleanupClient, 'operator_chat_get', { conversationId })
          if (chat.activeRequestId) {
            await call(cleanupClient, 'operator_chat_cancel', { conversationId,
              request: { requestId: chat.activeRequestId, commandId: randomUUID() } })
            await waitUntil(() => call(cleanupClient, 'operator_chat_get', { conversationId }),
              value => !value.activeRequestId, 'test-owned Operator cleanup')
          }
        })
        for (const scope of runScopes) await cleanup(async () => {
          const record = await call(cleanupClient, 'run_record_get', scope)
          if (record.run.executionState !== 'completed' || record.cleanupPending) {
            await call(cleanupClient, 'run_stop', { ...scope, commandId: randomUUID() })
            await waitUntil(() => call(cleanupClient, 'run_record_get', scope),
              value => value.run.executionState === 'completed' && !value.cleanupPending, 'test-owned run cleanup')
          }
        })
        if (workspaceId) await cleanup(async () => {
          const workspace = await call(cleanupClient, 'workspace_get', { workspaceId })
          await call(cleanupClient, 'workspace_archive', { workspaceId, commandId: randomUUID(),
            expectedRevision: workspace.revision })
          const runtime = join(environment.HARNESS_WORKSPACE_ROOT, workspaceId)
          await rm(runtime, { recursive: true, force: true })
          await assert.rejects(stat(runtime), { code: 'ENOENT' }, 'Test-owned runtime storage must be removed')
        })
      }
    } catch (error) {
      errors.push(error)
    }
    try {
      const closed = await Promise.allSettled(clients.map(client => client.close()))
      const revoked = await Promise.allSettled(credentials.map(id => access.revoke(id)))
      for (const result of [...closed, ...revoked]) if (result.status === 'rejected') errors.push(result.reason)
    } finally {
      try {
        await stopDatabaseObserver()
        if (databaseWaits.length) {
          const diagnostic = join(process.cwd(), '.logs/production-installed', `database-waits-${randomUUID()}.json`)
          await publish(diagnostic, JSON.stringify({ databaseWaits }, null, 2) + '\n')
          console.log(`Installed database wait evidence: ${diagnostic}`)
        }
      } finally { await pool.end() }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'))
  }
  console.log('Installed production passed: scoped HTTP/MCP grants, native execution, cancellation, database startup/restart and crash recovery.')
}

withInstallationLock(join(config, 'install.lock'), main).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
