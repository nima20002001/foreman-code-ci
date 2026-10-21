import type { ApprovedRootAllowlist, WorkspaceRootSelection, WorkspaceRootPolicy, WorkspaceRootAttestation } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceBoundLocationReadback } from '@foreman-code/contracts/workspace-bound-location'
export const rootMainId = '11111111-1111-4111-8111-111111111111'
export const rootDeviceId = '22222222-2222-4222-8222-222222222222'
const filesystem = { device: '1', inode: '2', mountId: '3' }
const digest = 'a'.repeat(64)
export const mainRoot: ApprovedRootAllowlist = { schemaVersion: 1, hostRef: { kind: 'main', mainId: rootMainId }, applicationInstallationId: rootMainId,
  configurationRevision: '1', bases: [{ baseId: '33333333-3333-4333-8333-333333333333', canonicalPath: '/projects/shared', filesystem, accessModes: ['read-only', 'read-write'] }],
  managedRuntimeRoot: '/runtime/main', runtimeFilesystem: filesystem }
export const workerRoot: ApprovedRootAllowlist = { ...mainRoot, hostRef: { kind: 'device', mainId: rootMainId, deviceId: rootDeviceId }, applicationInstallationId: rootDeviceId,
  bases: [{ ...mainRoot.bases[0]!, baseId: '44444444-4444-4444-8444-444444444444' }], managedRuntimeRoot: '/runtime/worker' }
export function rootAttestation(input: WorkspaceRootSelection, host: ApprovedRootAllowlist): WorkspaceRootAttestation {
  return { schemaVersion: 1, attestationId: '55555555-5555-4555-8555-555555555555', requestDigest: digest, hostRef: input.hostRef,
    applicationInstallationId: host.applicationInstallationId, configurationRevision: input.configurationRevision, allowedBaseId: input.allowedBaseId,
    relativePath: input.relativePath, accessMode: input.accessMode, canonicalProjectRoot: host.bases[0]!.canonicalPath + (input.relativePath ? '/' + input.relativePath : ''),
    filesystem, directoryIdentityHash: digest, managedRuntimeRoot: host.managedRuntimeRoot, runtimeFilesystem: filesystem, attestationDigest: digest }
}
export function rootBinding(input: WorkspaceRootSelection, host: ApprovedRootAllowlist): WorkspaceRootPolicy {
  const proof = rootAttestation(input, host)
  return { schemaVersion: 1, rootPolicyId: '66666666-6666-4666-8666-666666666666', rootPolicyRevision: String(input.expectedRootPolicyRevision + 1),
    workspaceId: input.workspaceId, hostRef: input.hostRef, applicationInstallationId: host.applicationInstallationId,
    registration: input.hostRef.kind === 'device' ? { workerInstallationId: host.applicationInstallationId, keyRevision: 1, authorizationRevision: 1 } : null,
    locationRevision: String(input.expectedLocationRevision + 1), ownerPrincipalId: 'owner', allowedBaseId: input.allowedBaseId,
    configurationRevision: input.configurationRevision, relativePath: input.relativePath, accessMode: input.accessMode,
    canonicalProjectRoot: proof.canonicalProjectRoot, filesystem, directoryIdentityHash: digest, managedRuntimeRoot: host.managedRuntimeRoot,
    runtimeFilesystem: filesystem, attestationId: proof.attestationId, attestationDigest: digest }
}
export function boundRootReadback(input: WorkspaceRootSelection, host: ApprovedRootAllowlist): WorkspaceBoundLocationReadback {
  const binding = rootBinding(input, host)
  return { evidence: 'bound', workspaceId: input.workspaceId, locationRevision: input.expectedLocationRevision + 1, binding,
    executionLocation: { runnerId: input.hostRef.kind === 'main' ? 'server-main-runner' : 'server-worker-runner', rootPath: binding.canonicalProjectRoot } }
}

export function rootSetReadback(input: WorkspaceRootSelection, host: ApprovedRootAllowlist): WorkspaceBoundLocationReadback {
  const value = boundRootReadback(input, host)
  if (host.hostRef.kind === 'device' && value.evidence === 'bound') {
    value.locationRevision = input.expectedLocationRevision
    value.binding.locationRevision = String(input.expectedLocationRevision)
  }
  return value
}
