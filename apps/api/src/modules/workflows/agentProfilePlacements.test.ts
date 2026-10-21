import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { reconcileAgentProfilePlacements } from './agentProfilePlacements.js'

function fixture() {
  const f = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  const configuration = f.configurations[0]!
  const hostRef = { kind: 'main' as const, mainId: randomUUID() }
  const placement: SavedNodePlacement = { schemaVersion: 1, hostRef,
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '2', projectRoot: '/project',
    cwdPolicy: 'project-subdirectory', relativeCwd: 'apps', instanceId: randomUUID(), instanceRevision: '1',
    harnessInstallationId: 'old-installation', source: { approvedSourceId: randomUUID(), snapshotId: randomUUID(),
      manifestDigest: 'a'.repeat(64) }, rootBinding: { rootId: randomUUID(), bindingRevision: 1 } }
  const selection = { instanceId: randomUUID(), instanceRevision: '2', target: {
    hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: 'selected-installation',
    installationFingerprint: 'fingerprint',
  } }
  const nodes: Extract<WorkflowDefinitionV3['nodes'][number], { agentId: string }>[] =
    f.version.definition.nodes.map(node => {
      return { ...node, agentId: configuration.agentId, placement: structuredClone(placement) }
    })
  const graph = { ...f.version.definition, nodes }
  const selectedConfiguration: AgentConfigurationVersion = { ...configuration, harnessProfileSelection: selection }
  return { graph, placement, selection, configuration: selectedConfiguration }
}

it('moves every node for the Agent to its selected profile while preserving location settings and history', () => {
  const f = fixture()
  const original = structuredClone(f.graph)
  const graph = reconcileAgentProfilePlacements(f.graph, [f.configuration])
  for (const node of graph.nodes) {
    if (node.kind === 'job') throw new Error('Expected an Agent node')
    expect(node.placement).toEqual({ ...f.placement, instanceId: f.selection.instanceId,
      instanceRevision: f.selection.instanceRevision, harnessInstallationId: f.selection.target.harnessInstallationId })
  }
  expect(f.graph).toEqual(original)
  expect(reconcileAgentProfilePlacements(graph, [f.configuration])).toEqual(graph)
})

it.each(['other-main', 'device', 'other-device'])('names the node when the profile is on %s', kind => {
  const f = fixture()
  if (kind === 'other-main') f.selection.target.hostRef.mainId = randomUUID()
  else {
    f.configuration.harnessProfileSelection = { ...f.selection, target: { ...f.selection.target,
      hostRef: { kind: 'device', mainId: f.placement.hostRef.mainId, deviceId: randomUUID() } } }
    if (kind === 'other-device') {
      f.graph.nodes[0]!.placement!.hostRef = {
        kind: 'device', mainId: f.placement.hostRef.mainId, deviceId: randomUUID(),
      }
    }
  }
  const before = structuredClone(f.graph)
  expect(() => reconcileAgentProfilePlacements(f.graph, [f.configuration])).toThrow(expect.objectContaining({
    code: 'GRAPH_INVALID', details: { issues: [expect.objectContaining({
      code: 'AGENT_PROFILE_PLACEMENT_CONFLICT', path: ['nodes', 0, 'placement'],
      message: expect.stringContaining(f.graph.nodes[0]!.id),
    })] },
  }))
  expect(f.graph).toEqual(before)
})

it('keeps unrelated Agents and implicit placements unchanged', () => {
  const f = fixture()
  const first = f.graph.nodes[0]!
  delete first.placement
  const second = f.graph.nodes[1]!
  second.agentId = 'unrelated-agent'
  expect(reconcileAgentProfilePlacements(f.graph, [f.configuration])).toEqual(f.graph)
})

it('reconciles a selected profile on the same Worker', () => {
  const f = fixture()
  const hostRef = { kind: 'device' as const, mainId: f.placement.hostRef.mainId, deviceId: randomUUID() }
  for (const node of f.graph.nodes) node.placement!.hostRef = hostRef
  f.configuration.harnessProfileSelection = { ...f.selection,
    target: { ...f.selection.target, hostRef, applicationInstallationId: randomUUID() } }
  const graph = reconcileAgentProfilePlacements(f.graph, [f.configuration])
  for (const node of graph.nodes) {
    if (node.kind === 'job') throw new Error('Expected an Agent node')
    expect(node.placement).toMatchObject({ hostRef, instanceId: f.selection.instanceId,
      instanceRevision: f.selection.instanceRevision })
  }
})

it('preserves placements when the Agent has no selected profile', () => {
  const f = fixture()
  delete f.configuration.harnessProfileSelection
  expect(reconcileAgentProfilePlacements(f.graph, [f.configuration])).toEqual(f.graph)
})
