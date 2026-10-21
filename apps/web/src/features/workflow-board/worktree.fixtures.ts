import type { ApprovedSource, SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRepositoryReadResult } from '@foreman-code/contracts/workspace-git'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { boundRootReadback, mainRoot } from '../settings/workspaceBoundLocation.fixtures'

export function worktreeFixture(workspaceId = 'workspace-1') {
  const repository = { provider: 'github' as const, owner: 'octo-owner', name: 'website', defaultBranch: 'main' }
  const selection: WorkspaceRootSelection = { workspaceId, hostRef: mainRoot.hostRef,
    allowedBaseId: mainRoot.bases[0]!.baseId, configurationRevision: mainRoot.configurationRevision,
    relativePath: 'github/website', accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
  const location = boundRootReadback(selection, mainRoot)
  if (location.evidence !== 'bound') throw new Error('The test project must have a bound location.')
  const source: ApprovedSource = { version: 1, workspaceId, ownerPrincipalId: 'owner', approvedByPrincipalId: 'owner',
    locationRevision: 1, mainId: mainRoot.hostRef.mainId, originIdentityHash: `sha256:${'a'.repeat(64)}`,
    approvedAt: '2026-10-10T00:00:00Z', availability: 'retained', manifest: { version: 1,
      snapshotId: '77777777-7777-4777-8777-777777777777', approvedSourceId: '88888888-8888-4888-8888-888888888888',
      capturePolicy: 'git-tree-v1', executablePolicy: 'strip', git: { repository: 'octo-owner/website',
        commit: 'b'.repeat(40), tree: 'c'.repeat(40), objectFormat: 'sha1' }, entries: [], deletions: [],
      totalEntries: 0, totalBytes: 0, manifestDigest: 'd'.repeat(64) } }
  const root: SourceRootRecord = { version: 1, source: { approvedSourceId: source.manifest.approvedSourceId,
    snapshotId: source.manifest.snapshotId, manifestDigest: source.manifest.manifestDigest },
    selection: { hostRef: mainRoot.hostRef, rootPolicyId: location.binding.rootPolicyId,
      rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: source.mainId, deviceId: null, workerInstallationId: null, workspaceId,
      rootId: '99999999-9999-4999-8999-999999999999', bindingRevision: 1, locationRevision: 1,
      canonicalPath: '/runtime/main/source-materializations/root', filesystem: location.binding.filesystem,
      accessMode: 'exclusive-write', snapshotId: source.manifest.snapshotId, manifestDigest: source.manifest.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', registration: null,
    attestationId: location.binding.attestationId, attestationDigest: location.binding.attestationDigest,
    boundAt: '2026-10-10T00:00:00Z' }
  const rootBinding = { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }
  const ready: WorkspaceRepositoryReadResult = { workspaceId, state: 'ready', repository, revision: 2,
    operation: { commandId: 'fixture-import-command', phase: 'ready', commit: source.manifest.git!.commit },
    location, approvedSource: source, rootBinding }
  return { repository, location, source, root, rootBinding, ready, selection }
}
