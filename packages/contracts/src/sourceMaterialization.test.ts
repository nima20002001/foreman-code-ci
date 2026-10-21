import { describe, expect, it } from 'vitest'
import { AgentSnapshotResultSchema, SourceMaterializationFileSchema } from './sourceMaterialization.js'

const id = '11111111-1111-4111-8111-111111111111'
const filesystem = { device: '8', inode: '100', mountId: '44' }
const binding = { version: 1, mainId: id, deviceId: null, workerInstallationId: null,
  workspaceId: 'workspace', rootId: id, bindingRevision: 1, locationRevision: 1,
  canonicalPath: '/private/sources', filesystem, accessMode: 'exclusive-write', snapshotId: id, manifestDigest: 'a'.repeat(64) }
const receipt = { version: 1, materializationId: id, binding, placementHash: 'b'.repeat(64),
  executionId: 'execution', attemptId: 'attempt', keyRevision: null, authorizationRevision: null,
  verifiedManifestDigest: 'a'.repeat(64), verifiedEntries: 0, verifiedBytes: 0, verifiedAt: '2026-10-12T00:00:00Z',
  claimScope: 'execution', sharedTree: { id, referenceIdentity: filesystem },
  worktree: { repository: 'owner/project', branch: 'foreman/agent', commit: 'c'.repeat(40) }, localTreeIdentity: filesystem }
const manifest = { version: 1, snapshotId: id, approvedSourceId: id, capturePolicy: 'git-tree-v1',
  executablePolicy: 'strip', entries: [], deletions: [], totalEntries: 0, totalBytes: 0, manifestDigest: 'a'.repeat(64) }
const snapshotReference = { canonicalStorePath: '/private/snapshots', storeIdentity: filesystem }

describe('private source materialization records', () => {
  it('accepts Main-local agent snapshot reuse and existing independent reference copies', () => {
    expect(SourceMaterializationFileSchema.safeParse({ receipt, manifest, snapshotReference }).success).toBe(true)
    expect(SourceMaterializationFileSchema.safeParse({ receipt, manifest }).success).toBe(true)
  })

  it('rejects snapshot reuse by remote devices or quota-bound jobs', () => {
    const remote = { ...receipt, binding: { ...binding, deviceId: id, workerInstallationId: id } }
    expect(SourceMaterializationFileSchema.safeParse({ receipt: remote, manifest, snapshotReference }).success).toBe(false)
    const quota = { namespace: id, projectId: 1, hardLimitBytes: 4096, hardInodes: 16, filesystem }
    expect(SourceMaterializationFileSchema.safeParse({ receipt: { ...receipt, quota }, manifest, snapshotReference }).success)
      .toBe(false)
  })
})

describe('agent snapshot response size', () => {
  it('accepts a base64 bundle containing 32 MiB of changed files', () => {
    const bundleBase64 = Buffer.alloc(32 * 1024 * 1024).toString('base64')
    expect(AgentSnapshotResultSchema.safeParse({ commit: 'a'.repeat(40), bundleBase64 }).success).toBe(true)
  })

  it('rejects a base64 bundle above 32 MiB', () => {
    const bundleBase64 = Buffer.alloc(32 * 1024 * 1024 + 3).toString('base64')
    expect(AgentSnapshotResultSchema.safeParse({ commit: 'a'.repeat(40), bundleBase64 }).success).toBe(false)
  })
})
