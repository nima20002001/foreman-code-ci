import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { provisionSessionControlSubjects } from './provision-session-controls.mjs'

const [contracts, management, profiles, placements, workflows, roots, boundLocations] = await Promise.all([
  import('../../packages/contracts/dist/index.js'), import('../../packages/contracts/dist/management/index.js'),
  import('../../packages/contracts/dist/harnessRegistry.js'), import('../../packages/contracts/dist/nodePlacement.js'),
  import('../../packages/contracts/dist/wave25/index.js'),
  import('../../packages/contracts/dist/workspaceRootPolicies.js'),
  import('../../packages/contracts/dist/workspaceBoundLocation.js'),
])
const createdAt = '2026-10-06T00:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`

// Product responses are recorded; only a real profile-check run can qualify native execution.
function fixture() {
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const allowedBaseId = randomUUID()
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const allowlist = { schemaVersion: 1, hostRef: { kind: 'device', mainId, deviceId },
    applicationInstallationId: workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: allowedBaseId, canonicalPath: '/worker/projects', filesystem, accessModes: ['read-only', 'read-write'] }],
    managedRuntimeRoot: '/worker/runtime', runtimeFilesystem: filesystem }
  const identity = { installationId: mainId, checkoutId: 'b'.repeat(64), databaseId: 'c'.repeat(64) }
  const defaults = { value: structuredClone(contracts.DEFAULT_AGENT_DEFAULTS), revision: 0, versionId: null }
  const subjects = []
  for (const harness of ['codex', 'claude']) for (const kind of ['main', 'device']) {
    const configuration = harness === 'claude' ? { harness, model: 'claude-haiku-4-5-20251001',
      authMode: 'subscription', configDirectory: '/owned/recorded-profile', permissionMode: 'default',
      sandbox: 'danger-full-access', tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
      : structuredClone(contracts.DEFAULT_HARNESS_DEFAULTS[harness])
    if (harness === 'codex') configuration.reasoningEffort = 'medium'
    const hostRef = kind === 'main' ? { kind, mainId } : { kind, mainId, deviceId }
    subjects.push({ hostRef, configuration, parentPath: '/owned/projects', compactionInputs: ['Accepted context'],
      ...(kind === 'device' ? { rootSelection: { hostRef, allowedBaseId, configurationRevision: '1',
        relativePath: 'controls', accessMode: harness === 'codex' ? 'read-only' : 'read-write' } } : {}) })
  }
  const input = { subjects, expectedIdentity: identity }
  const overrides = new Map()
  const workspaces = new Map()
  const nodes = new Map()
  const locations = new Map()
  const calls = []
  let qualified = true
  let readbackChanged = false
  let connected = true
  const tool = async (name, args) => {
    calls.push({ name, args })
    if (name === 'agent_defaults_get') return structuredClone(defaults)
    if (name === 'harness_registry_get') {
      const connection = args.kind === 'device' ? { binding: { mainId, deviceId, workerInstallationId,
        bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1,
        authorizationRevision: 1 }, phase: connected ? 'ready' : 'offline', dispatch: true, transfer: true,
        appVersion: 'recorded', protocolVersion: 1, lastSeenAt: createdAt } : null
      return { hostMetadata: { hostRef: args, applicationInstallationId: args.kind === 'main' ? mainId : workerInstallationId,
        connection, platform: { platform: 'linux', architecture: 'x64' }, workspaceRoots: null }, instances: [],
        installations: ['codex', 'claude'].map(driverId => ({ hostRef: args,
          harnessInstallationId: `recorded-${driverId}`, installationFingerprint: 'recorded-fingerprint',
          driverId, driverRevision: 'recorded', protocolRevision: 'recorded', environmentGeneration: 'recorded',
          connectionGeneration: 'recorded', observedVersion: null, installed: true,
          authenticated: null, compatible: null, qualified: null,
          launcher: { requested: driverId, resolvedLauncher: `/recorded/${driverId}`, fingerprint: 'recorded-fingerprint',
            status: 'installed', interpreter: null, diagnostics: [], checkedAt: createdAt,
            environment: { generation: 'recorded', provenance: 'worker', cwd: '/owned', path: '/recorded' } } })) }
    }
    if (name === 'harness_instance_save') {
      const request = profiles.HostHarnessOverrideSaveSchema.parse(args)
      const value = { instanceId: request.instanceId, revision: 1, instanceRevision: '1', target: request.target,
        presetId: request.presetId, enabled: true, driverId: request.configuration.harness,
        configuration: request.configuration, configurationFingerprint: digest, qualification: 'unqualified' }
      overrides.set(value.instanceId, value)
      return { value: structuredClone(value), replayed: false }
    }
    if (name === 'harness_instance_check') {
      const request = profiles.HostHarnessInstanceCheckInputSchema.parse(args)
      const value = overrides.get(request.instanceId)
      assert.deepEqual(request.target, value.target)
      assert.equal(request.expectedRevision, value.revision)
      value.qualification = qualified ? 'qualified' : 'unqualified'
      return { value: structuredClone(value), replayed: false,
        proof: { target: value.target, instanceRevision: value.instanceRevision,
          configurationFingerprint: value.configurationFingerprint, driverId: value.driverId, driverRevision: 'recorded',
          protocolRevision: 'recorded', suiteRevision: 'recorded', environmentGeneration: 'recorded',
          connectionGeneration: 'recorded', authenticated: true, compatible: true, qualified, checkedAt: createdAt } }
    }
    if (name === 'harness_instances_list') {
      const values = [...overrides.values()].filter(value => JSON.stringify(value.target.hostRef) === JSON.stringify(args.hostRef))
      return { overrides: structuredClone(values).map(value => readbackChanged ? { ...value, instanceRevision: 'changed' } : value) }
    }
    if (name === 'workspace_create') {
      management.WorkspaceCreateInputSchema.parse(args)
      const value = { workspace: { id: randomUUID(), name: args.name }, revision: 0, archivedAt: null,
        executionLocation: { runnerId: 'runner-local', rootPath: `/owned/projects/${randomUUID()}` },
        locationRevision: 1, locationValidation: { status: 'ready', checkedAt: createdAt } }
      workspaces.set(value.workspace.id, value)
      return { value, replayed: false }
    }
    if (name === 'workspace_root_configuration_adopt') {
      boundLocations.WorkspaceRootConfigurationAdoptSchema.parse(args)
      assert.ok(workspaces.has(args.workspaceId))
      assert.deepEqual(args.hostRef, allowlist.hostRef)
      return { value: allowlist, replayed: false }
    }
    if (name === 'workspace_root_choices_list') return { workspaceId: args.workspaceId,
      policies: [], allowlists: [allowlist], readiness: 'metadata-only' }
    if (name === 'workspace_root_location_validate') {
      const selection = roots.WorkspaceRootSelectionSchema.parse(args)
      assert.equal(selection.expectedLocationRevision, workspaces.get(selection.workspaceId).locationRevision)
      assert.equal(selection.expectedRootPolicyRevision, 0)
      assert.equal(selection.allowedBaseId, allowedBaseId)
      return { workspaceId: selection.workspaceId, selection, checkedAt: createdAt,
        attestation: { schemaVersion: 1, attestationId: randomUUID(), requestDigest: 'a'.repeat(64),
          hostRef: selection.hostRef, applicationInstallationId: workerInstallationId,
          configurationRevision: selection.configurationRevision, allowedBaseId, relativePath: selection.relativePath,
          accessMode: selection.accessMode, canonicalProjectRoot: '/worker/projects/controls', filesystem,
          directoryIdentityHash: 'b'.repeat(64), managedRuntimeRoot: allowlist.managedRuntimeRoot,
          runtimeFilesystem: filesystem, attestationDigest: 'c'.repeat(64) } }
    }
    if (name === 'workspace_root_location_set') {
      const selection = boundLocations.WorkspaceBoundLocationSetInputSchema.parse(args)
      const workspace = workspaces.get(selection.workspaceId)
      assert.equal(workspace.locationRevision, selection.expectedLocationRevision)
      workspace.locationRevision++
      const value = { evidence: 'bound', workspaceId: selection.workspaceId,
        locationRevision: workspace.locationRevision,
        executionLocation: { runnerId: workerInstallationId, rootPath: '/worker/projects/controls' },
        binding: { schemaVersion: 1, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
          workspaceId: selection.workspaceId, hostRef: selection.hostRef, applicationInstallationId: workerInstallationId,
          registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
          locationRevision: String(workspace.locationRevision), ownerPrincipalId: 'recorded-sender', allowedBaseId,
          configurationRevision: selection.configurationRevision, relativePath: selection.relativePath,
          accessMode: selection.accessMode, canonicalProjectRoot: '/worker/projects/controls', filesystem,
          directoryIdentityHash: 'b'.repeat(64), managedRuntimeRoot: allowlist.managedRuntimeRoot,
          runtimeFilesystem: filesystem, attestationId: randomUUID(), attestationDigest: 'c'.repeat(64) } }
      locations.set(selection.workspaceId, value)
      return { value, replayed: false }
    }
    if (name === 'workspace_root_location_get') return locations.get(args.workspaceId)
    if (name === 'workflow_create') {
      workflows.CurrentWorkflowCreateInputSchema.parse(args)
      return workflows.SavedManagedWorkflowCommandResultSchema.parse({ value: { workflow: { id: randomUUID(), workspaceId: args.workspaceId, name: args.name,
        executionSemanticsVersion: 3, version: 1, entryNodeId: null, executionCondition: { kind: 'manual' },
        nodes: [], edges: [], approval: { handler: 'orchestrator' }, handoffs: { contractVersion: 1 }, createdAt },
      revision: 0, currentVersionId: null, archivedAt: null }, replayed: false })
    }
    if (name === 'workflow_edit_v3' && args.action === 'stage_edits') {
      const request = workflows.CurrentEditStageInputSchema.parse(args)
      assert.deepEqual(request.graph.approval, { handler: 'user' })
      assert.deepEqual(request.graph.executionPolicy, { maxParallelism: 1, maxNodeExecutions: 1 })
      const staged = request.stagedAgents[0].agent
      const configuration = contracts.AgentConfigurationVersionSchema.parse({ id: randomUUID(),
        workspaceId: request.workspaceId, agentId: staged.id, version: 1,
        productRole: staged.productRole, harness: staged.harnessConfiguration,
        harnessProfileSelection: staged.harnessProfileSelection, prompt: staged.prompt,
        assignedSkills: staged.assignedSkills, contentHash: digest, createdAt })
      workflows.ExecutableWorkflowV3Schema.parse({ version: { id: randomUUID(), workspaceId: request.workspaceId,
        workflowId: request.workflowId, version: 1, executionSemanticsVersion: 3,
        entryNodeId: request.graph.entryNodeId, definition: { ...request.graph, version: 1 },
        approval: request.graph.approval, agentConfigurationVersionIds: { [staged.id]: configuration.id },
        contentHash: digest, createdAt }, configurations: [configuration] })
      nodes.set(request.workflowId, { request, versionId: randomUUID(), configurationId: randomUUID(),
        intentId: randomUUID(), advanceCommandId: randomUUID(), discardCommandId: randomUUID(), saveCommandId: randomUUID() })
      return {}
    }
    if (name === 'workflow_edits_get_v3') return editResponse(nodes.get(args.workflowId))
    if (name === 'workflow_edit_v3' && args.action === 'stop_and_save') {
      const node = nodes.get(args.workflowId)
      assert.deepEqual(args, { action: 'stop_and_save', workspaceId: node.request.workspaceId,
        workflowId: node.request.workflowId, draftId: node.request.draftId,
        intentId: node.intentId, commandId: node.advanceCommandId })
      node.saved = true
      return {}
    }
    if (name === 'workflow_saved_get_v3') {
      const node = nodes.get(args.workflowId)
      assert.equal(node.saved, true)
      const version = savedVersion(node)
      return { workspaceId: args.workspaceId, workflowId: args.workflowId, revision: 1,
        currentVersionId: version.id, version }
    }
    if (name === 'agent_configuration_version_get') {
      const node = [...nodes.values()].find(value => value.configurationId === args.versionId)
      const agent = node.request.stagedAgents[0].agent
      return { version: { id: args.versionId, workspaceId: args.workspaceId, agentId: agent.id, version: 1,
        harness: agent.harnessConfiguration, harnessProfileSelection: agent.harnessProfileSelection,
        prompt: agent.prompt, assignedSkills: [], contentHash: digest, createdAt } }
    }
    throw new Error(`Unexpected product tool ${name}`)
  }
  return { input, calls, defaults, workspaces, nodes, overrides, locations,
    ports: { contracts, management, profiles, placements, workflows, roots, boundLocations, identity, tool },
    failQualification() { qualified = false }, changeReadback() { readbackChanged = true }, disconnect() { connected = false } }
}

function savedVersion(node) {
  const { request } = node
  return { id: node.versionId, workspaceId: request.workspaceId, workflowId: request.workflowId,
    version: 1, executionSemanticsVersion: 3, entryNodeId: request.graph.entryNodeId, definition: request.graph,
    agentConfigurationVersionIds: { [request.stagedAgents[0].agent.id]: node.configurationId },
    approval: request.graph.approval, contentHash: digest, createdAt }
}

function editResponse(node) {
  const { request } = node
  const { action, draftId, ...input } = request
  assert.equal(action, 'stage_edits')
  const pins = { [request.stagedAgents[0].agent.id]: node.configurationId }
  const saveInput = { ...input, commandId: node.saveCommandId, resultantAgentConfigurationVersionIds: pins }
  const intent = { id: node.intentId, kind: 'current', ownerPrincipalId: 'recorded-sender',
    workspaceId: request.workspaceId, workflowId: request.workflowId, draftId,
    stageCommandId: request.commandId, stageInputHash: digest, advanceCommandId: node.advanceCommandId,
    advanceInputHash: digest, discardCommandId: node.discardCommandId, discardInputHash: digest,
    expectedRevision: 0, savedWorkflowRevision: 0, expectedWorkflowVersionId: null,
    agentPins: [{ agentId: request.stagedAgents[0].agent.id, metadataRevision: null, configurationVersionId: null }],
    affected: [], stops: [], saveInputHash: digest, state: 'staged', saveAttempted: false, createdAt, updatedAt: createdAt,
    saveInput, stagedDraft: { id: draftId, workspaceId: request.workspaceId, workflowId: request.workflowId,
      revision: 0, baseWorkflowVersionId: null, graph: request.graph, agentConfigurationVersionIds: {},
      saveCommandId: node.saveCommandId, resultantAgentConfigurationVersionIds: pins, stagedAgents: request.stagedAgents } }
  return { intent, current: [], canStop: false, affectedSetChanged: false }
}

test('provisions four saved nodes and independently checked host profiles without starting a Run or changing defaults', async () => {
  const f = fixture()
  const original = structuredClone(f.defaults)
  const subjects = await provisionSessionControlSubjects(f.input, f.ports)
  assert.equal(subjects.length, 4)
  assert.equal(new Set(subjects.map(value => value.nativeProfile)).size, 4)
  assert.equal(new Set(subjects.map(value => value.agent.workspaceId)).size, 4)
  for (const subject of subjects) {
    const selected = subject.operatorDefaults.harnessProfileSelection
    assert.equal(subject.nativeProfile, selected.instanceId)
    assert.equal(subject.profileCheckRequest.instanceId, selected.instanceId)
    assert.equal(subject.agent.context.runId, undefined)
    const saved = f.nodes.get(subject.agent.context.workflowId)
    assert.equal(saved.saved, true)
    if (subject.hostKind === 'device') {
      assert.equal(f.locations.get(subject.agent.workspaceId).binding.accessMode,
        subject.harness === 'codex' ? 'read-only' : 'read-write')
      assert.deepEqual(saved.request.graph.nodes[0].placement.hostRef, selected.target.hostRef)
      assert.equal(saved.request.graph.nodes[0].placement.instanceId, selected.instanceId)
      assert.equal(Object.hasOwn(saved.request, 'expectedLocationRevision'), false)
      assert.equal(saved.request.graph.nodes[0].placement.locationRevision, '2')
      const related = f.calls.filter(call => call.args.workspaceId === subject.agent.workspaceId)
      assert.ok(related.findIndex(call => call.name === 'workspace_root_location_set')
        < related.findIndex(call => call.name === 'workflow_create'))
    }
  }
  assert.deepEqual(f.defaults, original)
  assert.equal(f.calls.some(call => call.name === 'run_start' || call.name.includes('chat_send')), false)
})

test('rejects changed Main identity and forbidden native models before product writes', async () => {
  const f = fixture()
  await assert.rejects(provisionSessionControlSubjects(f.input, { ...f.ports, identity: {} }), /identity changed/)
  assert.equal(f.calls.length, 0)
  f.input.subjects.find(value => value.configuration.harness === 'claude').configuration.model = 'claude-opus-5-5'
  await assert.rejects(provisionSessionControlSubjects(f.input, f.ports), /explicit Haiku/)
  assert.equal(f.calls.length, 0)
})

test('rejects unsupported Claude access before any product call', async () => {
  for (const sandbox of ['read-only', 'workspace-write']) {
    const f = fixture()
    f.input.subjects.find(value => value.configuration.harness === 'claude').configuration.sandbox = sandbox
    await assert.rejects(provisionSessionControlSubjects(f.input, f.ports), /Claude requires Full access/)
    assert.equal(f.calls.length, 0)
  }
})

test('provisions only the selected providers on Main and the paired Worker', async () => {
  for (const harnesses of [['codex'], ['claude']]) {
    const f = fixture()
    f.input.harnesses = harnesses
    f.input.subjects = f.input.subjects.filter(subject => harnesses.includes(subject.configuration.harness))
    const subjects = await provisionSessionControlSubjects(f.input, f.ports)
    assert.equal(subjects.length, harnesses.length * 2)
    assert.deepEqual(new Set(subjects.map(subject => subject.harness)), new Set(harnesses))
    assert.equal(f.calls.filter(call => call.name === 'harness_instance_check').length, harnesses.length * 2)
    assert.equal(f.calls.some(call => call.name.includes('chat_send') || call.name === 'run_start'), false)
  }
})

test('rejects duplicate selections and subjects outside the selected providers before writes', async () => {
  for (const harnesses of [['codex', 'codex', 'claude'], ['codex']]) {
    const f = fixture()
    f.input.harnesses = harnesses
    await assert.rejects(provisionSessionControlSubjects(f.input, f.ports))
    assert.equal(f.calls.length, 0)
  }
})

test('rejects failed qualification or changed persisted proof before creating any workspace', async () => {
  for (const failure of ['failQualification', 'changeReadback']) {
    const f = fixture()
    f[failure]()
    await assert.rejects(provisionSessionControlSubjects(f.input, f.ports), /did not qualify|readback differs/)
    assert.equal(f.workspaces.size, 0)
  }
})

test('reports a native profile failure before treating unknown authentication as a sign-in problem', async () => {
  const f = fixture()
  const tool = async (name, args) => {
    const result = await f.ports.tool(name, args)
    if (name !== 'harness_instance_check') return result
    return { ...result, value: { ...result.value, qualification: 'unqualified' },
      proof: { ...result.proof, authenticated: null, compatible: null, qualified: false,
        failure: { code: 'CODEX_MODEL_UNAVAILABLE', message: 'The selected model is absent from the native Codex catalog.' } } }
  }
  await assert.rejects(provisionSessionControlSubjects(f.input, { ...f.ports, tool }),
    /codex on main: CODEX_MODEL_UNAVAILABLE: The selected model is absent/)
  assert.equal(f.workspaces.size, 0)
  assert.equal(f.calls.some(call => call.name === 'workflow_create'), false)
})

test('does not save a profile for an offline Worker or accept a foreign root selection', async () => {
  const f = fixture()
  const worker = f.input.subjects.find(value => value.hostRef.kind === 'device')
  worker.rootSelection.hostRef = { ...worker.hostRef, deviceId: randomUUID() }
  await assert.rejects(provisionSessionControlSubjects(f.input, f.ports), /another host/)
  assert.equal(f.calls.length, 0)
  worker.rootSelection.hostRef = worker.hostRef
  f.input.subjects = [worker, ...f.input.subjects.filter(value => value !== worker)]
  f.disconnect()
  await assert.rejects(provisionSessionControlSubjects(f.input, f.ports), /not connected/)
  assert.equal(f.overrides.size, 0)
})
