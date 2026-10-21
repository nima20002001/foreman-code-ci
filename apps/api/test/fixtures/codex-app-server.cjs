/* global require, __dirname, console, process, setInterval, setTimeout, fetch */
/* eslint @typescript-eslint/no-require-imports: "off" -- Standalone executable fixture copied without compilation. */
// Deterministic provider fault fixture; management calls use its native MCP configuration.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const root = __dirname
const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) } catch { return fallback }
}
const save = (name, value) => {
  const destination = path.join(root, name)
  const temporary = `${destination}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, destination)
}
const flag = (name) => fs.existsSync(path.join(root, name))
const log = (value) => fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ processPid: process.pid, ...value }) + '\n')
const timing = (value) => {
  if (flag('record-wire-timing')) fs.appendFileSync(path.join(root, 'wire-timing.jsonl'),
    JSON.stringify({ at: Date.now(), fixtureProcessId: process.pid, ...value }) + '\n')
}
const args = process.argv.slice(2)
const processDisabledMcp = new Set(args.flatMap((argument, index) => {
  if (argument !== '-c') return []
  const matched = /^mcp_servers\.([A-Za-z0-9_-]+)\.enabled=false$/.exec(args[index + 1] || '')
  return matched ? [matched[1]] : []
}))
log({ cli: args })
if (args[0] === '--version') { console.log(read('version.json', 'codex-cli 0.154.0')); process.exit(0) }
if (flag('diagnostic-barrier') && (args[0] === 'login' || args[1] === 'generate-json-schema')) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!flag('release-diagnostics')) Atomics.wait(wait, 0, 0, 10)
  log({ diagnosticCompleted: args })
}
if (args[0] === 'login') {
  if (flag('logged-out')) { console.error('Not logged in'); process.exit(1) }
  console.log('Logged in using ChatGPT'); process.exit(0)
}
if (args[0] === 'debug') {
  console.log(JSON.stringify(read('models.json', {
    models: [{ slug: 'test-model', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], additional_speed_tiers: ['fast'] }],
  }))); process.exit(0)
}
if (args[0] === 'mcp') {
  if (flag('no-mcp')) {
    if (args[1] === 'list') { console.log('[]'); process.exit(0) }
    console.error(`Error: No MCP server named '${args[2]}' found.`)
    process.exit(1)
  }
  if (args[1] === 'list') {
    const entries = read('mcp-list.json', [{ name: read('mcp.json', { name: 'graphql' }).name || 'graphql' }])
    console.log(JSON.stringify(Array.isArray(entries)
      ? entries.map(entry => ({ transport: { type: 'stdio', command: 'fixture-mcp' }, ...entry })) : entries))
    process.exit(0)
  }
  const entryName = read('mcp.json', { name: 'graphql' }).name || 'graphql'
  if (args[1] === 'get' && args[2] !== entryName) {
    console.error(`Error: No MCP server named '${args[2]}' found.`)
    process.exit(1)
  }
  console.log(JSON.stringify(read('mcp.json', {
    name: args[2], enabled: true, required: true,
    transport: { type: 'streamable_http', url: 'http://127.0.0.1:3000/mcp/app', bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' },
    enabled_tools: ['context_get'], disabled_tools: ['interaction_respond'],
  }))); process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)
if (args[1] === 'generate-json-schema') {
  const directory = args[args.indexOf('--out') + 1]
  fs.mkdirSync(directory, { recursive: true })
  // Schema fixtures exercise the real contract checker without a provider turn.
  save(path.relative(root, path.join(directory, 'codex_app_server_protocol.schemas.json')), read('schema.json', { definitions: {} }))
  process.exit(0)
}
const agent = process.env.TEST_AGENT_ID || 'agent-a'
process.stdin.on('end', () => {
  if (flag('models-late-stdout')) fs.writeSync(1, JSON.stringify({ method: 'test/lateMetadata', params: {} }) + '\n')
  if (flag('models-refresh-failed-on-close')) fs.writeSync(2, 'failed to refresh available models: fixture refresh failure\n')
  process.exit(0)
})
let created = 0
const outstanding = new Map()
const heldReplies = []
const replyOrHold = (kind, reply) => {
  if (flag(`hold-${kind}`)) heldReplies.push({ kind, reply })
  else reply()
}
const send = (value) => {
  if (value.id !== undefined) timing({ direction: 'response', id: value.id, method: value.method,
    errorCode: value.error?.code })
  return process.stdout.write(JSON.stringify(value) + '\n')
}
const result = (id, value) => send({ id, result: value })
const fail = (id) => send({ id, error: { code: -32000, message: 'fixture rejection' } })
const store = (owner) => save(`state-${owner.id}.json`, owner)
const loadThread = (threadId) => read(`state-${threadId}.json`, null)
const userMessage = (id, clientId, content = []) => ({ type: 'userMessage', id, clientId: clientId ?? null, content })
const agentMessage = (id, text) => ({
  type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
})
const turn = (id, status = 'inProgress', correlation = null, content = []) => ({
  id, status, itemsView: 'full', error: null, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: null,
  items: [userMessage(`native-user-${id}-1`, correlation, content)],
})
const thread = (id, params, original) => ({
  id, sessionId: id, forkedFromId: original?.id || null, parentThreadId: null,
  preview: '', ephemeral: !!params.ephemeral, section: null, sectionEnteredAt: null, projectId: null,
  historyMode: 'legacy', modelProvider: 'openai', model: params.model || 'test-model',
  reasoningEffort: params.config?.model_reasoning_effort || 'medium', createdAt: 1, updatedAt: 1,
  recencyAt: null, status: { type: 'idle' }, path: null, cwd: params.cwd || process.cwd(),
  cliVersion: '0.154.0', originator: null, source: 'appServer', threadSource: null,
  agentNickname: null, agentRole: null, gitInfo: null, name: null,
  turns: original ? JSON.parse(JSON.stringify(original.turns)) : [], settings: settings(params),
})
const settings = (params, previous = {}) => {
  const config = params.config || {}
  const workspace = config.sandbox_workspace_write || {}
  let serviceTier = previous.serviceTier || null
  if (Object.hasOwn(params, 'serviceTier')) {
    serviceTier = params.serviceTier === 'fast' ? 'fast' : null
    if (serviceTier === 'fast' && flag('native-priority-tier')) serviceTier = 'priority'
  }
  let sandbox = previous.sandbox || { type: 'readOnly', networkAccess: false }
  if (params.sandbox === 'danger-full-access') sandbox = { type: 'dangerFullAccess' }
  if (params.sandbox === 'read-only') sandbox = { type: 'readOnly', networkAccess: false }
  if (params.sandbox === 'workspace-write') {
    sandbox = {
      type: 'workspaceWrite', writableRoots: workspace.writable_roots || [], networkAccess: workspace.network_access || false,
      excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var || false, excludeSlashTmp: workspace.exclude_slash_tmp || false,
    }
  }
  return {
    model: params.model || previous.model || 'test-model', modelProvider: previous.modelProvider || 'openai', serviceTier,
    cwd: params.cwd || previous.cwd || process.cwd(),
    reasoningEffort: config.model_reasoning_effort || previous.reasoningEffort || 'medium',
    approvalPolicy: params.approvalPolicy || previous.approvalPolicy || 'on-request',
    approvalsReviewer: params.approvalsReviewer || previous.approvalsReviewer || 'user',
    instructionSources: previous.instructionSources || [], sandbox,
  }
}
const replyThread = (owner, id, params) => {
  const persisted = loadThread(owner.id) || owner
  if (!flag('ignore-resume-settings')) persisted.settings = settings(params, persisted.settings)
  persisted.model = persisted.settings.model
  persisted.cwd = persisted.settings.cwd
  persisted.reasoningEffort = persisted.settings.reasoningEffort
  store(persisted)
  result(id, { ...persisted.settings, thread: params.excludeTurns ? { ...persisted, turns: [] } : persisted })
}
const complete = (threadId, turnId, status = 'completed', answer = `answer-${agent}`) => {
  const owner = loadThread(threadId)
  const nativeTurn = owner.turns.find((entry) => entry.id === turnId)
  nativeTurn.status = status
  nativeTurn.completedAt = 2
  nativeTurn.items.push(agentMessage(`answer-${nativeTurn.id}`, answer))
  owner.status = { type: 'idle' }
  store(owner)
  const item = nativeTurn.items[nativeTurn.items.length - 1]
  send({ method: 'item/completed', params: { threadId, turnId, item, completedAtMs: 2 } })
  send({ method: 'item/completed', params: { threadId, turnId, item, completedAtMs: 2 } })
  send({ method: 'turn/completed', params: { threadId, turn: nativeTurn } })
}
const approval = (pending, id) => {
  while (outstanding.has(id) && outstanding.get(id) !== pending) id += 10_000
  outstanding.set(id, pending)
  send({ id, method: 'item/commandExecution/requestApproval', params: {
    threadId: pending.threadId, turnId: pending.turnId, itemId: `command-${id}`, command: 'printf harmless', cwd: process.cwd(),
    startedAtMs: 1,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  } })
}
const page = (entries, params) => {
  const offset = Number(params.cursor || 0)
  const limit = params.limit ?? entries.length
  const end = Math.min(offset + limit, entries.length)
  return { data: entries.slice(offset, end), nextCursor: end > offset && end < entries.length ? String(end) : null }
}
const expectedEnvironment = read('expected-environment.json', {})
const environmentMatches = Object.fromEntries(Object.entries(expectedEnvironment).map(([key, expected]) => [
  key, expected === null ? !Object.hasOwn(process.env, key) : process.env[key] === expected,
]))
log({ pid: process.pid, agent, environmentMatches })
process.on('exit', () => { log({ exited: process.pid }) })
process.on('SIGTERM', () => { if (!flag('ignore-term')) process.exit(0) })
const inbox = path.join(root, `inbox-${agent}.jsonl`)
let offset = fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8').length : 0
let bufferedLength = 0
setInterval(() => {
  for (let index = heldReplies.length - 1; index >= 0; index--) {
    const pending = heldReplies[index]
    if (!flag(`release-${pending.kind}`)) continue
    heldReplies.splice(index, 1)
    pending.reply()
  }
  if (!fs.existsSync(inbox)) return
  const contents = fs.readFileSync(inbox, 'utf8')
  const end = contents.lastIndexOf('\n') + 1
  const partialLength = contents.length - Math.max(offset, end)
  if (partialLength && partialLength !== bufferedLength) log({ inboxBufferedLength: partialLength })
  bufferedLength = partialLength
  if (end <= offset) return
  const batch = contents.slice(offset, end)
  offset = end
  for (const line of batch.split('\n').filter(Boolean)) {
    const message = JSON.parse(line)
    const owner = message.id !== undefined || message.method === 'turn/completed'
      ? loadThread(message.params?.threadId) : undefined
    if (message.method === 'fixture/management-call') {
      void (async () => {
        if (!owner) throw new Error('Native management session missing')
        const configured = read('mcp.json', {})
        const transport = configured.transport || {}
        if (!configured.enabled || processDisabledMcp.has(configured.name)) throw new Error('Management MCP disabled')
        const token = process.env[transport.bearer_token_env_var]
        if (!transport.url || !token) throw new Error('Native management binding missing')
        const response = await fetch(transport.url, {
          method: 'POST', headers: { authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'tools/call',
            params: { name: message.params.name, arguments: message.params.arguments } }),
        })
        const text = await response.text()
        const data = text.split('\n').find(line => line.startsWith('data: '))
        const body = JSON.parse(data ? data.slice(6) : text)
        if (!response.ok || body.error || !body.result) throw new Error('Native management request failed')
        log({ nativeManagementResult: { id: message.id, sessionId: owner.id, pid: process.pid, result: body.result } })
      })().catch(error => log({ nativeManagementResult: { id: message.id, error: error.message } }))
      continue
    }
    if (message.id !== undefined && message.method && owner && !outstanding.has(message.id)) {
      outstanding.set(message.id, { threadId: owner.id, turnId: message.params.turnId || owner.turns.at(-1)?.id,
        remaining: 0 })
    }
    if (message.method === 'turn/completed' && owner) {
      const index = owner.turns.findIndex((value) => value.id === message.params.turn.id)
      if (index >= 0) {
        owner.turns[index] = message.params.turn
        if (!owner.turns.some((value) => value.status === 'inProgress')) owner.status = { type: 'idle' }
        store(owner)
      }
    }
    send(message)
  }
}, 10)
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const message = JSON.parse(line)
  timing({ direction: 'request', id: message.id, method: message.method })
  log({ wire: message })
  const params = message.params || {}
  if (message.method === 'initialize') result(message.id, { userAgent: 'codex-cli 0.154.0', platformFamily: 'unix', platformOs: 'linux', codexHome: root })
  else if (message.method === 'initialized') { /* Initialization has no response. */ }
  else if (message.method === 'thread/start') {
    if (flag('fail-start') || flag('required-mcp-failure')) { fail(message.id); return }
    if (flag('late-reject-thread-start')) { setTimeout(() => fail(message.id), 800); return }
    const owner = thread(`thread-${agent}-${process.pid}-${++created}`, params)
    store(owner)
    if (flag('hold-thread-start')) replyOrHold('thread-start', () => replyThread(owner, message.id, params))
    else if (flag('late-thread-start')) setTimeout(() => replyThread(owner, message.id, params), 800)
    else replyThread(owner, message.id, params)
  } else if (message.method === 'thread/fork') {
    const original = read(`state-${params.threadId}.json`, null)
    if (!original) { fail(message.id); return }
    const owner = thread(`thread-${agent}-${process.pid}-${++created}`, params, original)
    store(owner)
    if (flag('hold-thread-fork-ack')) return
    if (flag('hold-thread-fork')) replyOrHold('thread-fork', () => replyThread(owner, message.id, params))
    else if (flag('late-thread-fork')) setTimeout(() => replyThread(owner, message.id, params), 800)
    else replyThread(owner, message.id, params)
  } else if (message.method === 'thread/compact/start') {
    const owner = loadThread(params.threadId)
    if (!owner) { fail(message.id); return }
    if (flag('reject-compact')) { fail(message.id); return }
    const turnNumber = owner.turns.length + 1
    const compact = turn(`compact-${turnNumber}`, 'completed')
    compact.items.push({ id: `boundary-${turnNumber}`, type: 'contextCompaction' })
    owner.turns.push(compact)
    store(owner)
    if (flag('disconnect-compact')) process.exit(0)
    result(message.id, {})
    if (!flag('drop-compact-events')) {
      send({ method: 'turn/started', params: { threadId: owner.id, turn: { ...compact, status: 'inProgress' } } })
      send({ method: 'turn/completed', params: { threadId: owner.id, turn: compact } })
    }
  } else if (message.method === 'thread/resume') {
    if (flag('fail-resume')) { fail(message.id); return }
    const owner = read(`state-${params.threadId}.json`, thread('not-the-requested-thread', params))
    const resumeDelayMs = read('resume-delay-ms.json', flag('resume-delay') ? 250 : 0)
    if (resumeDelayMs) setTimeout(() => replyThread(owner, message.id, params), resumeDelayMs)
    else replyThread(owner, message.id, params)
  } else if (message.method === 'thread/read') {
    const persisted = loadThread(params.threadId)
    if (!persisted) { fail(message.id); return }
    const reply = () => result(message.id, { thread: params.includeTurns ? persisted : { ...persisted, turns: [] } })
    replyOrHold('thread-read', () => {
      if (flag('read-delay')) setTimeout(reply, 250)
      else reply()
    })
  }
  else if (message.method === 'thread/turns/list') {
    if (flag('disconnect-turn-history')) {
      fs.unlinkSync(path.join(root, 'disconnect-turn-history'))
      process.exit(17)
    }
    const persisted = loadThread(params.threadId)
    if (!persisted) { fail(message.id); return }
    const entries = [...persisted.turns]
    if (params.sortDirection !== 'asc') entries.reverse()
    replyOrHold('turn-history', () => result(message.id, { ...page(entries, params), prevCursor: null }))
  }
  else if (message.method === 'thread/items/list') {
    const persisted = loadThread(params.threadId)
    if (!persisted) { fail(message.id); return }
    const entries = persisted.turns.filter((entry) => !params.turnId || entry.id === params.turnId)
      .flatMap((entry) => entry.items.map((item) => ({ turnId: entry.id, item })))
    if (params.sortDirection === 'desc') entries.reverse()
    result(message.id, { ...page(entries, params), backwardsCursor: null })
  }
  else if (message.method === 'turn/start') {
    const prompt = params.input[0].text
    if (flag('hold-turn-rejection')) { replyOrHold('turn-rejection', () => fail(message.id)); return }
    if (prompt === 'reject') { fail(message.id); return }
    if (prompt === 'late-reject' || flag('late-reject-turn-start')) { setTimeout(() => fail(message.id), 800); return }
    const owner = loadThread(params.threadId)
    if (!owner) { fail(message.id); return }
    const turnNumber = owner.turns.length + 1
    const nativeTurn = turn(`turn-${turnNumber}`, 'inProgress', params.clientUserMessageId, params.input)
    owner.turns.push(nativeTurn)
    owner.status = { type: 'active', activeFlags: [] }
    store(owner)
    if (prompt === 'lost-start') {
      nativeTurn.status = 'completed'; nativeTurn.completedAt = 2
      nativeTurn.items.push(agentMessage('recovered', 'recovered-answer')); store(owner)
      process.exit(17)
    }
    const started = () => {
      const persistedTurn = loadThread(owner.id).turns.find((entry) => entry.id === nativeTurn.id)
      if (!flag('hold-turn-start-ack')) result(message.id, { turn: persistedTurn })
      const inputRequest = read('workflow-input.json', null)
      if (inputRequest) {
        const id = 900 + turnNumber
        outstanding.set(id, { threadId: owner.id, turnId: nativeTurn.id, remaining: 1, inputRequest })
        if (inputRequest.method === 'mcpServer/elicitation/request') {
          const item = { type: 'mcpToolCall', id: 'form-tool', server: inputRequest.params.serverName,
            tool: 'enter_details', status: 'inProgress', arguments: {}, appContext: null, pluginId: null,
            readOnlyHint: true, result: null, error: null, durationMs: null }
          send({ method: 'item/started', params: { threadId: owner.id, turnId: nativeTurn.id, item, startedAtMs: 1 } })
        }
        send({ id, method: inputRequest.method, params: { ...inputRequest.params,
          threadId: owner.id, turnId: nativeTurn.id } })
      } else if (prompt === 'approval' || prompt === 'multi') {
        const pending = { threadId: owner.id, turnId: nativeTurn.id, remaining: prompt === 'multi' ? 2 : 1 }
        approval(pending, 900 + turnNumber)
        if (prompt === 'multi') { approval(pending, 900 + turnNumber); approval(pending, 1900 + turnNumber) }
      } else if (prompt === 'crash-completed') {
        nativeTurn.status = 'completed'; nativeTurn.completedAt = 2
        nativeTurn.items.push(agentMessage('recovered', 'recovered-answer')); store(owner)
        setTimeout(() => process.exit(17), 15)
      } else if (['wait', 'slow-start', 'late-start'].includes(prompt)) { /* The fixture intentionally leaves the turn active. */ }
      else complete(owner.id, nativeTurn.id)
    }
    if (flag('hold-turn-start')) replyOrHold('turn-start', started)
    else if (prompt === 'slow-start') setTimeout(started, 250)
    else if (prompt === 'late-start') setTimeout(started, 800)
    else started()
  } else if (message.method === 'turn/steer') {
    const owner = loadThread(params.threadId)
    const nativeTurn = owner?.turns.find((entry) => entry.id === params.expectedTurnId && entry.status === 'inProgress')
    if (!nativeTurn) { fail(message.id); return }
    const itemId = `native-user-${nativeTurn.id}-${nativeTurn.items.length + 1}`
    nativeTurn.items.push(userMessage(itemId, params.clientUserMessageId, params.input))
    store(owner)
    if (params.input[0].text !== 'lost-steer') result(message.id, { turnId: nativeTurn.id })
  } else if (message.method === 'turn/interrupt') {
    if (flag('interrupt-startup-race')) {
      fs.rmSync(path.join(root, 'interrupt-startup-race'))
      send({ id: message.id, error: { code: -32000, message: 'no active turn to interrupt' } })
      return
    }
    const owner = loadThread(params.threadId)
    if (!owner) { fail(message.id); return }
    const found = owner.turns.find((entry) => entry.id === params.turnId)
    if (found) complete(owner.id, found.id, 'interrupted', '')
    result(message.id, {})
  } else if (!message.method && message.id !== undefined) {
    const found = outstanding.get(message.id)
    if (found && message.result) {
      outstanding.delete(message.id)
      if (flag('exit-on-response')) process.exit(18)
      if (!flag('no-resolution')) send({ method: 'serverRequest/resolved', params: {
        threadId: found.threadId, requestId: message.id,
      } })
      if (found.inputRequest && !flag('no-resolution')) {
        const inputRequest = found.inputRequest
        const item = inputRequest.method === 'item/tool/requestUserInput'
          ? { type: 'functionCallOutput', id: inputRequest.params.itemId, name: 'request_user_input',
            namespace: null, output: JSON.stringify(message.result) }
          : { type: 'mcpToolCall', id: 'form-tool', server: inputRequest.params.serverName,
            tool: 'enter_details', status: 'completed', arguments: {}, appContext: null, pluginId: null,
            readOnlyHint: true, result: { content: [], structuredContent: { saved: true }, _meta: null },
            error: null, durationMs: 1 }
        const owner = loadThread(found.threadId)
        owner.turns.find(value => value.id === found.turnId).items.push(item)
        store(owner)
        send({ method: 'item/completed', params: { threadId: found.threadId, turnId: found.turnId,
          item, completedAtMs: 2 } })
      }
      if (found.remaining > 0 && --found.remaining === 0 && !flag('no-resolution')) {
        complete(found.threadId, found.turnId, 'completed', `approved-${agent}`)
      }
    }
  } else if (message.method === 'config/read') {
    const configured = read('mcp.json', { name: 'graphql', enabled: true })
    const name = configured.name || 'graphql'
    const servers = flag('no-mcp') ? {} : { [name]: { ...configured,
      enabled: processDisabledMcp.has(name) ? false : configured.enabled !== false } }
    result(message.id, { config: { approval_policy: 'on-request', mcp_servers: servers }, origins: {}, layers: [] })
  }
  else if (message.method === 'mcpServerStatus/list') {
    if (flag('reject-mcp-status')) {
      fail(message.id)
      return
    }
    const configured = read('mcp.json', { name: 'graphql', enabled: true })
    const name = configured.name || 'graphql'
    const enabled = configured.enabled !== false && !processDisabledMcp.has(name)
    const page = read('mcp-status.json', { data: flag('no-mcp') ? [] : [{
      name, runtimeStatus: enabled ? 'connected' : 'disabled', pluginId: null, serverInfo: null,
      tools: enabled ? { context_get: { name: 'context_get', inputSchema: { type: 'object' } } } : {},
      toolsError: null, resources: [], resourceTemplates: [], authStatus: 'bearerToken',
    }], nextCursor: null })
    const pages = read('mcp-status-pages.json', {})
    const reply = () => result(message.id, pages[message.params?.cursor] || page)
    const delayMs = read('mcp-status-delay-ms.json', 0)
    if (delayMs) setTimeout(reply, delayMs)
    else reply()
  }
  else if (message.method === 'model/list') {
    if (flag('models-refresh-failed')) console.error('failed to refresh available models: fixture refresh failure')
    const catalog = read('models.json', { models: [{ slug: 'test-model',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], additional_speed_tiers: ['fast'] }] })
    result(message.id, { data: catalog.models.map(model => ({
      id: model.slug, model: model.slug, displayName: model.display_name || model.slug,
      description: 'Deterministic protocol fixture', hidden: model.visibility === 'hide', isDefault: true,
      defaultReasoningEffort: 'medium', upgrade: null, upgradeInfo: null, availabilityNux: null,
      modelSpecialty: null, inputModalities: ['text'], supportsPersonality: false, multiAgentVersion: null,
      supportedReasoningEfforts: model.supported_reasoning_levels.map(level => ({
        reasoningEffort: level.effort, description: level.effort,
      })), additionalSpeedTiers: model.additional_speed_tiers || [], serviceTiers: [], defaultServiceTier: null,
    })), nextCursor: null })
  }
  else if (message.method === 'config/mcpServer/reload') result(message.id, {})
  else if (message.method === 'account/login/start') result(message.id, { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://example.invalid/device', userCode: 'TEST-CODE' })
  else if (message.method === 'account/login/cancel') result(message.id, { status: 'canceled' })
  else if (message.method === 'test/echo') result(message.id, params)
  else if (message.method === 'test/descendant') {
    const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ['ignore', 1, 2] })
    result(message.id, { pid: child.pid })
  }
  else if (message.method === 'test/frame') process.stdout.write('x'.repeat(5 * 1024 * 1024) + '\n')
  else if (message.method === 'test/request') {
    send({ id: 555, method: 'test/native', params: {} }); result(message.id, {})
  } else if (message.method === 'test/epipe') {
    process.stdin.pause()
    fs.closeSync(0)
    result(message.id, { stdinClosed: true })
  }
})
if (process.env.TEST_CODEX_TRANSPORT_READY) log({ nativeReady: process.env.TEST_CODEX_TRANSPORT_READY })
