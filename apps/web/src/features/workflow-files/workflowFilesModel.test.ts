import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { FilePage, FileRow, PermanentFileScope } from '@foreman-code/contracts/files'
import {
  inheritedReferenceScope, referenceFileSize, referenceFilesKey, referenceFilesRoot, referenceScopeKey,
  visibleReferenceRows, workflowReferenceScope,
} from './workflowFilesModel'

const A = { workspaceId: 'workspace', workflowId: 'a' }
const B = { workspaceId: 'workspace', workflowId: 'b' }
const scope = workflowReferenceScope(A)
function row(id: string, state: 'ready' | 'pending' | 'removed' = 'ready'): FileRow {
  const createdAt = '2026-09-28T00:00:00.000Z'
  return { file: { fileId: id, currentRevisionId: `rev-${id}`, scope, state, createdAt },
    revision: { fileId: id, revisionId: `rev-${id}`, filename: 'same.md', mediaType: 'text/markdown',
      byteSize: 0, sha256: '0'.repeat(64), origin: 'upload', createdAt } }
}
const page = (...items: FileRow[]): FilePage => ({ items, pageInfo: { nextCursor: null } })

describe('reference file identity and presentation helpers', () => {
  it('uses the documented workflow root', () => {
    assert.equal(referenceFilesRoot(scope), '/api/workspaces/workspace/workflows/a/reference-files')
  })
  it('uses a separate workspace root', () => {
    assert.equal(referenceFilesRoot(inheritedReferenceScope(A)), '/api/workspaces/workspace/reference-files')
  })
  it('encodes every path segment, including slashes', () => {
    assert.equal(referenceFilesRoot(workflowReferenceScope({ workspaceId: 'space /?', workflowId: 'a/#' })),
      '/api/workspaces/space%20%2F%3F/workflows/a%2F%23/reference-files')
  })
  it('changes workflow keys when switching A/B', () => {
    assert.notDeepEqual(referenceFilesKey(scope, 1), referenceFilesKey(workflowReferenceScope(B), 1))
  })
  it('shares inherited identity only within the same workspace', () => {
    assert.deepEqual(referenceFilesKey(inheritedReferenceScope(A), 1), referenceFilesKey(inheritedReferenceScope(B), 1))
    assert.notDeepEqual(referenceFilesKey(inheritedReferenceScope(A), 1),
      referenceFilesKey(inheritedReferenceScope({ ...A, workspaceId: 'other' }), 1))
  })
  it('separates both scope kinds and Operator session generations', () => {
    assert.notDeepEqual(referenceFilesKey(scope, 1), referenceFilesKey(scope, 2))
    assert.notEqual(referenceScopeKey(scope), referenceScopeKey(inheritedReferenceScope(A)))
  })
  it('does not depend on object property order', () => {
    const reordered: PermanentFileScope = { workflowId: 'a', workspaceId: 'workspace', kind: 'workflow_reference' }
    assert.equal(referenceScopeKey(scope), referenceScopeKey(reordered))
  })
  it('does not collide on delimiter-like IDs', () => {
    assert.notEqual(referenceScopeKey(workflowReferenceScope({ workspaceId: 'x/y', workflowId: 'z' })),
      referenceScopeKey(workflowReferenceScope({ workspaceId: 'x', workflowId: 'y/z' })))
  })
  it('keeps equal filenames as distinct rows', () => {
    assert.deepEqual(visibleReferenceRows([page(row('a'), row('b'))]).map(({ file }) => file.fileId), ['a', 'b'])
  })
  it('deduplicates overlapping pages by file ID without mutating them', () => {
    const pages = [page(row('a')), page(row('a'), row('b'))]
    const original = JSON.stringify(pages)
    assert.equal(visibleReferenceRows(pages).length, 2)
    assert.equal(JSON.stringify(pages), original)
  })
  it('hides a later tombstone but retains pending metadata', () => {
    assert.deepEqual(visibleReferenceRows([page(row('a'), row('b', 'pending')), page(row('a', 'removed'))])
      .map(({ file }) => [file.fileId, file.state]), [['b', 'pending']])
  })
  it('handles empty lists and formats bounded sizes without lifetime text', () => {
    assert.deepEqual(visibleReferenceRows(), [])
    assert.equal(referenceFileSize(0), '0 B')
    assert.equal(referenceFileSize(1024), '1 KiB')
    assert.equal(referenceFileSize(25 * 1024 * 1024), '25.0 MiB')
  })
})
