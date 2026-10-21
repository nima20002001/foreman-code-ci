import type pg from 'pg'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkspaceRootPolicySchema, type WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { jobDigest } from '../jobs/digest.js'
import { sourceSha256 } from '../sources/manifest.js'
import { authorizeSource } from '../sources/authority.js'
import { assertBuildComputerTarget } from '../settings/buildComputers.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK } from '../workspaces/projectFolderCleanup.js'
import type { WorkspaceBoundLocationService } from './service.js'

/** CI adds a managed root per computer without changing the workspace's primary folder. */
export class ManagedWorkspaceRootService {
  constructor(private readonly commands: PostgresCommandCoordinator,
    private readonly locations: WorkspaceBoundLocationService, private readonly roots: WorkspaceRootPolicyPort) {}

  private async authorize(sql: Pick<pg.PoolClient, 'query'>, principal: ManagementPrincipal,
    workspaceId: string, target: DeviceProvisioningTarget): Promise<void> {
    const live = await authorizeSource(sql, principal, 'source_roots:bind', workspaceId)
    await authorizeSource(sql, principal, 'source_roots:read', workspaceId)
    for (const action of ['workspace_locations:read', 'workspace_locations:validate', 'workspace_locations:update'] as const) {
      requireAuthorization(principal, action, { workspaceId })
      requireAuthorization(live.principal, action, { workspaceId })
    }
    await assertBuildComputerTarget(sql, target)
  }

  async ensure(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string,
    target: DeviceProvisioningTarget): Promise<WorkspaceRootPolicy> {
    let choices = await this.locations.choices(principal, { workspaceId })
    const sameHost = (host: WorkspaceRootPolicy['hostRef']) => canonicalJson(host) === canonicalJson(target.hostRef)
    const existing = choices.policies.find(policy => sameHost(policy.hostRef)
      && policy.applicationInstallationId === target.applicationInstallationId && policy.accessMode === 'read-write'
      && (target.hostRef.kind === 'main' || policy.registration?.keyRevision === target.keyRevision
        && policy.registration?.authorizationRevision === target.authorizationRevision))
    if (existing) return existing
    const previous = choices.allowlists.find(value => sameHost(value.hostRef))
    const adoptionCommand = `enroll-root-config-${jobDigest({ workspaceId, target, previous: previous ?? null })}`
    const configuration = (await this.locations.adopt(principal, source,
      { workspaceId, commandId: adoptionCommand, hostRef: target.hostRef })).value
    choices = await this.locations.choices(principal, { workspaceId })
    const base = configuration.bases.find(value => value.managedBy === 'worker-pairing'
      && value.accessModes.includes('read-write'))
    if (!base || configuration.applicationInstallationId !== target.applicationInstallationId) {
      throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED',
        'This computer has no pairing-approved managed workspace storage. Approve a writable root explicitly.', 409)
    }
    const location = await this.locations.get(principal, { workspaceId })
    const policy = choices.policies.find(value => sameHost(value.hostRef) && value.bindingPurpose === 'ci-enrollment')
    const selection = { workspaceId, hostRef: target.hostRef, allowedBaseId: base.baseId,
      configurationRevision: configuration.configurationRevision, relativePath: sourceSha256(Buffer.from(workspaceId)),
      accessMode: 'read-write' as const, expectedLocationRevision: location.locationRevision,
      expectedRootPolicyRevision: Number(policy?.rootPolicyRevision ?? 0) }
    const commandId = `enroll-managed-root-${jobDigest({ target, selection })}`
    return (await this.commands.execute({ principal, source, commandId, operation: 'workspace.root.managed.bind',
      targetKey: `workspace:${workspaceId}:managed-root`, payload: { target, selection },
      authorize: sql => this.authorize(sql, principal, workspaceId, target),
      perform: async sql => {
        if (!this.roots.authorizeManaged || !this.roots.prepareManaged || !this.roots.bindManaged) {
          throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'Managed root binding is unavailable.', 409)
        }
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${workspaceId}`])
        await sql.query('select id from workspaces where id=$1 for update', [workspaceId])
        const root = await this.roots.authorizeManaged(sql, principal, selection)
        await this.roots.fence(sql, root)
        const attestation = await this.roots.prepareManaged(root)
        await this.roots.fence(sql, root)
        await this.authorize(sql, principal, workspaceId, target)
        return WorkspaceRootPolicySchema.parse(await this.roots.bindManaged(sql, principal, root, attestation))
      } })).value
  }
}
