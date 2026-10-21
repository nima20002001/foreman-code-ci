import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, NATIVE_INTERACTION_FIXTURES,
  type HarnessConfiguration } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { validateReviewerBootstrap } from '../src/modules/workflows/reviewerBootstrap.js'
import { assertOrchestratorInteractionAuthority } from '../src/modules/interactions/authorization.js'

function reviewer(): HarnessConfiguration {
  return { harness: 'codex', model: 'test-model', reasoningEffort: 'medium',
    sandbox: 'read-only', serviceTier: 'standard', advanced: {
      ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
    } }
}
function fixture() {
  const f = makeCurrentWorkflowFixture('approval-authority', 'approval')
  f.configurations[0]!.harness = reviewer()
  return f
}
// These are the shared executable validator and bootstrap used by current Save,
// not an adapter from the deleted approval module or a runtime qualification.
function validate(f: ReturnType<typeof fixture>) {
  const { version, configurations } = ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
  validateReviewerBootstrap(version.definition, version.approval, configurations[0]!.harness, version.entryNodeId)
}

describe('current workflow approval authority', () => {
  it('requires explicit reviewer relationships, not execution edges or transitive membership', () => {
    const f = fixture(), [entry, worker] = f.version.definition.nodes
    const bridge = { ...worker!, id: 'bridge', agentId: 'agent-bridge', name: 'Bridge' }
    const configuration = { ...f.configurations[1]!, id: 'cfg-bridge', agentId: bridge.agentId }
    f.configurations.push(configuration)
    f.version.agentConfigurationVersionIds[bridge.agentId] = configuration.id
    f.version.definition.nodes.push(bridge)
    f.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 3 }
    f.version.definition.edges = [
      { id: 'first', kind: 'execution', source: entry!.id, target: bridge.id },
      { id: 'second', kind: 'execution', source: bridge.id, target: worker!.id },
      { id: 'review-bridge', kind: 'approval', source: entry!.id, target: bridge.id },
    ]
    expect(() => validate(f)).toThrow('explicit reviewer relationship')
    const transitive = structuredClone(f)
    transitive.version.definition.edges.push({ id: 'transitive-review', kind: 'approval', source: bridge.id, target: worker!.id })
    expect(() => validate(transitive)).toThrow('independent or recursive reviewer startup is unsupported')
    f.version.definition.edges.push({ id: 'review-worker', kind: 'approval', source: entry!.id, target: worker!.id })
    expect(() => validate(f)).not.toThrow()
    const repeated = structuredClone(f)
    repeated.version.definition.nodes[2]!.agentId = worker!.agentId
    delete repeated.version.agentConfigurationVersionIds[bridge.agentId]
    repeated.configurations = repeated.configurations.filter((configuration) => configuration.agentId !== bridge.agentId)
    expect(() => validate(repeated)).not.toThrow()
  })

  it('keeps explicit native Codex self-review local while another Worker routes directly', () => {
    const f = fixture(), worker = f.version.definition.nodes[1]!
    const native: (typeof f.configurations)[number] = { ...f.configurations[1]!, id: 'cfg-native', agentId: 'agent-native', harness: {
      harness: 'codex' as const, model: 'test-model', sandbox: 'read-only' as const,
      reasoningEffort: 'medium' as const, serviceTier: 'standard' as const,
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalsReviewer: 'auto_review' as const, approvalPolicy: 'on-request' as const },
    } }
    f.configurations.push(native)
    f.version.agentConfigurationVersionIds[native.agentId] = native.id
    f.version.definition.nodes.push({ id: 'native-node', agentId: native.agentId, name: 'Native self-review' })
    f.version.definition.edges.push({ id: 'indirect-native', kind: 'execution', source: worker.id, target: 'native-node' })
    f.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 3 }
    expect(() => validate(f)).not.toThrow()
    if (native.harness.harness !== 'codex') throw new Error('Codex self-review fixture required')
    native.harness = { ...native.harness, advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request', approvalsReviewer: 'user' } }
    expect(() => validate(f)).toThrow('explicit reviewer relationship')
  })

  it('rejects incomplete Orchestrator selection at immutable executable validation', () => {
    const f = fixture()
    const approval = { handler: 'orchestrator' }
    expect(ExecutableWorkflowV3Schema.safeParse({ configurations: f.configurations, version: { ...f.version, approval,
      definition: { ...f.version.definition, approval } } }).success).toBe(false)
  })

  it('uses durable product roles and never permits a reviewer relationship to itself', () => {
    const f = fixture()
    expect(() => validate(f)).not.toThrow()
    f.version.definition.edges.push({ id: 'self-review', kind: 'approval', source: f.version.entryNodeId, target: f.version.entryNodeId })
    expect(() => validate(f)).toThrow('distinct existing endpoints')
  })

  it('allows a sole entry Orchestrator without inventing an App-routed requester', () => {
    // The old global two-Agent minimum was retired. Distinct requester/reviewer
    // identities remain mandatory for an actual approval relationship.
    const f = fixture(), configuration = f.configurations[0]!
    f.configurations = [configuration]
    f.version.definition.nodes = [f.version.definition.nodes[0]!]
    f.version.definition.edges = []
    f.version.agentConfigurationVersionIds = { [configuration.agentId]: configuration.id }
    expect(() => validate(f)).not.toThrow()
  })

  it('rejects display-role spoofing and wrong-workflow or Worker designation', () => {
    const f = fixture()
    expect(ExecutableWorkflowV3Schema.safeParse({ version: f.version,
      configurations: [{ ...f.configurations[0]!, productRole: 'coder', role: 'orchestrator' }, f.configurations[1]!] }).success).toBe(false)
    for (const designatedOrchestratorAgentId of [f.configurations[1]!.agentId, 'agent-other']) {
      const invalid = structuredClone(f)
      invalid.version.approval = { handler: 'orchestrator', designatedOrchestratorAgentId }
      invalid.version.definition.approval = invalid.version.approval
      expect(() => validate(invalid)).toThrow('the supported initialized reviewer must be the explicit entry coordinator')
    }
  })

  it('uses the authored entry and rejects downstream bootstrap', () => {
    const f = fixture(), reviewer = f.configurations[0]!.harness
    f.version.definition.nodes.reverse()
    expect(() => validate(f)).not.toThrow()
    expect(() => validateReviewerBootstrap({ ...f.version.definition, entryNodeId: f.version.definition.nodes[0]!.id },
      f.version.approval, reviewer, f.version.definition.nodes[0]!.id))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REVIEWER_BOOTSTRAP_ORDER' }))
    expect(() => validateReviewerBootstrap(f.version.definition, f.version.approval, reviewer, 'another-entry'))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REVIEWER_BOOTSTRAP_ORDER' }))
  })

  it('requires Codex automatic review without changing native permissions', () => {
    const f = fixture()
    const bootstrap = (configuration: HarnessConfiguration) => validateReviewerBootstrap(
      f.version.definition, f.version.approval, configuration, f.version.entryNodeId)
    const codex: HarnessConfiguration = { harness: 'codex', model: 'test-model', reasoningEffort: 'medium',
      sandbox: 'read-only', serviceTier: 'standard', advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
    expect(() => bootstrap(codex)).toThrowError(expect.objectContaining({ code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED' }))
    expect(() => bootstrap({ ...codex, advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } })).not.toThrow()
  })

  it('denies cross-workflow and self approval from worker identity', () => {
    const interaction = NATIVE_INTERACTION_FIXTURES.codex
    expect(() => assertOrchestratorInteractionAuthority(interaction, {
      agentId: 'agent-orchestrator', workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    })).not.toThrow()
    expect(() => assertOrchestratorInteractionAuthority(interaction, {
      agentId: 'agent-orchestrator', workspaceId: 'workspace-fixture', workflowId: 'workflow-other',
    })).toThrowError(expect.objectContaining({ code: 'INTERACTION_ACCESS_DENIED' }))
    expect(() => assertOrchestratorInteractionAuthority({ ...interaction, requestingAgentId: 'agent-orchestrator' }, {
      agentId: 'agent-orchestrator', workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    })).toThrowError(expect.objectContaining({ code: 'INTERACTION_ACCESS_DENIED' }))
  })
})
