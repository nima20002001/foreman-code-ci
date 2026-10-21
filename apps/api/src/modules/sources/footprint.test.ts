import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES } from '@foreman-code/contracts/source-materialization'
import { sourceMaterializationBytes, sourceStructureBytes } from './footprint.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'

it('includes the saved Git object bytes in materialization placement', () => {
  const bytes = Buffer.from('source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', deletions: [],
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' },
    entries: [{ path: 'source.ts', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  const metadataBytes = 8 * 1024 * 1024
  const captured = createSourceManifest({ ...manifest,
    git: { ...manifest.git!, metadata: { byteSize: metadataBytes, sha256: 'c'.repeat(64) } } })
  expect(sourceMaterializationBytes(captured) - sourceMaterializationBytes(manifest)).toBe(metadataBytes)
})

it('budgets every unique parent directory for each retained source copy', () => {
  const paths = ['group/one/a.ts', 'group/one/b.ts', 'group/two/c.ts']
  const entriesAndParents = 6
  expect(sourceStructureBytes(paths)).toBe(entriesAndParents * 8192 + SOURCE_MATERIALIZATION_RECORD_MAX_BYTES)
  expect(sourceStructureBytes(paths, 2)).toBe(entriesAndParents * 8192 * 2 + SOURCE_MATERIALIZATION_RECORD_MAX_BYTES)
})
