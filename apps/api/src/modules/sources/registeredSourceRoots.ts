import { join } from 'node:path'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootSelection } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../errors.js'
import type { RegisteredSourceRootPort, AuthorizedSourceRoot } from './admissionPorts.js'
import type { WorkspaceRootHostPort } from './rootPolicyPorts.js'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import type { PostgresWorkspaceRootPolicies } from './rootPolicies.js'
import { authorizeSource } from './authority.js'

/** Source linkage consumes the ONE generic workspace root authority. */
export class RegisteredWorkspaceSourceRoots implements RegisteredSourceRootPort {
  private readonly accepted = new WeakMap<AuthorizedSourceRoot, { policy: WorkspaceRootPolicy; principal: ManagementPrincipal }>()
  constructor(private readonly policies: PostgresWorkspaceRootPolicies, private readonly hosts: WorkspaceRootHostPort) {}
  async authorize(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal,
    input: { workspaceId: string; selection: SourceRootSelection; accessMode: 'read-only' | 'exclusive-write' }): Promise<AuthorizedSourceRoot> {
    const policy = await this.policies.resolve(sql, principal, { workspaceId: input.workspaceId, ...input.selection })
    const { ownerId } = await authorizeSource(sql, principal, 'source_roots:bind', input.workspaceId)
    if (input.accessMode === 'exclusive-write' && policy.accessMode !== 'read-write') throw new DomainError('ROOT_ACCESS_DENIED', 'The registered root policy permits only a read-only source view.', 403)
    const root: AuthorizedSourceRoot = { workspaceId: input.workspaceId, selection: input.selection, ownerPrincipalId: ownerId,
      mainId: policy.hostRef.mainId, deviceId: policy.hostRef.kind === 'device' ? policy.hostRef.deviceId : null,
      workerInstallationId: policy.registration?.workerInstallationId ?? null, keyRevision: policy.registration?.keyRevision ?? null,
      authorizationRevision: policy.registration?.authorizationRevision ?? null,
      canonicalPath: join(policy.managedRuntimeRoot, 'source-materializations', policy.rootPolicyId) }
    this.accepted.set(root, { policy, principal }); return root
  }
  async attest(root: AuthorizedSourceRoot) {
    const authorized = this.accepted.get(root)
    if (!authorized) throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Only the main-authorized root object may request target attestation.', 403)
    return this.hosts.sourceNamespace(authorized.policy, authorized.policy.rootPolicyId)
  }
  async fence(sql: Pick<pg.PoolClient, 'query'>, root: AuthorizedSourceRoot): Promise<void> {
    const authorized = this.accepted.get(root)
    if (!authorized) throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Original root authorization is missing.', 403)
    const policy = authorized.policy
    await this.policies.resolve(sql, authorized.principal, { workspaceId: policy.workspaceId, hostRef: policy.hostRef,
      rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision })
  }
}
