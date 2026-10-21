import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSessionControlMatrix } from './prepare-session-controls.mjs'
import { sessionControlProduct } from './session-control-product.mjs'
import { assertSessionControlDefaults } from './session-control-client.mjs'
import { sessionControlHarnesses } from './session-control-harnesses.mjs'

function validateSubjects(input, contracts, profiles, roots, identity) {
  assert.deepEqual(identity, input.expectedIdentity, 'The reviewed fixture app identity changed.')
  const harnesses = sessionControlHarnesses(input, contracts)
  assert.equal(input.subjects.length, harnesses.length * 2, 'Provide each selected harness on Main and Worker.')
  const keys = new Set()
  const subjects = input.subjects.map(subject => {
    const configuration = contracts.SupportedHarnessConfigurationSchema.parse(subject.configuration)
    assert.ok(harnesses.includes(configuration.harness), 'The subject uses an unselected harness.')
    const hostRef = profiles.HarnessHostReferenceSchema.parse(subject.hostRef)
    assert.equal(hostRef.mainId, identity.installationId, 'The installation belongs to another Main.')
    if (configuration.harness === 'claude') {
      assert.ok(['haiku', 'claude-haiku-4-5-20251001'].includes(configuration.model), 'Use explicit Haiku.')
    }
    if (configuration.harness === 'codex') assert.equal(configuration.reasoningEffort, 'medium')
    assert.ok(subject.parentPath, 'Provide the disposable fixture workspace parent.')
    if (hostRef.kind === 'device') {
      assert.ok(subject.rootSelection, 'Select the Worker’s approved base and relative directory explicitly.')
    }
    const rootSelection = subject.rootSelection && roots.WorkspaceRootSelectionSchema.omit({
      workspaceId: true, expectedLocationRevision: true, expectedRootPolicyRevision: true,
    }).parse(subject.rootSelection)
    if (rootSelection) assert.deepEqual(rootSelection.hostRef, hostRef, 'The selected root belongs to another host.')
    keys.add(`${configuration.harness}:${hostRef.kind}`)
    return { ...subject, configuration, hostRef, rootSelection }
  })
  assert.equal(keys.size, harnesses.length * 2, 'Installation selections must cover each selected harness/host pair.')
  const devices = new Set(subjects.filter(subject => subject.hostRef.kind === 'device').map(subject => subject.hostRef.deviceId))
  assert.equal(devices.size, 1, 'Use one exact paired Worker for the selected harnesses.')
  return subjects
}

async function qualifyProfile(subject, { profiles, tool }) {
  const inventory = profiles.HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', subject.hostRef))
  assert.deepEqual(inventory.hostMetadata?.hostRef, subject.hostRef)
  if (subject.hostRef.kind === 'device') {
    assert.equal(inventory.hostMetadata.connection?.phase, 'ready', 'The selected Worker is not connected.')
  }
  const installation = inventory.installations.find(value => value.driverId === subject.configuration.harness)
  assert.ok(installation?.installed && installation.installationFingerprint, 'The selected native installation is unavailable.')
  assert.deepEqual(installation.hostRef, subject.hostRef, 'The installation readback belongs to another host.')
  const target = profiles.HostHarnessOverrideTargetSchema.parse({ hostRef: subject.hostRef,
    applicationInstallationId: inventory.hostMetadata.applicationInstallationId,
    harnessInstallationId: installation.harnessInstallationId,
    installationFingerprint: installation.installationFingerprint })
  const saved = profiles.HostHarnessOverrideSaveResultSchema.parse(await tool('harness_instance_save', {
    commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target,
    presetId: `local-default:${subject.configuration.harness}`, enabled: true, configuration: subject.configuration,
  })).value
  const profileCheckRequest = { instanceId: saved.instanceId, expectedRevision: saved.revision, target }
  const checked = profiles.HostHarnessInstanceCheckResultSchema.parse(await tool('harness_instance_check', {
    ...profileCheckRequest, commandId: randomUUID(),
  }))
  assert.deepEqual(checked.value.target, target)
  assert.equal(checked.value.instanceId, saved.instanceId)
  assert.deepEqual(checked.value.configuration, saved.configuration)
  assert.equal(checked.proof.instanceRevision, checked.value.instanceRevision)
  assert.deepEqual(checked.proof.target, target)
  assert.equal(checked.proof.configurationFingerprint, checked.value.configurationFingerprint)
  const profileLocation = `${checked.value.driverId} on ${subject.hostRef.kind}`
  if (checked.proof.failure) {
    const { code, message } = checked.proof.failure
    throw new Error(`Native profile check failed for ${profileLocation}: ${code}: ${message}`)
  }
  assert.equal(checked.proof.authenticated, true, `The native profile is not authenticated: ${profileLocation}.`)
  assert.equal(checked.proof.compatible, true, `The native profile is not compatible: ${profileLocation}.`)
  assert.equal(checked.proof.qualified, true, `The native profile did not qualify: ${profileLocation}.`)
  const readback = profiles.HostHarnessOverrideListSchema.parse(await tool('harness_instances_list', {
    hostRef: subject.hostRef, applicationInstallationId: target.applicationInstallationId,
  })).overrides.find(value => value.instanceId === saved.instanceId)
  assert.deepEqual(readback, checked.value, 'Persisted profile readback differs from qualification.')
  return { profile: checked.value, profileCheckRequest }
}

async function bindWorkerLocation(subject, workspace, profile, { roots, boundLocations, placements, tool }) {
  const workspaceId = workspace.workspace.id
  const adopted = boundLocations.WorkspaceRootConfigurationAdoptResultSchema.parse(await tool(
    'workspace_root_configuration_adopt', { workspaceId, hostRef: subject.hostRef, commandId: randomUUID() })).value
  assert.equal(adopted.applicationInstallationId, profile.target.applicationInstallationId)
  assert.deepEqual(adopted.hostRef, subject.hostRef)
  assert.equal(adopted.configurationRevision, subject.rootSelection.configurationRevision)
  const choices = roots.WorkspaceRootListResultSchema.parse(await tool('workspace_root_choices_list', { workspaceId }))
  assert.ok(choices.allowlists.some(value => value.applicationInstallationId === adopted.applicationInstallationId
    && value.configurationRevision === adopted.configurationRevision && value.bases.some(base =>
      base.baseId === subject.rootSelection.allowedBaseId && base.accessModes.includes(subject.rootSelection.accessMode))))
  const previous = choices.policies.find(value => isDeepStrictEqual(value.hostRef, subject.hostRef))
  const selection = roots.WorkspaceRootSelectionSchema.parse({ ...subject.rootSelection, workspaceId,
    expectedLocationRevision: workspace.locationRevision, expectedRootPolicyRevision: Number(previous?.rootPolicyRevision ?? 0) })
  const validated = boundLocations.WorkspaceBoundLocationValidationSchema.parse(await tool(
    'workspace_root_location_validate', selection))
  assert.deepEqual(validated.selection, selection)
  const bound = boundLocations.WorkspaceBoundLocationSetResultSchema.parse(await tool(
    'workspace_root_location_set', { ...selection, commandId: randomUUID() })).value
  assert.equal(bound.evidence, 'bound', 'The Worker workspace location did not acquire its root binding.')
  const persisted = boundLocations.WorkspaceBoundLocationReadbackSchema.parse(await tool(
    'workspace_root_location_get', { workspaceId }))
  assert.deepEqual(persisted, bound, 'The Worker root binding differs from persisted readback.')
  assert.equal(bound.binding.workspaceId, workspaceId)
  assert.deepEqual(bound.binding.hostRef, subject.hostRef)
  assert.equal(bound.binding.allowedBaseId, selection.allowedBaseId)
  assert.equal(bound.binding.accessMode, selection.accessMode)
  const placement = placements.SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: bound.binding.hostRef,
    rootPolicyId: bound.binding.rootPolicyId, rootPolicyRevision: bound.binding.rootPolicyRevision,
    locationRevision: bound.binding.locationRevision, projectRoot: bound.binding.canonicalProjectRoot,
    cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
    instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId })
  return { placement, locationRevision: bound.locationRevision }
}

async function saveNode(subject, profile, ports) {
  const { contracts, management, workflows, tool } = ports
  const name = `Session controls ${profile.driverId} ${subject.hostRef.kind}`
  const workspace = management.ManagedWorkspaceCommandResultSchema.parse(await tool('workspace_create', {
    commandId: randomUUID(), name, parentPath: subject.parentPath,
    description: 'Disposable native session controls acceptance.',
  })).value
  assert.equal(workspace.locationValidation.status, 'ready', 'The fixture workspace folder is unavailable.')
  const workspaceId = workspace.workspace.id
  const location = subject.hostRef.kind === 'device' ? await bindWorkerLocation(subject, workspace, profile, ports)
    : { locationRevision: workspace.locationRevision }
  const created = workflows.SavedManagedWorkflowCommandResultSchema.parse(await tool('workflow_create', {
    commandId: randomUUID(), workspaceId, name, executionSemanticsVersion: 3,
  })).value
  assert.equal(created.currentVersionId, null, 'The fixture workflow is not fresh.')
  const agentId = randomUUID()
  const workflowNodeId = randomUUID()
  const selector = { instanceId: profile.instanceId, instanceRevision: profile.instanceRevision, target: profile.target }
  const agent = contracts.AgentSchema.parse({ id: agentId, name, productRole: 'coder',
    harness: profile.driverId, model: profile.configuration.model, harnessConfiguration: profile.configuration,
    harnessProfileSelection: selector, prompt: { system: 'Follow the chat request. Preserve the accepted sandbox and tool policy.' },
    assignedSkills: [] })
  const graph = { ...created.workflow, entryNodeId: workflowNodeId, requiredAgentCount: 1, edges: [],
    approval: { handler: 'user' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
    nodes: [{ id: workflowNodeId, agentId, name, position: { x: 0, y: 0 }, initialPrompt: 'Follow the current chat request.',
      ...(location.placement ? { placement: location.placement } : {}) }] }
  const draftId = randomUUID()
  await tool('workflow_edit_v3', workflows.CurrentEditStageInputSchema.parse({ action: 'stage_edits',
    commandId: randomUUID(), draftId, workspaceId, workflowId: graph.id, executionSemanticsVersion: 3,
    expectedRevision: created.revision, expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: {}, graph,
    stagedAgents: [{ agent, baseRevision: null }] }))
  const staged = workflows.CurrentEditReadResultSchema.parse(await tool('workflow_edits_get_v3', {
    action: 'read_edits', workspaceId, workflowId: graph.id, draftId,
  })).intent
  assert.ok(staged && staged.state === 'staged' && staged.affected.length === 0, 'The fresh fixture has unsettled work.')
  await tool('workflow_edit_v3', { action: 'stop_and_save', workspaceId, workflowId: graph.id,
    draftId, intentId: staged.id, commandId: staged.advanceCommandId })
  const saved = workflows.CurrentWorkflowReadResultSchema.parse(await tool('workflow_saved_get_v3', {
    workspaceId, workflowId: graph.id,
  })).version
  assert.deepEqual(saved.definition.nodes.map(node => [node.id, node.agentId]), [[workflowNodeId, agentId]])
  const version = management.AgentVersionResultSchema.parse(await tool('agent_configuration_version_get', {
    workspaceId, agentId, versionId: saved.agentConfigurationVersionIds[agentId],
  })).version
  assert.deepEqual(version.harness, profile.configuration)
  assert.deepEqual(version.harnessProfileSelection, selector)
  return { workspaceId, context: { workflowId: graph.id, workflowNodeId, agentId } }
}

/** Public provisioning keeps saved node, profile and location ownership separate from native execution. */
export async function provisionSessionControlSubjects(input, ports) {
  const subjects = validateSubjects(input, ports.contracts, ports.profiles, ports.roots, ports.identity)
  const defaults = ports.management.ManagedAgentDefaultsSchema.parse(await ports.tool('agent_defaults_get', {}))
  assertSessionControlDefaults(defaults)
  const prepared = []
  for (const subject of subjects) {
    const { profile, profileCheckRequest } = await qualifyProfile(subject, ports)
    const agent = await saveNode(subject, profile, ports)
    const details = { ...subject }
    for (const field of ['configuration', 'hostRef', 'parentPath', 'rootSelection']) delete details[field]
    prepared.push({ ...details, harness: profile.driverId, hostKind: subject.hostRef.kind,
      nativeHost: subject.hostRef.deviceId ?? subject.hostRef.mainId, nativeProfile: profile.instanceId,
      model: profile.configuration.model, profileCheckRequest, agent,
      operatorDefaults: { ...defaults.value.operator, harness: profile.configuration,
        harnessProfileSelection: { instanceId: profile.instanceId, instanceRevision: profile.instanceRevision, target: profile.target } } })
  }
  return prepared
}

/** Public product provisioning, followed by fresh chat admissions; no Run is allocated. */
export async function provisionSessionControlMatrix(input, ports) {
  const subjects = await provisionSessionControlSubjects(input, ports)
  return prepareSessionControlMatrix({ ...input, subjects }, ports)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2] && process.argv[3], 'Usage: provision-session-controls.mjs <fixture-installations.json> <new-matrix.json>')
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  assert.equal(input.sourceCommit, (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim())
  const product = await sessionControlProduct(input)
  try {
    const matrix = await provisionSessionControlMatrix(input, product)
    await writeFile(process.argv[3], JSON.stringify(matrix, null, 2), { flag: 'wx', mode: 0o600 })
  } finally { await product.close() }
}
