import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { makeCurrentWorkflowFixture, type CurrentFixtureForm } from './currentFixture.js'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowReadResultSchema } from './currentAuthoring.js'
import { CurrentWorkflowReadInputSchema } from './currentAuthoring.js'
import { WorkflowVersionV3Schema, SavedRunVersionSnapshotSchema } from './saved.js'
import { ExecutableWorkflowV3Schema, AcceptedWorkflowRunV3Schema, RunStartV3InputSchema } from './repeatAdmission.js'
import { RepeatWorkflowVersionV1Schema, RepeatRunVersionV1Schema } from './repeat.js'
import { EXECUTION_SEMANTICS_VERSION, ExecutionSemanticsVersionSchema } from './workflow.js'
import { RUN_GRAPH_PROTOCOL_VERSION, GraphExecutionIdentitySchema } from './graphPrimitives.js'

// Real public/current schemas, deterministic data only. No storage/native qualification.
describe('ENG04 A1: one directly validated current contract', () => {
  for (const form of ['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat'] as CurrentFixtureForm[]) {
    it(`S3 ${form}: shares save/read/Start pins and preserves canonical repeat absence`, () => {
      const f = makeCurrentWorkflowFixture(`a1-${form}`, form)
      assert.equal(WorkflowVersionV3Schema, RepeatWorkflowVersionV1Schema)
      assert.equal(EXECUTION_SEMANTICS_VERSION, 3)
      const executable = ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
      const save = CurrentWorkflowSaveInputSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
        executionSemanticsVersion: 3, expectedRevision: 1, expectedWorkflowVersionId: f.version.id,
        expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
        commandId: `save-${form}`, graph: executable.version.definition })
      const read = CurrentWorkflowReadResultSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
        revision: 2, currentVersionId: f.version.id, version: f.version })
      CurrentWorkflowReadInputSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, workflowVersionId: f.version.id })
      RunStartV3InputSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, workflowVersionId: f.version.id,
        executionSemanticsVersion: 3, expectedWorkflowRevision: 2, expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
        expectedLocationRevision: 1, commandId: `start-${form}`, input: {} })
      SavedRunVersionSnapshotSchema.parse({ run: f.run, version: read.version })
      assert.equal(Object.hasOwn(save.graph, 'repeat'), form === 'repeat')
      assert.equal(Object.hasOwn(read.version.definition, 'repeat'), form === 'repeat')
      assert.equal(Object.hasOwn(f.run, 'repeat'), false)
      assert.equal(read.version.executionSemanticsVersion, 3)
    })
  }
  it('S3-02: unequal all-required join validates as ordinary V3', () => {
    const f = makeCurrentWorkflowFixture('a1-unequal', 'parallel')
    const configuration = { ...f.configurations[2]!, id: 'cfg-a1-unequal-extra', agentId: 'agent-a1-unequal-extra' }
    f.configurations.push(configuration)
    const version = structuredClone(f.version), extra = { id: 'node-a1-unequal-extra', agentId: configuration.agentId, name: 'Long branch' }
    version.definition.nodes.push(extra)
    const edge = version.definition.edges.find((item) => item.source === version.definition.nodes[2]!.id && item.target === version.definition.nodes[3]!.id)!
    edge.target = extra.id
    version.definition.edges.push({ id: 'edge-a1-unequal-extra', kind: 'execution', source: extra.id, target: version.definition.nodes[3]!.id })
    version.agentConfigurationVersionIds[configuration.agentId] = configuration.id
    version.definition.executionPolicy!.maxNodeExecutions++
    assert.equal(ExecutableWorkflowV3Schema.safeParse({ version, configurations: f.configurations }).success, true)
    assert.equal(Object.hasOwn(WorkflowVersionV3Schema.parse(version).definition, 'repeat'), false)
  })
  it('add/remove repeat makes saved revision changes, never semantics changes or empty plans', () => {
    const f = makeCurrentWorkflowFixture('a1-add-remove', 'repeat')
    const ordinary = structuredClone(f.version)
    delete ordinary.definition.repeat
    ordinary.version = ordinary.definition.version = 2
    ordinary.id += '-revision2'
    assert.equal(WorkflowVersionV3Schema.parse(ordinary).executionSemanticsVersion, 3)
    const again = structuredClone(ordinary)
    again.definition.repeat = structuredClone(f.version.definition.repeat)
    again.version = again.definition.version = 3; again.id += '-revision3'
    assert.equal(ExecutableWorkflowV3Schema.safeParse({ version: again, configurations: f.configurations }).success, true)
    assert.equal(Object.hasOwn(WorkflowVersionV3Schema.parse(ordinary).definition, 'repeat'), false)
  })
  for (const repeat of [null, {}, { contractVersion: 1, blocks: [] }]) it(`denies nonconfigured repeat ${JSON.stringify(repeat)}`, () => {
    const f = makeCurrentWorkflowFixture('a1-invalid-repeat')
    assert.equal(WorkflowVersionV3Schema.safeParse({ ...f.version, definition: { ...f.version.definition, repeat } }).success, false)
  })
  for (const tag of [undefined, null, 0, 1, 2, 4, '3']) it(`denies saved/Start tag ${String(tag)} without conversion`, () => {
    const f = makeCurrentWorkflowFixture('a1-deny')
    assert.equal(ExecutionSemanticsVersionSchema.safeParse(tag).success, false)
    assert.equal(RunStartV3InputSchema.safeParse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, workflowVersionId: f.version.id,
      commandId: 'a1-denied-start', executionSemanticsVersion: tag, expectedWorkflowRevision: 1,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, expectedLocationRevision: 1, input: {} }).success, false)
    assert.equal(WorkflowVersionV3Schema.safeParse({ ...f.version, executionSemanticsVersion: tag }).success, false)
    assert.equal(WorkflowVersionV3Schema.safeParse({ ...f.version, definition: { ...f.version.definition, executionSemanticsVersion: tag } }).success, false)
    assert.equal(SavedRunVersionSnapshotSchema.safeParse({ version: f.version, run: { ...f.run, executionSemanticsVersion: tag } }).success, false)
  })
  it('retains graph wire v1 and ordinary technical attempt identities independently of semantics 3', () => {
    assert.equal(RUN_GRAPH_PROTOCOL_VERSION, 1)
    const f = makeCurrentWorkflowFixture('a1-wire')
    assert.equal(GraphExecutionIdentitySchema.parse({ ...f.identities[0], attempt: 2 }).attempt, 2)
  })
  it('denies cycles, unassigned choice edges, configuration/role and unsupported approval drift', () => {
    const f = makeCurrentWorkflowFixture('a1-shape', 'parallel')
    const cycle = structuredClone(f.version)
    cycle.definition.edges.push({ id: 'a1-cycle', kind: 'execution', source: cycle.definition.nodes[3]!.id, target: cycle.entryNodeId })
    assert.equal(WorkflowVersionV3Schema.safeParse(cycle).success, false)
    const choice = structuredClone(f.version)
    choice.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'done', target: { kind: 'branch_end' } }] }
    assert.equal(WorkflowVersionV3Schema.safeParse(choice).success, false)
    const wrongConfigs = structuredClone(f.configurations); wrongConfigs[0]!.agentId = 'another-agent'
    assert.equal(ExecutableWorkflowV3Schema.safeParse({ version: f.version, configurations: wrongConfigs }).success, false)
    const roles = structuredClone(f.configurations); roles[1]!.productRole = 'orchestrator'
    assert.equal(ExecutableWorkflowV3Schema.safeParse({ version: f.version, configurations: roles }).success, false)
    const approval = makeCurrentWorkflowFixture('a1-invalid-review', 'approval')
    approval.version.definition.edges.find((edge) => edge.kind === 'approval')!.source = approval.version.definition.nodes[1]!.id
    assert.equal(ExecutableWorkflowV3Schema.safeParse({ version: approval.version, configurations: approval.configurations }).success, false)
  })
  it('requires explicit finite nonnested blocks with enough budget and exact limit routing', () => {
    for (const cap of [0, -1, 1.5, Infinity, 2147483648]) {
      const f = makeCurrentWorkflowFixture('a1-cap', 'repeat'); f.version.definition.repeat!.blocks[0]!.maxOccurrences = cap
      assert.equal(WorkflowVersionV3Schema.safeParse(f.version).success, false)
    }
    const f = makeCurrentWorkflowFixture('a1-nesting', 'repeat')
    f.version.definition.repeat!.blocks.push({ ...f.version.definition.repeat!.blocks[0]!, id: 'nested' })
    assert.equal(WorkflowVersionV3Schema.safeParse(f.version).success, false)
    const small = makeCurrentWorkflowFixture('a1-budget', 'repeat'); small.version.definition.executionPolicy!.maxNodeExecutions = 5
    assert.equal(WorkflowVersionV3Schema.safeParse(small.version).success, false)
    const route = makeCurrentWorkflowFixture('a1-limit', 'repeat')
    route.version.definition.repeat!.blocks[0]!.limitExit = { kind: 'edge', relationshipId: 'not-a-saved-edge' }
    assert.equal(WorkflowVersionV3Schema.safeParse(route.version).success, false)
  })
  it('requires accepted private location/principal and exact immutable condition/configuration pins', () => {
    const f = makeCurrentWorkflowFixture('a1-pins')
    assert.equal(AcceptedWorkflowRunV3Schema.safeParse(f.run).success, false)
    const accepted = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'principal-a1',
      executionLocation: { runnerId: 'runner-a1', rootPath: '/synthetic/a1', locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } })
    SavedRunVersionSnapshotSchema.parse({ version: f.version, run: accepted })
    const drift = { ...accepted, agentConfigurationVersionIds: { ...accepted.agentConfigurationVersionIds, [f.configurations[0]!.agentId]: 'wrong-config' } }
    assert.equal(SavedRunVersionSnapshotSchema.safeParse({ version: f.version, run: drift }).success, false)
    assert.equal(RepeatRunVersionV1Schema.safeParse({ version: f.version, run: drift }).success, false)
    const condition = { ...accepted, executionCondition: { kind: 'not-supported' } }
    assert.equal(RepeatRunVersionV1Schema.safeParse({ version: f.version, run: condition }).success, false)
  })
})
