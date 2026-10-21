import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { AcceptedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import type { NativeManagerResolutionContext } from '../src/modules/interactions/runtimePorts.js'
import { workflowProfileSelection } from '../src/modules/harnesses/workflowProfileSelection.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const savedProfileId = '22222222-2222-4222-8222-222222222222'
const placedProfileId = '33333333-3333-4333-8333-333333333333'
const savedProfile = { instanceId: savedProfileId, instanceRevision: 'saved-revision', target: {
  hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  harnessInstallationId: 'installed-sdk', installationFingerprint: 'installed-payload',
} }

function context(): NativeManagerResolutionContext {
  return { harness: 'claude', executionId: 'execution', agentId: 'agent', runId: 'run', attempt: 1,
    workingDirectory: '/project', configuration: AgentConfigurationVersionSchema.parse({
      id: 'configuration', workspaceId: 'workspace', agentId: 'agent', productRole: 'coder', version: 1,
      harness: { harness: 'claude', model: 'recorded-model', authMode: 'subscription', configDirectory: '/profile',
        permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read', 'Bash'],
        permissionRules: [], instructions: '', mcpServers: {} },
      harnessProfileSelection: savedProfile, prompt: {}, assignedSkills: [],
      contentHash: `sha256:${'0'.repeat(64)}`, createdAt: '2026-10-06T00:00:00.000Z',
    }) }
}

function placedContext(): NativeManagerResolutionContext {
  const value = context()
  value.acceptedPlacement = AcceptedNodePlacementSchema.parse({
    schemaVersion: 1, mainId, mainInstallationId: mainId, runId: value.runId, nodeId: 'node',
    hostRef: { kind: 'main', mainId }, registration: null,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: 'a'.repeat(64), rootPolicyId: 'root-policy', rootPolicyRevision: '1',
      locationRevision: '1', attestationId: 'attestation', attestationHash: 'b'.repeat(64) },
    source: { revisionId: 'source-revision', manifestDigest: 'c'.repeat(64),
      materializationId: 'materialization', materializationDigest: 'd'.repeat(64) },
    payload: { kind: 'agent', agentId: value.agentId, agentConfigurationVersionId: value.configuration.id,
      driverId: 'claude', driverRevision: '1', instanceId: placedProfileId, instanceRevision: 'placed-revision',
      harnessInstallationId: 'placed-sdk', installationFingerprint: 'placed-payload',
      runtimeContractVersion: 1, protocolRevision: 'protocol', credentialScopeRefs: [] },
    bindingHash: 'e'.repeat(64),
  })
  return value
}

it('uses the saved local Claude profile when the workflow has no execution placement', () => {
  expect(workflowProfileSelection(context())).toEqual(savedProfile)
})

it('leaves an unselected Claude workflow without invented profile authority', () => {
  const value = context()
  delete value.configuration.harnessProfileSelection
  expect(workflowProfileSelection(value)).toBeUndefined()
})

it('uses the accepted placement profile instead of the configuration selection', () => {
  expect(workflowProfileSelection(placedContext())).toEqual({
    instanceId: placedProfileId, instanceRevision: 'placed-revision', target: {
      hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'placed-sdk', installationFingerprint: 'placed-payload',
    },
  })
})

it.each(['run', 'agent', 'configuration', 'harness', 'directory'] as const)(
  'rejects a placement whose %s differs from the accepted execution', change => {
    const value = placedContext()
    if (change === 'run') value.runId = 'another-run'
    if (change === 'agent') value.agentId = 'another-agent'
    if (change === 'configuration') value.configuration.id = 'another-configuration'
    if (change === 'harness') value.harness = 'codex'
    if (change === 'directory') value.workingDirectory = '/another-project'
    expect(() => workflowProfileSelection(value)).toThrow(expect.objectContaining({ code: 'PLACEMENT_BINDING_CONFLICT' }))
  },
)

it('retains the materialized working-directory binding for a placed execution', () => {
  const value = placedContext()
  value.workingDirectory = '/materialized'
  expect(workflowProfileSelection(value, '/materialized')?.instanceId).toBe(placedProfileId)
})
