import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { sessionControlProduct } from './session-control-product.mjs'
import { assertSessionControlDefaults } from './session-control-client.mjs'
import { sessionControlHarnesses } from './session-control-harnesses.mjs'

/** Creates chats on already provisioned, selected nodes and profiles through the public product services. */
export async function prepareSessionControlMatrix(input, { contracts, agentChat, management, identity, tool, read }) {
  assert.deepEqual(identity, input.expectedIdentity, 'The reviewed fixture app identity changed.')
  const harnesses = sessionControlHarnesses(input, contracts)
  assert.equal(input.subjects.length, harnesses.length * 2, 'Provide each selected harness on Main and Worker.')
  const keys = new Set(input.subjects.map(subject => `${subject.harness}:${subject.hostKind}`))
  for (const harness of harnesses) for (const host of ['main', 'device']) {
    assert.ok(keys.has(`${harness}:${host}`), `Missing provisioned ${harness}:${host} subject.`)
  }
  for (const subject of input.subjects) {
    assert.ok(harnesses.includes(subject.harness), 'The subject uses an unselected harness.')
    const operator = contracts.AgentDefaultsSchema.shape.operator.parse(subject.operatorDefaults)
    assert.equal(operator.harness.harness, subject.harness)
    assert.equal(operator.harness.model, subject.model)
    assert.equal(operator.harnessProfileSelection?.instanceId, subject.nativeProfile)
    assert.equal(operator.harnessProfileSelection?.target.hostRef.kind, subject.hostKind)
    const host = operator.harnessProfileSelection.target.hostRef
    assert.equal(subject.nativeHost, host.kind === 'device' ? host.deviceId : host.mainId)
    if (subject.harness === 'claude') assert.ok(['haiku', 'claude-haiku-4-5-20251001'].includes(subject.model))
    if (subject.harness === 'codex') assert.equal(operator.harness.reasoningEffort, 'medium')
    agentChat.AgentChatQuerySchema.parse(subject.agent.context)
    assert.equal(subject.agent.context.runId, undefined, 'Provision current nodes without a synthetic Run.')
  }
  const original = management.ManagedAgentDefaultsSchema.parse(await tool('agent_defaults_get', {}))
  assertSessionControlDefaults(original)
  let current = original
  let changed = false
  let failure
  const rows = []
  try {
    for (const subject of input.subjects) {
      const value = { ...original.value, operator: subject.operatorDefaults }
      const update = management.AgentDefaultsUpdateInputSchema.parse({ commandId: randomUUID(),
        expectedRevision: current.revision, value })
      current = management.AgentDefaultsUpdateResultSchema.parse(await tool('agent_defaults_update', update)).value
      changed = true
      assert.deepEqual(current.value, value)
      const created = contracts.CreateOperatorConversationResponseSchema.parse(await tool('operator_chat_create', {
        commandId: randomUUID(),
        title: `Session controls · ${subject.harness} · ${subject.hostKind}`,
      })).conversation
      const future = contracts.CreateOperatorConversationResponseSchema.parse(await tool('operator_chat_create', {
        commandId: randomUUID(),
        title: `Future controls · ${subject.harness} · ${subject.hostKind}`,
      })).conversation
      assert.equal(future.operatorConfigurationVersionId, created.operatorConfigurationVersionId,
        'The future chat must inherit the same profile and settings scope.')
      const operator = contracts.OperatorConversationStateSchema.parse(await tool('operator_chat_get', {
        conversationId: created.id,
      }))
      assert.deepEqual(operator.messages, [], 'The prepared Operator chat already contains messages.')
      assert.equal(operator.settings?.harness, subject.harness)
      assert.equal(operator.settings?.model, subject.model)
      const query = agentChat.AgentChatQuerySchema.parse(subject.agent.context)
      const params = new URLSearchParams(query)
      const path = `/api/workspaces/${encodeURIComponent(subject.agent.workspaceId)}/agent-chat?${params}`
      const before = agentChat.AgentChatStateSchema.parse(await read(path))
      assert.equal(before.conversation, null, 'Use a fresh saved node for each matrix subject.')
      const target = { workspaceId: subject.agent.workspaceId, context: query }
      const controls = contracts.SessionControlStateSchema.parse(await tool('agent_chat_controls_update', {
        ...target, request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: 0 },
      }))
      assert.ok(controls.conversationId, 'Fresh node controls did not create their conversation.')
      await tool('agent_chat_controls_update', { workspaceId: subject.agent.workspaceId,
        conversationId: controls.conversationId,
        request: { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: controls.revision } })
      const agent = agentChat.AgentChatStateSchema.parse(await read(path))
      assert.equal(agent.conversation?.id, controls.conversationId)
      assert.deepEqual(agent.messages, [], 'Preparing node controls submitted a model message.')
      const saved = management.AgentVersionResultSchema.parse(await tool('agent_configuration_version_get', {
        workspaceId: subject.agent.workspaceId, agentId: query.agentId,
        versionId: agent.conversation.agentConfigurationVersionId }))
      assert.equal(saved.version.harness.harness, subject.harness)
      assert.equal(saved.version.harness.model, subject.model)
      assert.equal(saved.version.harnessProfileSelection?.instanceId, subject.nativeProfile)
      assert.equal(saved.version.harnessProfileSelection?.target.hostRef.kind, subject.hostKind)
      assert.deepEqual(saved.version.harnessProfileSelection, subject.operatorDefaults.harnessProfileSelection)
      const { agent: selectedNode, ...details } = subject
      delete details.operatorDefaults
      const common = { ...details, mcpTokenEnv: input.mcpTokenEnv,
        deniedMcpTokenEnv: input.deniedMcpTokenEnv }
      rows.push({ ...common, role: 'operator', conversationId: created.id,
        futureDefaultsConversationId: future.id,
        sendPath: `/api/operator/conversations/${encodeURIComponent(created.id)}/messages`,
        sendRequest: { configurationVersionId: created.operatorConfigurationVersionId } })
      rows.push({ ...common, role: 'agent', workspaceId: selectedNode.workspaceId,
        conversationId: agent.conversation.id, readPath: path,
        sendPath: `/api/workspaces/${encodeURIComponent(selectedNode.workspaceId)}/agent-chat/messages`,
        sendRequest: { context: query, expectedConversationId: agent.conversation.id } })
    }
  } catch (error) { failure = error }
  if (changed) {
    try {
      const restored = management.AgentDefaultsUpdateResultSchema.parse(await tool('agent_defaults_update', {
        commandId: randomUUID(), expectedRevision: current.revision, value: original.value,
      })).value
      assert.deepEqual(restored.value, original.value, 'The fixture defaults were not restored.')
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], 'Matrix preparation and defaults restoration failed.', { cause: error })
      throw error
    }
  }
  if (failure) throw failure
  assert.equal(new Set(rows.map(row => row.conversationId)).size, harnesses.length * 4)
  return { baseUrl: input.baseUrl, sourceCommit: input.sourceCommit, restart: input.restart,
    harnesses,
    mcpTokenEnv: input.mcpTokenEnv, expectedIdentity: input.expectedIdentity,
    ...(input.browserOrigin ? { browserOrigin: input.browserOrigin } : {}), rows }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: prepare-session-controls.mjs <provisioned-subjects.json> <new-matrix.json>')
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  assert.equal(input.sourceCommit, (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim())
  const product = await sessionControlProduct(input)
  try {
    const matrix = await prepareSessionControlMatrix(input, product)
    await writeFile(process.argv[3], JSON.stringify(matrix, null, 2), { flag: 'wx', mode: 0o600 })
  } finally { await product.close() }
}
