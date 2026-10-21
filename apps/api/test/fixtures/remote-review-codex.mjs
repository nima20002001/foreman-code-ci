/* global Buffer, process, setInterval, setTimeout, URL */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { runNativeShell } from './remote-review-shell.mjs'

// External provider protocol fixture. The application still qualifies the
// pinned schema, native manager, credentials and physical process owner.
const root = process.argv[2]
const args = process.argv.slice(3)
const cliVersion = process.env.REMOTE_REVIEW_CODEX_VERSION ?? '0.154.0'
const executableSha256 = createHash('sha256').update(readFileSync(join(root, 'codex'))).digest('hex')
const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
const startup = value => appendFileSync(join(root, 'startup.jsonl'),
  `${JSON.stringify({ occurredAt: new Date().toISOString(), ...value })}\n`)
const log = value => {
  appendFileSync(join(root, 'calls.jsonl'), `${JSON.stringify(value)}\n`)
  if (value.nativeStarted || value.method || value.workflowTurn || value.workflowCompleted) startup(value)
}
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (id, result) => send({ id, result })
const notify = (method, params) => send({ method, params })
const mcpName = 'foreman-code'
const disabled = args.some((value, index) => value === '-c' && args[index + 1] === `mcp_servers.${mcpName}.enabled=false`)
const nativeConfigFile = join(process.env.CODEX_HOME ?? join(root, 'codex-home'), 'config.toml')
const defaultMcp = { command: process.execPath, args: [settings.launcher],
  env_vars: ['FOREMAN_CODE_MCP_TOKEN'], enabled: true, required: true }
// The external fixture stores its native configuration as JSON in the user file.
const readNativeConfig = () => {
  const text = existsSync(nativeConfigFile) ? readFileSync(nativeConfigFile, 'utf8').trim() : ''
  return text ? JSON.parse(text) : { mcp_servers: { [mcpName]: defaultMcp } }
}
const configVersion = config => createHash('sha256').update(JSON.stringify(config)).digest('hex')
const nativeMcp = readNativeConfig().mcp_servers[mcpName]
const mcp = {
  name: mcpName, enabled: !disabled && nativeMcp?.enabled !== false, required: true,
  transport: { type: 'stdio', ...nativeMcp },
}
startup({ nativeCommand: { pid: process.pid, command: args[0] ?? null, subcommand: args[1] ?? null } })

if (args[0] === '--version') {
  while (existsSync(join(root, 'block-versions'))) await new Promise(resolve => setTimeout(resolve, 20))
  if (existsSync(join(root, 'invalid-versions'))) {
    startup({ invalidVersion: true })
    process.stdout.write('codex-cli 0.')
    process.exit(0)
  }
  process.stdout.write(`codex-cli ${cliVersion}\n`)
  process.exit(0)
}
if (args[0] === 'login') {
  process.stdout.write('Logged in using ChatGPT\n')
  process.exit(0)
}
if (args[0] === 'debug') {
  send({ models: [{ slug: 'test-model', display_name: 'Test model',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'low',
    additional_speed_tiers: ['fast'] }] })
  process.exit(0)
}
if (args[0] === 'mcp') {
  if (args[1] === 'get' && args[2] !== mcpName) {
    process.stderr.write(`Error: No MCP server named '${args[2]}' found.\n`)
    process.exit(1)
  }
  send(args[1] === 'list' ? [mcp] : mcp)
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)
if (args[1] === 'generate-json-schema') {
  const destination = args[args.indexOf('--out') + 1]
  mkdirSync(destination, { recursive: true })
  const variant = args.includes('--experimental') ? 'experimental' : 'stable'
  copyFileSync(join(root, variant, 'codex_app_server_protocol.schemas.json'),
    join(destination, 'codex_app_server_protocol.schemas.json'))
  process.exit(0)
}

let thread
let inboxOffset = 0
let nextRequest = 1000
const pending = new Map()
const save = () => writeFileSync(join(root, `thread-${thread.id}.json`), JSON.stringify(thread), { mode: 0o600 })
const view = includeTurns => {
  const active = thread.turns.some(turn => turn.status === 'inProgress')
  return { id: thread.id, cliVersion, createdAt: 1, updatedAt: 2, cwd: thread.settings.cwd,
    ephemeral: thread.ephemeral, modelProvider: 'openai', preview: '', projectId: null, sessionId: thread.id,
    source: 'appServer', status: active ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    path: null, gitInfo: null, turns: includeTurns ? thread.turns : [] }
}
const configuration = params => {
  const config = params.config ?? {}
  const write = config.sandbox_workspace_write ?? {}
  return { model: params.model ?? 'test-model', modelProvider: 'openai', cwd: params.cwd ?? process.cwd(),
    reasoningEffort: config.model_reasoning_effort ?? 'low', serviceTier: params.serviceTier === 'fast' ? 'fast' : null,
    approvalPolicy: params.approvalPolicy ?? 'never', approvalsReviewer: params.approvalsReviewer ?? 'user',
    instructionSources: [], sandbox: params.sandbox === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: write.writable_roots ?? [], networkAccess: write.network_access ?? false,
        excludeTmpdirEnvVar: write.exclude_tmpdir_env_var ?? false, excludeSlashTmp: write.exclude_slash_tmp ?? false }
      : { type: 'readOnly', networkAccess: false } }
}
const complete = (turn, text = 'fixture complete', status = 'completed') => {
  turn.status = status
  turn.completedAt = 2
  turn.durationMs = 1
  const item = { type: 'agentMessage', id: `answer-${turn.id}`, text, phase: 'final_answer' }
  turn.items.push(item)
  save()
  notify('item/completed', { threadId: thread.id, turnId: turn.id, item, completedAtMs: 2 })
  notify('turn/completed', { threadId: thread.id, turn })
}
const request = (method, params) => {
  const id = ++nextRequest
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
}
const tool = (turn, name, arguments_) => request('item/tool/call', {
  threadId: thread.id, turnId: turn.id, callId: randomUUID(), tool: name, arguments: arguments_,
})

async function qualificationFiles(turn, prompt) {
  log({ qualificationSuite: { pid: process.pid, binarySha256: executableSha256 } })
  while (existsSync(join(root, 'block-qualification'))) await new Promise(resolve => setTimeout(resolve, 20))
  const fileId = /fileId (\S+)/.exec(prompt)[1]
  const revisionId = /revisionId (\S+)/.exec(prompt)[1]
  const response = await tool(turn, 'files_read', { fileId, revisionId, offset: 0, length: 65536 })
  const read = JSON.parse(response.contentItems[0].text)
  const outputPath = JSON.parse(/Write (".*?") as Markdown/.exec(prompt)[1])
  writeFileSync(outputPath, `${Buffer.from(read.contentBase64, 'base64')}\nQUALIFIED\n`, { mode: 0o600 })
  const scope = JSON.parse(/and scope (\{.*\})\. Do not/.exec(prompt)[1])
  await tool(turn, 'files_publish_result', { artifactId: 'qualification-result',
    commandId: /commandId (\S+),/.exec(prompt)[1], filename: 'qualification-result.md',
    mediaType: 'text/markdown', scope })
  complete(turn, 'QUALIFIED')
}

async function mcpCall(name, arguments_) {
  const { Client, StreamableHTTPClientTransport } = await import(settings.clientModule)
  const token = process.env.FOREMAN_CODE_MCP_TOKEN
  const digest = createHash('sha256').update(token).digest('hex')
  const route = JSON.parse(readFileSync(join(dirname(settings.launcher), 'routes', `${digest}.json`), 'utf8'))
  const client = new Client({ name: 'Remote reviewer protocol fixture', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(route.endpoint), {
      authProvider: { token: async () => token },
    }))
    const result = await client.callTool({ name, arguments: arguments_ })
    if (result.isError) throw new Error(`MCP ${name} denied: ${JSON.stringify(result.content)}`)
    return result.structuredContent
  } finally {
    await client.close()
  }
}

async function review(turn, prompt) {
  const interactionId = /interaction (\S+)\./.exec(prompt)[1]
  log({ review: { interactionId, sessionId: thread.id, turnId: turn.id, pid: process.pid } })
  while (!existsSync(join(root, 'release-review'))) await new Promise(resolve => setTimeout(resolve, 20))
  const value = await mcpCall('interaction_get', { interactionId })
  const interaction = value.interaction ?? value
  const option = interaction.responseOptions.find(option => option.semantic === 'approve_once')
  if (!option) throw new Error('The request has no approve-once option.')
  const input = {
    interactionId, optionId: option.optionId, expectedRevision: interaction.revision,
  }
  let decision
  try {
    decision = await mcpCall('interaction_respond', input)
  } catch (error) {
    log({ reviewDecisionError: { interactionId, message: error.message } })
  }
  log({ reviewDecision: { interactionId, value: decision } })
  if (decision?.interaction?.selectedOptionId !== option.optionId) {
    throw new Error('The reviewer decision was not recorded.')
  }
  // The product delivers only after this review's native terminal is committed.
  complete(turn, 'Review decision recorded')
  if (decision.interaction.deliveryState !== 'delivered') {
    while (!existsSync(join(root, 'retry-review'))) await new Promise(resolve => setTimeout(resolve, 20))
    decision = await mcpCall('interaction_respond', input)
    log({ retriedReviewDecision: { interactionId, value: decision } })
  }
}

async function started(turn, prompt) {
  if (prompt.startsWith('Run this exact command once with the native shell tool.')) {
    const command = prompt.slice(prompt.indexOf('\n') + 1)
    const item = { type: 'commandExecution', id: `command-${turn.id}`, command,
      commandActions: [], cwd: thread.settings.cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null }
    turn.items.push(item)
    save()
    notify('item/started', { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() })
    const result = await runNativeShell(command, thread.settings, settings)
    item.status = result.exitCode === 0 ? 'completed' : 'failed'
    item.exitCode = result.exitCode
    item.aggregatedOutput = result.output
    save()
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() })
    log({ nativeShell: { exitCode: result.exitCode, output: result.output } })
    complete(turn, 'Native command finished.', result.exitCode === 0 ? 'completed' : 'failed')
    return
  }
  if (prompt.startsWith('Call files_read with fileId ')) return qualificationFiles(turn, prompt)
  if (String(turn.items[0].clientId).startsWith('review-')) return review(turn, prompt)
  if (thread.instructions.includes('fixture-reviewer')) {
    if (thread.instructions.includes('fixture-write-source')) {
      writeFileSync(join(thread.settings.cwd, 'README.md'), '# Native workflow edit\n')
    }
    log({ workflowTurn: { pid: process.pid, sessionId: thread.id, turnId: turn.id } })
    const block = join(root, 'block-workflow-turns')
    const position = readFileSync(join(root, 'calls.jsonl'), 'utf8').split('\n')
      .filter(line => line && JSON.parse(line).workflowTurn).length
    for (;;) {
      let contents
      try {
        contents = readFileSync(block, 'utf8')
      } catch (error) {
        // Unlinking this file releases turns, including between a check and an open.
        if (error.code === 'ENOENT') break
        throw error
      }
      if (contents && position <= JSON.parse(contents).allowFirst) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const answersFile = join(root, 'workflow-answers.json')
    const artifactFile = join(root, 'workflow-artifact.json')
    if (existsSync(artifactFile)) {
      const artifact = JSON.parse(readFileSync(artifactFile, 'utf8'))
      const call = async (name, input) => {
        log({ nativeOutput: { name, phase: 'requested', occurredAt: new Date().toISOString() } })
        const response = await tool(turn, name, input)
        log({ nativeOutput: { name, phase: 'replied', success: response.success, occurredAt: new Date().toISOString() } })
        if (!response.success) throw new Error(`Native artifact ${name} failed: ${JSON.stringify(response)}`)
        return JSON.parse(response.contentItems[0].text)
      }
      const description = { filename: 'report.md', mediaType: 'text/markdown' }
      const created = await call('files_native_output_create', { operation: 'create', ...description, commandId: randomUUID() })
      await call('files_native_output_append', { operation: 'append', artifactId: created.artifactId, commandId: randomUUID(),
        offset: 0, contentBase64: Buffer.from(artifact.content).toString('base64') })
      await call('files_native_output_seal', { operation: 'seal', artifactId: created.artifactId, commandId: randomUUID() })
      const commandId = randomUUID()
      await call('files_native_output_publish', { operation: 'publish',
        publication: { ...description, artifactId: created.artifactId, commandId } })
      complete(turn, JSON.stringify({ data: 'Report published', summary: 'Report published.',
        board: { kind: 'none', reason: 'no_access' },
        artifactOutputs: { version: 1, outputs: [{ outputKey: artifact.outputKey, commandId }] } }))
      log({ workflowCompleted: { pid: process.pid, sessionId: thread.id, turnId: turn.id } })
      return
    }
    const answers = existsSync(answersFile) ? JSON.parse(readFileSync(answersFile, 'utf8')) : undefined
    // Started Runs pin the f1-f4-v1 result protocol: summary and board are required, and a loop check
    // (never routed) answers with the plain envelope instead of a handoff.
    const summary = { summary: 'Fixture work complete.', board: { kind: 'none', reason: 'no_access' } }
    let output = thread.instructions.includes('fixture-work-handoff')
      ? JSON.stringify(prompt.includes('Foreman Code loop ')
        ? { data: 'fixture complete', ...summary }
        : { routing: { kind: 'finish' }, data: { latestDeliverable: 'fixture complete', remainingFindings: [] }, ...summary })
      : 'fixture complete'
    if (answers) output = answers[Math.min(thread.turns.length - 1, answers.length - 1)]
    complete(turn, output)
    log({ workflowCompleted: { pid: process.pid, sessionId: thread.id, turnId: turn.id } })
    return
  }
  if (prompt.includes('fixture-requester') || thread.instructions.includes('fixture-requester')) {
    const item = { type: 'commandExecution', id: `command-${turn.id}`, command: 'printf harmless',
      commandActions: [], cwd: thread.settings.cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null }
    turn.items.push(item)
    save()
    notify('item/started', { threadId: thread.id, turnId: turn.id, item, startedAtMs: 1 })
    const result = await request('item/commandExecution/requestApproval', {
      threadId: thread.id, turnId: turn.id, itemId: item.id, command: item.command,
      cwd: item.cwd, startedAtMs: 1, commandActions: [],
    })
    log({ approvalResponse: { sessionId: thread.id, turnId: turn.id, result } })
    notify('serverRequest/resolved', { threadId: thread.id, requestId: nextRequest })
    item.status = 'completed'
    item.exitCode = 0
    save()
    notify('item/completed', { threadId: thread.id, turnId: turn.id, item, completedAtMs: 2 })
    complete(turn, 'Requester completed')
    return
  }
  complete(turn)
}

log({ nativeStarted: { pid: process.pid } })
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  const message = JSON.parse(line)
  if (!message.method) {
    const waiting = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiting?.reject(new Error('The provider callback was rejected.'))
    else waiting?.resolve(message.result)
    return
  }
  const params = message.params ?? {}
  log({ method: message.method, pid: process.pid, threadId: params.threadId, correlationId: params.clientUserMessageId, model: params.model,
    reasoningEffort: params.config?.model_reasoning_effort,
    ...(message.method === 'turn/start' ? { outputSchema: params.outputSchema } : {}),
    ...(message.method === 'model/list' ? { workingDirectory: process.cwd(), providerVersion: cliVersion } : {}) })
  if (message.method === 'initialize') {
    reply(message.id, { userAgent: `codex-cli ${cliVersion}`, platformFamily: 'unix', platformOs: 'linux', codexHome: root })
  } else if (message.method === 'initialized') {
    return
  } else if (message.method === 'thread/start') {
    thread = { id: randomUUID(), ephemeral: params.ephemeral === true, turns: [], settings: configuration(params),
      instructions: `${params.baseInstructions ?? ''}\n${params.developerInstructions ?? ''}` }
    save()
    if (thread.instructions.includes('fixture-requester') && existsSync(join(root, 'block-requester-session'))) {
      log({ requesterSessionBlocked: { pid: process.pid } })
    } else {
      reply(message.id, { ...thread.settings, thread: view(false) })
    }
  } else if (message.method === 'thread/resume') {
    thread = JSON.parse(readFileSync(join(root, `thread-${params.threadId}.json`), 'utf8'))
    thread.settings = configuration(params)
    save()
    reply(message.id, { ...thread.settings, thread: view(!params.excludeTurns) })
  } else if (message.method === 'thread/fork') {
    const source = JSON.parse(readFileSync(join(root, `thread-${params.threadId}.json`), 'utf8'))
    thread = { ...source, id: randomUUID(), settings: configuration(params) }
    save()
    log({ forkedSession: { source: source.id, child: thread.id, cwd: thread.settings.cwd } })
    reply(message.id, { ...thread.settings, thread: view(!params.excludeTurns) })
  } else if (message.method === 'thread/read') {
    thread = JSON.parse(readFileSync(join(root, `thread-${params.threadId}.json`), 'utf8'))
    reply(message.id, { thread: view(params.includeTurns === true) })
  } else if (message.method === 'thread/turns/list') {
    reply(message.id, { data: [...thread.turns].reverse(), nextCursor: null, backwardsCursor: null })
  } else if (message.method === 'thread/compact/start') {
    const turn = { id: randomUUID(), status: 'completed', itemsView: 'full', error: null,
      startedAt: 1, completedAt: 2, durationMs: 1,
      items: [{ id: randomUUID(), type: 'contextCompaction' }] }
    thread.turns.push(turn)
    save()
    log({ compactedSession: thread.id })
    reply(message.id, {})
    notify('turn/started', { threadId: thread.id, turn: { ...turn, status: 'inProgress' } })
    notify('turn/completed', { threadId: thread.id, turn })
  } else if (message.method === 'turn/start') {
    const turn = { id: randomUUID(), status: 'inProgress', itemsView: 'full', error: null,
      startedAt: 1, completedAt: null, durationMs: null,
      items: [{ type: 'userMessage', id: randomUUID(), clientId: params.clientUserMessageId, content: params.input }] }
    thread.turns.push(turn)
    save()
    reply(message.id, { turn })
    void started(turn, params.input.map(item => item.text ?? '').join('\n')).catch(error => {
      log({ providerFailure: error.message })
      process.exitCode = 1
    })
  } else if (message.method === 'turn/interrupt') {
    const turn = thread.turns.find(turn => turn.id === params.turnId)
    reply(message.id, {})
    if (turn?.status === 'inProgress') complete(turn, 'Interrupted', 'interrupted')
  } else if (message.method === 'config/read') {
    const user = readNativeConfig()
    reply(message.id, { config: { approval_policy: thread?.settings.approvalPolicy ?? 'never',
      mcp_servers: { ...user.mcp_servers,
        [mcpName]: { ...user.mcp_servers[mcpName], enabled: mcp.enabled } } }, origins: {},
      layers: [{ name: { type: 'user', file: nativeConfigFile }, version: configVersion(user), config: user }] })
  } else if (message.method === 'config/batchWrite') {
    const user = readNativeConfig()
    if (params.filePath !== nativeConfigFile || params.expectedVersion !== configVersion(user)) {
      send({ id: message.id, error: { code: -32602, message: 'Native configuration changed' } })
      return
    }
    for (const edit of params.edits) {
      const name = edit.keyPath.slice('mcp_servers.'.length)
      if (edit.value === null) delete user.mcp_servers[name]
      else user.mcp_servers[name] = edit.value
    }
    mkdirSync(dirname(nativeConfigFile), { recursive: true })
    writeFileSync(nativeConfigFile, JSON.stringify(user), { mode: 0o600 })
    mcp.enabled = !disabled && user.mcp_servers[mcpName]?.enabled !== false
    reply(message.id, { status: 'ok', version: configVersion(user), filePath: nativeConfigFile })
  } else if (message.method === 'mcpServerStatus/list') {
    const workflowAdmission = thread?.instructions.includes('fixture-work-handoff') && thread.turns.length === 0
    if (workflowAdmission && existsSync(join(root, 'block-workflow-admission'))) {
      const admitted = readFileSync(join(root, 'calls.jsonl'), 'utf8').split('\n')
        .filter(line => line && JSON.parse(line).workflowTurn).length
      if (admitted >= 2) {
        log({ workflowAdmissionBlocked: { pid: process.pid, sessionId: thread.id } })
        while (existsSync(join(root, 'block-workflow-admission'))) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
    }
    const enabled = mcp.enabled && !(workflowAdmission && existsSync(join(root, 'fail-workflow-admission')))
    reply(message.id, { data: [{ name: mcpName, runtimeStatus: enabled ? 'connected' : 'disabled', toolsError: null,
      tools: mcp.enabled ? { context_get: { name: 'context_get', inputSchema: { type: 'object' } } } : {},
      resources: [], resourceTemplates: [], authStatus: 'bearerToken' }], nextCursor: null })
  } else if (message.method === 'model/list') {
    const models = [{ id: 'test-model', model: 'test-model', displayName: 'Test model',
      description: 'External protocol fixture', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' },
        { reasoningEffort: 'medium', description: 'Medium' }] }]
    models.push({ ...models[0], id: 'other-model', model: 'other-model', displayName: 'Other model', isDefault: false })
    const respond = async () => {
      const blocked = () => {
        const allowedFile = join(root, 'allowed-model-directories')
        if (existsSync(allowedFile)) {
          try {
            const allowed = JSON.parse(readFileSync(allowedFile, 'utf8'))
            if (allowed.some(directory => process.cwd() === directory || process.cwd().startsWith(`${directory}/`))) {
              return false
            }
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
        let contents
        try { contents = readFileSync(join(root, 'block-models'), 'utf8') }
        catch (error) {
          if (error.code === 'ENOENT') return false
          throw error
        }
        if (!contents) return true
        const { workingDirectory } = JSON.parse(contents)
        const cwd = process.cwd()
        return cwd === workingDirectory || cwd.startsWith(`${workingDirectory}/`)
      }
      while (blocked()) await new Promise(resolve => setTimeout(resolve, 20))
      if (existsSync(join(root, 'fail-model-refresh'))) {
        process.stderr.write('failed to refresh available models: fixture remote discovery unavailable\n')
      }
      reply(message.id, { data: existsSync(join(root, 'hide-models')) ? [] : models, nextCursor: null })
    }
    void respond()
  } else if (message.method === 'config/mcpServer/reload') {
    reply(message.id, {})
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Unrecorded provider method' } })
  }
}).on('close', () => process.exit(process.exitCode ?? 0))

setInterval(() => {
  if (!thread) return
  const inbox = join(root, `inbox-${thread.id}.jsonl`)
  if (!existsSync(inbox)) return
  const text = readFileSync(inbox, 'utf8')
  const lines = text.slice(inboxOffset).split('\n').filter(Boolean)
  inboxOffset = text.length
  for (const line of lines) send(JSON.parse(line))
}, 20)
