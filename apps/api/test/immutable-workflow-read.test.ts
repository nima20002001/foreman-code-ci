import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { readImmutableWorkflowVersion } from '../src/modules/workflows/immutableRead.js'

function fixture(form: 'sequential' | 'repeat' = 'sequential') {
  const { version } = makeCurrentWorkflowFixture(`immutable-reader-${form}`, form)
  version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({
    definition: version.definition,
    configurations: version.agentConfigurationVersionIds,
    entryNodeId: version.entryNodeId,
  })).digest('hex')}`
  const row = {
    id: version.id,
    workspace_id: version.workspaceId,
    workflow_id: version.workflowId,
    version: version.version,
    entry_node_id: version.entryNodeId,
    execution_semantics_version: 3,
    record: version,
  }
  return { version, row }
}

describe('immutable workflow version reads', () => {
  it.each(['sequential', 'repeat'] as const)('preserves the saved %s definition on repeated reads', (form) => {
    const { version, row } = fixture(form)
    expect(readImmutableWorkflowVersion(row)).toEqual(version)
    expect(readImmutableWorkflowVersion(structuredClone(row))).toEqual(version)
    expect(Object.hasOwn(readImmutableWorkflowVersion(row).definition, 'repeat')).toBe(form === 'repeat')
  })

  it('keeps returned records independent of earlier caller mutations', () => {
    const { version, row } = fixture()
    const first = readImmutableWorkflowVersion(row)
    first.definition.nodes[0]!.name = 'Changed by a caller'
    const second = readImmutableWorkflowVersion(row)
    expect(second).toEqual(version)
    second.definition.executionPolicy!.maxNodeExecutions = 100
    expect(readImmutableWorkflowVersion(row)).toEqual(version)
  })

  it('detects changes in a previously read record without trusting its unchanged hash', () => {
    const { row } = fixture()
    readImmutableWorkflowVersion(row)
    row.record.definition.nodes[0]!.name = 'Changed in storage'
    expect(() => readImmutableWorkflowVersion(row)).toThrow('content hash does not match')
  })

  it('checks current physical columns and expected scope after a successful read', () => {
    const { row } = fixture()
    readImmutableWorkflowVersion(row)
    for (const changed of [
      { ...row, id: 'different-version' },
      { ...row, workspace_id: 'different-workspace' },
      { ...row, workflow_id: 'different-workflow' },
      { ...row, version: 2 },
      { ...row, entry_node_id: 'different-node' },
      { ...row, execution_semantics_version: 2 },
    ]) {
      expect(() => readImmutableWorkflowVersion(changed)).toThrow()
    }
    expect(() => readImmutableWorkflowVersion(row, { id: 'different-version' })).toThrow()
    expect(() => readImmutableWorkflowVersion(row, { workspaceId: 'different-workspace' })).toThrow()
    expect(() => readImmutableWorkflowVersion(row, { workflowId: 'different-workflow' })).toThrow()
  })

  it('reads changed metadata and rejects malformed content after a successful read', () => {
    const { row } = fixture()
    readImmutableWorkflowVersion(row)
    row.record.createdAt = '2026-10-01T00:00:00.000Z'
    expect(readImmutableWorkflowVersion(row).createdAt).toBe(row.record.createdAt)
    expect(() => readImmutableWorkflowVersion({
      ...row,
      record: { ...row.record, createdAt: 'invalid timestamp' },
    })).toThrow('workflow version is invalid')
    expect(() => readImmutableWorkflowVersion({
      ...row,
      record: { ...row.record, contentHash: `sha256:${'f'.repeat(64)}` },
    })).toThrow('content hash does not match')
  })
})
