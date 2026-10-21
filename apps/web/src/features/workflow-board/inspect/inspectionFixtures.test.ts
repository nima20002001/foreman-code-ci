import { expect, it } from 'vitest'
import { SavedRunVersionSnapshotSchema, repeatGraphTopologyV3 } from '@foreman-code/contracts/wave25'
import { inspectionBoardFixture } from './inspectionFixtures'

it('keeps renamed entry nodes in saved versions and topology with valid pinned Run records', async () => {
  const entryNodeId = 'ci-server'
  const fixture = await inspectionBoardFixture('renamed-entry', entryNodeId)

  for (const { run, version } of Object.values(fixture.runs)) {
    expect(SavedRunVersionSnapshotSchema.parse({ run, version })).toEqual({ run, version })
    expect(version.entryNodeId).toBe(entryNodeId)
    expect(version.definition.entryNodeId).toBe(entryNodeId)
    const topology = repeatGraphTopologyV3(version)
    expect(topology.entryNodeId).toBe(entryNodeId)
    expect(topology.nodes[0]!.workflowNodeId).toBe(entryNodeId)
    for (const edge of topology.relationships) {
      expect(edge.source).toBe(entryNodeId)
    }
  }

  const block = fixture.repeated.definition.repeat!.blocks[0]!
  expect(block.entryNodeId).toBe(entryNodeId)
  expect(block.nodeIds).toContain(entryNodeId)
  expect(block.exitNodeId).toBe(fixture.second.id)
})
