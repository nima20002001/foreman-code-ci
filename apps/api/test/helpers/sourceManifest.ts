import { randomUUID } from 'node:crypto'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { createSourceManifest, sourceSha256 } from '../../src/modules/sources/manifest.js'

const manifestBudget = 2 * 1024 * 1024

export function nearLimitManifest(git?: SourceManifest['git']): SourceManifest {
  const content = Buffer.from('approved')
  const base = { version: 1 as const, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1' as const, executablePolicy: 'strip' as const,
    ...(git ? { git } : {}), entries: [{ path: 'source.txt', kind: 'file' as const, byteSize: content.length,
      sha256: sourceSha256(content), executable: false }], deletions: [] as string[],
    totalEntries: 1, totalBytes: content.length, manifestDigest: '0'.repeat(64) }
  const longPath = (index: number) => `${String(index).padStart(4, '0')}/${Array(8).fill('x'.repeat(120)).join('/')}/leaf`
  const target = manifestBudget - 64
  let size = Buffer.byteLength(JSON.stringify(base))
  while (size + longPath(base.deletions.length).length + 3 <= target) {
    const path = longPath(base.deletions.length)
    size += path.length + (base.deletions.length ? 3 : 2)
    base.deletions.push(path)
  }
  const remaining = target - size - 3
  if (remaining > 5) base.deletions.push(longPath(base.deletions.length).slice(0, remaining).replace(/\/$/, 'x'))
  return createSourceManifest(base)
}

