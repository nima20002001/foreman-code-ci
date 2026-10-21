import { describe, expect, it } from 'vitest'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

// Current execution always consumes an explicitly saved entry. Legacy entry
// inference and V1-to-V2 conversion are retired; historical ENG03 evidence stays
// in the evidence documents rather than an executable compatibility path.
describe('Current authored entry acceptance', () => {
  it.each(['coder', 'orchestrator'] as const)('starts a sole %s at its pinned entry', (role) => {
    const f = makeCurrentWorkflowFixture(`entry-${role}`, 'single')
    f.configurations[0]!.productRole = role
    const { version } = ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
    expect(version.entryNodeId).toBe(f.version.definition.nodes[0]!.id)
    expect(version.definition.repeat).toBeUndefined()
  })
  it.each(['single', 'sequential'] as const)('rejects an omitted entry for a %s graph', (form) => {
    const f = makeCurrentWorkflowFixture(`missing-${form}`, form)
    expect(() => ExecutableWorkflowV3Schema.parse({ configurations: f.configurations,
      version: { ...f.version, definition: { ...f.version.definition, entryNodeId: null } } })).toThrow()
  })
  it('does not let node order or an Orchestrator label choose another entry', () => {
    const f = makeCurrentWorkflowFixture('entry-order')
    const entry = f.version.entryNodeId
    f.version.definition.nodes.reverse()
    f.version.definition.nodes[0]!.name = 'Orchestrator'
    expect(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version.entryNodeId).toBe(entry)
  })
  it('rejects deletion of the accepted entry instead of choosing a remaining node', () => {
    const f = makeCurrentWorkflowFixture('entry-deleted')
    f.version.definition.nodes = f.version.definition.nodes.filter((node) => node.id !== f.version.entryNodeId)
    f.version.definition.edges = []
    expect(() => ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })).toThrow()
  })
  it('rejects mismatched authored and immutable entry identities', () => {
    const f = makeCurrentWorkflowFixture('entry-mismatch')
    f.version.definition.entryNodeId = f.version.definition.nodes[1]!.id
    expect(() => ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })).toThrow()
  })
  it('selects an explicitly authored Orchestrator without array-order authority', () => {
    const f = makeCurrentWorkflowFixture('entry-orchestrators')
    f.configurations.forEach((config) => { config.productRole = 'orchestrator' })
    f.version.definition.edges = []
    f.version.entryNodeId = f.version.definition.entryNodeId = f.version.definition.nodes[1]!.id
    f.version.definition.nodes.reverse()
    expect(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version.entryNodeId)
      .toBe(f.version.definition.entryNodeId)
  })
  it('rejects a configuration that does not belong to the immutable entry pin', () => {
    const f = makeCurrentWorkflowFixture('entry-stale-config')
    f.configurations[0]!.id = 'current-but-not-pinned'
    expect(() => ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })).toThrow()
  })
})
