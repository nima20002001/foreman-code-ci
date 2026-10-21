import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { prepareSessionControlMatrix } from './prepare-session-controls.mjs'

const contracts = await import(new URL('../../packages/contracts/dist/index.js', import.meta.url))
const agentChat = await import(new URL('../../packages/contracts/dist/agentChat.js', import.meta.url))
const management = await import(new URL('../../packages/contracts/dist/management/index.js', import.meta.url))
const profileContracts = await import(new URL('../../packages/contracts/dist/harnessRegistry.js', import.meta.url))

// Product-response ports are recorded. These checks do not qualify native profiles or an eight-chat runtime.
function fixture() {
  const mainId = randomUUID()
  const identity = { installationId: mainId, checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) }
  const createdAt = '2026-10-05T00:00:00.000Z'
  const subjects = []
  for (const harness of ['codex', 'claude']) for (const hostKind of ['main', 'device']) {
    const nativeHost = hostKind === 'main' ? mainId : randomUUID()
    const configuration = harness === 'claude' ? { harness, model: 'claude-haiku-4-5-20251001',
      authMode: 'subscription', configDirectory: '/owned/recorded-profile', permissionMode: 'default',
      sandbox: 'danger-full-access', tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
      : structuredClone(contracts.DEFAULT_HARNESS_DEFAULTS[harness])
    const nativeProfile = randomUUID()
    const selector = profileContracts.HarnessProfileSelectionSchema.parse({ instanceId: nativeProfile,
      instanceRevision: 'recorded-revision', target: {
        hostRef: hostKind === 'main' ? { kind: 'main', mainId } : { kind: 'device', mainId, deviceId: nativeHost },
        applicationInstallationId: randomUUID(), harnessInstallationId: 'recorded-installation',
        installationFingerprint: 'recorded-fingerprint',
      } })
    subjects.push({ harness, hostKind, nativeHost, nativeProfile, model: configuration.model,
      operatorDefaults: { ...contracts.DEFAULT_AGENT_DEFAULTS.operator, harness: configuration,
        harnessProfileSelection: selector },
      agent: { workspaceId: randomUUID(), context: { workflowId: randomUUID(), workflowNodeId: randomUUID(), agentId: randomUUID() } },
      profileCheckRequest: {}, compactionInputs: ['Context-building input'], restartRecovery: [] })
  }
  const input = { expectedIdentity: identity, baseUrl: 'http://127.0.0.1:4100', sourceCommit: 'c'.repeat(40),
    mcpTokenEnv: 'WRITER_MCP_TOKEN', deniedMcpTokenEnv: 'READER_MCP_TOKEN', subjects,
    restart: { command: '/owned/fixture/restart', args: [] } }
  const original = { value: structuredClone(contracts.DEFAULT_AGENT_DEFAULTS), revision: 0, versionId: null }
  let defaults = structuredClone(original)
  const conversations = new Map()
  const agents = new Map()
  const calls = []
  let failRead = false
  let conflictRestore = false
  const tool = async (name, args) => {
    calls.push({ name, args })
    if (name === 'agent_defaults_get') return structuredClone(defaults)
    if (name === 'agent_defaults_update') {
      assert.equal(args.expectedRevision, defaults.revision)
      if (conflictRestore && args.value.operator.harnessProfileSelection === undefined) throw new Error('Defaults revision conflict')
      defaults = { value: structuredClone(args.value), revision: defaults.revision + 1, versionId: randomUUID() }
      return { value: structuredClone(defaults), replayed: false }
    }
    if (name === 'operator_chat_create') {
      contracts.CreateOperatorConversationRequestSchema.required({ commandId: true }).parse(args)
      const conversation = { id: randomUUID(), agentId: 'application-operator', scope: 'application',
        operatorConfigurationVersionId: defaults.versionId, title: args.title, status: 'open', createdAt, updatedAt: createdAt }
      conversations.set(conversation.id, { conversation, messages: [], turnState: 'idle',
        settings: contracts.operatorChatSettings(defaults.value.operator.harness) })
      return { conversation }
    }
    if (name === 'operator_chat_get') return conversations.get(args.conversationId)
    if (name === 'agent_chat_controls_update') {
      const subject = subjects.find(value => value.agent.workspaceId === args.workspaceId)
      let value = agents.get(args.workspaceId)
      if (!value) {
        const conversation = { id: randomUUID(), ...subject.agent.context, workspaceId: args.workspaceId,
          agentConfigurationVersionId: randomUUID(), harness: subject.harness,
          origin: { kind: 'fresh' }, nativeSession: null, createdAt, updatedAt: createdAt }
        value = { conversation, revision: 0 }
        agents.set(args.workspaceId, value)
      }
      assert.equal(args.request.expectedRevision, value.revision)
      value.revision++
      return contracts.SessionControlStateSchema.parse({ conversationId: value.conversation.id,
        revision: value.revision, profileKey: 'recorded', desiredMode: args.request.mode, appliedMode: null,
        defaults: contracts.SessionPreferencesSchema.parse({}), desired: contracts.SessionPreferencesSchema.parse({}), applied: null,
        applicability: 'next-turn', capabilities: contracts.unavailableSessionControls('recorded'), context: null,
        nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [], busyReason: null })
    }
    if (name === 'agent_configuration_version_get') {
      const subject = subjects.find(value => value.agent.workspaceId === args.workspaceId)
      return { version: contracts.AgentConfigurationVersionSchema.parse({ id: args.versionId,
        workspaceId: args.workspaceId, agentId: args.agentId, version: 1, harness: subject.operatorDefaults.harness,
        harnessProfileSelection: subject.operatorDefaults.harnessProfileSelection, prompt: {}, assignedSkills: [],
        contentHash: `sha256:${'d'.repeat(64)}`, createdAt }) }
    }
    throw new Error(`Unexpected product tool ${name}`)
  }
  const read = async path => {
    if (failRead) throw new Error('Product node read unavailable')
    const subject = subjects.find(value => path.includes(value.agent.workspaceId))
    const value = agents.get(subject.agent.workspaceId)
    return { context: { workspaceId: subject.agent.workspaceId, ...subject.agent.context },
      conversation: value?.conversation ?? null, sessionState: value ? 'idle' : 'none',
      availability: { canSend: true }, capabilities: { harness: subject.harness, providerVersion: null,
        steer: 'unavailable', interruptAndSend: false, queueNextTurn: false, resume: false,
        unavailable: {} }, activeTurn: null,
      turns: [], messages: [], hasEarlierMessages: false, activities: [], revision: value?.revision ?? 0 }
  }
  return { input, calls, original, defaults: () => defaults,
    ports: { contracts, agentChat, management, identity, tool, read },
    fail() { failRead = true }, conflict() { conflictRestore = true } }
}

test('creates eight distinct empty chats through the product tools and restores fixture defaults', async () => {
  const f = fixture()
  const matrix = await prepareSessionControlMatrix(f.input, f.ports)
  assert.equal(matrix.rows.length, 8)
  assert.equal(new Set(matrix.rows.map(row => row.conversationId)).size, 8)
  assert.ok(matrix.rows.every(row => !Object.hasOwn(row, 'httpTokenEnv')))
  assert.ok(matrix.rows.every(row => row.mcpTokenEnv === f.input.mcpTokenEnv))
  const futureIds = matrix.rows.filter(row => row.role === 'operator').map(row => row.futureDefaultsConversationId)
  assert.equal(new Set(futureIds).size, 4)
  assert.ok(futureIds.every(id => !matrix.rows.some(row => row.conversationId === id)))
  const creates = f.calls.filter(call => call.name === 'operator_chat_create')
  assert.equal(creates.length, 8)
  assert.equal(new Set(creates.map(call => call.args.commandId)).size, 8)
  assert.equal(f.calls.filter(call => call.name === 'operator_chat_get').length, 4)
  assert.equal(matrix.mcpTokenEnv, f.input.mcpTokenEnv)
  assert.deepEqual(matrix.expectedIdentity, f.input.expectedIdentity)
  assert.equal(f.calls.filter(call => call.name === 'agent_chat_controls_update').length, 8)
  assert.equal(f.calls.some(call => call.name.endsWith('_send') || call.name === 'run_start'), false)
  assert.deepEqual(f.defaults().value, f.original.value)
})

test('refuses a changed fixture identity before any product write', async () => {
  const f = fixture()
  await assert.rejects(prepareSessionControlMatrix(f.input, { ...f.ports, identity: {} }), /identity changed/)
  assert.equal(f.calls.length, 0)
})

test('prepares four Codex chats or four Claude chats without selecting another provider', async () => {
  for (const harnesses of [['codex'], ['claude']]) {
    const f = fixture()
    f.input.harnesses = harnesses
    f.input.subjects = f.input.subjects.filter(subject => harnesses.includes(subject.harness))
    const matrix = await prepareSessionControlMatrix(f.input, f.ports)
    assert.equal(matrix.rows.length, harnesses.length * 4)
    assert.deepEqual(matrix.harnesses, harnesses)
    assert.deepEqual(new Set(matrix.rows.map(row => row.harness)), new Set(harnesses))
    assert.equal(new Set(matrix.rows.map(row => row.conversationId)).size, harnesses.length * 4)
    assert.deepEqual(f.defaults().value, f.original.value)
  }
})

test('refuses non-Haiku fixture defaults before any write or native qualification', async () => {
  const f = fixture()
  const claude = f.input.subjects.find(subject => subject.harness === 'claude').operatorDefaults.harness
  f.defaults().value.operator.harness = { ...claude, model: 'claude-opus-5-5' }
  await assert.rejects(prepareSessionControlMatrix(f.input, f.ports), /explicit Haiku Operator defaults/)
  assert.deepEqual(f.calls.map(call => call.name), ['agent_defaults_get'])
})

test('restores defaults after failed preparation and preserves a concurrent revision conflict', async () => {
  const f = fixture()
  f.fail()
  await assert.rejects(prepareSessionControlMatrix(f.input, f.ports), /node read unavailable/)
  assert.deepEqual(f.defaults().value, f.original.value)
  const conflicted = fixture()
  conflicted.fail()
  conflicted.conflict()
  await assert.rejects(prepareSessionControlMatrix(conflicted.input, conflicted.ports), AggregateError)
  assert.notDeepEqual(conflicted.defaults().value, conflicted.original.value)
})
