import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { agentWorktree } from './service.js'
import { createSourceManifest } from './manifest.js'
import { freezePlacement } from '../placement/binding.js'

it.each(['another repository', 'removed repository'])('uses the approved repository after the workspace has %s', async change => {
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'original/site' },
    entries: [], deletions: [] })
  const sql = { query: async () => ({ rows: [{ workflow_name: 'Website', agent_name: 'Coder', run_id: 'run-accepted',
    workspace: { id: 'workspace-one', name: 'Site', ...(change === 'another repository'
      ? { repository: { provider: 'github', owner: 'other', name: 'site', defaultBranch: 'main' } } : {}) } }] }) } as unknown as GraphSqlClient
  expect(await agentWorktree(sql, 'execution-one', manifest)).toMatchObject({ repository: 'original/site' })
})

it('keeps the accepted shared-copy behavior when a repository is configured after source approval', async () => {
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' }, entries: [], deletions: [] })
  const sql = { query: async () => ({ rows: [{ workflow_name: 'Website', agent_name: 'Coder', run_id: 'run-accepted',
    workspace: { id: 'workspace-one', name: 'Site',
      repository: { provider: 'github', owner: 'other', name: 'site', defaultBranch: 'main' } } }] }) } as unknown as GraphSqlClient
  expect(await agentWorktree(sql, 'execution-one', manifest)).toBeUndefined()
})

it('uses the frozen branch request after workflow and Agent names change', async () => {
  const mainId = randomUUID()
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'original/site' } })
  const digest = 'c'.repeat(64)
  const worktree = { repository: 'original/site', branch: 'foreman/site/accepted-prefix' }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId,
    runId: 'run-accepted', nodeId: 'node-accepted', hostRef: { kind: 'main', mainId }, registration: null,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', directoryIdentityHash: digest,
      attestationId: 'attestation', attestationHash: digest },
    source: { kind: 'pending', approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      revisionId: manifest.snapshotId, manifestDigest: manifest.manifestDigest, rootId: randomUUID(), bindingRevision: 1,
      materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration',
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'installation', installationFingerprint: digest, runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [], worktree } })
  const sql = { query: async () => ({ rows: [{ placement, workflow_name: 'Renamed workflow',
    agent_name: 'Renamed Agent', run_id: placement.runId }] }) } as unknown as GraphSqlClient
  expect(await agentWorktree(sql, 'execution', manifest)).toEqual(worktree)
  const another = createSourceManifest({ ...manifest, git: { ...manifest.git!, repository: 'other/site' } })
  await expect(agentWorktree(sql, 'execution', another)).rejects.toMatchObject({ code: 'SOURCE_WORKTREE_CONFLICT' })
})
