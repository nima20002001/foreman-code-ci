import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema, WorkspaceRootSelectionSchema, WorkspaceRootAttestationSchema,
  type ApprovedRootAllowlist, type WorkspaceRootSelection, type WorkspaceRootPolicy, type WorkspaceRootAttestation } from '@foreman-code/contracts/workspace-root-policies'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { authorizeSource } from './authority.js'
import { sourceSha256 } from './manifest.js'
import { rootSelectionDigest, rootAttestationDigest } from './rootAttestation.js'
import type { AuthorizedWorkspaceRoot, WorkspaceRootHostPort, WorkspaceRootPolicyPort } from './rootPolicyPorts.js'
import { authorizationReadSnapshot } from '../access/authorizationReadSnapshot.js'

type Sql = GraphSqlClient
type RootBindingKind = 'location' | 'managed'
export function workspaceRootHostScope(host: ApprovedRootAllowlist['hostRef']): string { return host.kind === 'main' ? `main:${host.mainId}` : `main:${host.mainId}:device:${host.deviceId}` }
function policyScope(host: ApprovedRootAllowlist['hostRef'], kind: RootBindingKind): string {
  return workspaceRootHostScope(host) + (kind === 'managed' ? ':ci-enrollment' : '')
}
/** One generic root authority. Source bindings merely reference its accepted
 * policies; no Workflow, Agent, provider token or source snapshot is required.
 */
export class PostgresWorkspaceRootPolicies implements WorkspaceRootPolicyPort {
  private readonly actors = new WeakMap<AuthorizedWorkspaceRoot, ManagementPrincipal>()
  constructor(private readonly mainId: string, private readonly hosts: WorkspaceRootHostPort) {}
  private async authorizeWorkspace(sql: Sql, principal: ManagementPrincipal, workspaceId: string, write = false) {
    const live = await authorizeSource(sql, principal, write ? 'source_roots:bind' : 'source_roots:read', workspaceId)
    requireAuthorization(principal, 'workspace_locations:read', { workspaceId }); requireAuthorization(live.principal, 'workspace_locations:read', { workspaceId })
    const snapshot = await authorizationReadSnapshot(sql)
    const mainId = snapshot ? snapshot.main_id : (await sql.query<{ id: string }>(
      'select id from application_installation where singleton=true for share')).rows[0]?.id
    if (mainId !== this.mainId) throw new DomainError('ROOT_WRONG_MAIN', 'Root policy belongs to the original main installation.', 403)
    const row = snapshot?.workspace_id === workspaceId ? snapshot.workspace : (await sql.query<{
      location_revision: string; archived_at: Date | null
    }>('select location_revision,archived_at from workspaces where id=$1 for share', [workspaceId])).rows[0]
    if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
    if (row.archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot select or authorize roots.', 409)
    return { ...live, locationRevision: Number(row.location_revision) }
  }
  private async configuration(sql: Sql, host: ApprovedRootAllowlist['hostRef']): Promise<ApprovedRootAllowlist> {
    if (host.mainId !== this.mainId) throw new DomainError('ROOT_WRONG_MAIN', 'The selected root host belongs to another main.', 403)
    const snapshot = await authorizationReadSnapshot(sql)
    const sameHost = snapshot && isDeepStrictEqual(snapshot.placement.hostRef, host)
    const row = sameHost ? snapshot.root_configuration : (await sql.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
      join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
      where h.host_scope=$1 for share of h,c`, [workspaceRootHostScope(host)])).rows[0]
    if (!row) throw new DomainError('ROOT_CONFIGURATION_MISSING', 'The host has no explicit human-approved root configuration.', 409)
    const configuration = ApprovedRootAllowlistSchema.parse(row.record)
    if (!isDeepStrictEqual(configuration.hostRef, host)) throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'Persisted root host facts changed.', 409)
    return configuration
  }
  /** Trusted W07-C/HRT-C configuration or Main app-storage adoption only. No
   * HTTP/MCP input can publish paths. The carrier/bootstrap verifies the config
   * signature/provenance and supplies these exact matching host/digest facts.
   */
  async publishApprovedHostConfiguration(sql: Sql, raw: ApprovedRootAllowlist, evidence: {
    mainId: string; hostRef: ApprovedRootAllowlist['hostRef']; applicationInstallationId: string; configurationRevision: string; configurationDigest: string
  }): Promise<void> {
    const configuration = ApprovedRootAllowlistSchema.parse(raw), digest = sourceSha256(Buffer.from(JSON.stringify(configuration)))
    if (configuration.hostRef.mainId !== this.mainId || evidence.mainId !== this.mainId || !isDeepStrictEqual(configuration.hostRef, evidence.hostRef)
      || configuration.applicationInstallationId !== evidence.applicationInstallationId || configuration.configurationRevision !== evidence.configurationRevision
      || digest !== evidence.configurationDigest || (configuration.hostRef.kind === 'main' && configuration.applicationInstallationId !== this.mainId))
      throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'Approved root configuration is not bound to the actual authenticated installation.', 409)
    const main = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
    if (main?.id !== this.mainId) throw new DomainError('ROOT_WRONG_MAIN', 'Root configuration belongs to another installation.', 403)
    const scope = workspaceRootHostScope(configuration.hostRef)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`root-configuration:${scope}`])
    const existing = (await sql.query<{ digest: string }>('select digest from workspace_root_host_configurations where host_scope=$1 and configuration_revision=$2', [scope, configuration.configurationRevision])).rows[0]
    if (existing && existing.digest !== digest) throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'The same approved configuration revision cannot change paths or authority.', 409)
    const current = (await sql.query<{ configuration_revision: string }>('select configuration_revision from workspace_root_host_configuration_heads where host_scope=$1 for update', [scope])).rows[0]
    if (current && BigInt(current.configuration_revision) > BigInt(configuration.configurationRevision)) throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'An older configuration cannot replace current approved roots.', 409)
    await sql.query(`insert into workspace_root_host_configurations(host_scope,configuration_revision,main_id,application_installation_id,record,digest)
      values($1,$2,$3,$4,$5::jsonb,$6) on conflict(host_scope,configuration_revision) do nothing`, [scope, configuration.configurationRevision, this.mainId, configuration.applicationInstallationId, JSON.stringify(configuration), digest])
    await sql.query(`insert into workspace_root_host_configuration_heads(host_scope,configuration_revision) values($1,$2)
      on conflict(host_scope) do update set configuration_revision=excluded.configuration_revision`, [scope, configuration.configurationRevision])
  }
  async list(sql: Sql, principal: ManagementPrincipal, workspaceId: string) {
    await this.authorizeWorkspace(sql, principal, workspaceId)
    const configurations = await this.hosts.configurations(sql, workspaceId), allowlists: ApprovedRootAllowlist[] = []
    for (const raw of configurations) {
      const configuration = ApprovedRootAllowlistSchema.parse(raw)
      if (configuration.hostRef.mainId !== this.mainId) continue
      try { await this.hosts.authorize(sql, principal, configuration.hostRef, configuration.applicationInstallationId) } catch (error) {
        // Unavailable device configuration cannot authorize IO, and must not
        // block independent main choices. Original policy facts stay readable.
        if (configuration.hostRef.kind === 'device') continue
        throw error
      }
      const accepted = await this.configuration(sql, configuration.hostRef)
      if (!isDeepStrictEqual(accepted, configuration)) throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'Configured root inventory is not the main\'s accepted configuration.', 409)
      allowlists.push(configuration)
    }
    return { workspaceId, policies: await this.read(sql, principal, workspaceId), allowlists, readiness: 'metadata-only' as const }
  }
  async adopt(sql: Sql, principal: ManagementPrincipal, workspaceId: string, host: ApprovedRootAllowlist['hostRef']) {
    const live = await this.authorizeWorkspace(sql, principal, workspaceId, true)
    requireAuthorization(principal, 'workspace_locations:update', { workspaceId })
    requireAuthorization(live.principal, 'workspace_locations:update', { workspaceId })
    if (host.mainId !== this.mainId) throw new DomainError('ROOT_WRONG_MAIN', 'Select a host on this Main installation.', 403)
    if (!this.hosts.configuration) throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'Protected host configuration adoption is unavailable.', 409)
    const configuration = ApprovedRootAllowlistSchema.parse(await this.hosts.configuration(sql, host))
    await this.hosts.authorize(sql, live.principal, host, configuration.applicationInstallationId)
    await this.authorizeWorkspace(sql, principal, workspaceId, true)
    await this.publishApprovedHostConfiguration(sql, configuration, { mainId: this.mainId, hostRef: host,
      applicationInstallationId: configuration.applicationInstallationId, configurationRevision: configuration.configurationRevision,
      configurationDigest: sourceSha256(Buffer.from(JSON.stringify(configuration))) })
    return configuration
  }
  async authorize(sql: Sql, principal: ManagementPrincipal, raw: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot> {
    return this.authorizeRoot(sql, principal, raw, 'location')
  }
  async authorizeManaged(sql: Sql, principal: ManagementPrincipal,
    selection: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot> {
    const root = await this.authorizeRoot(sql, principal, selection, 'managed')
    this.assertManagedSelection(root)
    return root
  }
  private async authorizeRoot(sql: Sql, principal: ManagementPrincipal, raw: WorkspaceRootSelection,
    kind: RootBindingKind): Promise<AuthorizedWorkspaceRoot> {
    const selection = WorkspaceRootSelectionSchema.parse(raw), live = await this.authorizeWorkspace(sql, principal, selection.workspaceId)
    requireAuthorization(principal, 'workspace_locations:validate', { workspaceId: selection.workspaceId }); requireAuthorization(live.principal, 'workspace_locations:validate', { workspaceId: selection.workspaceId })
    if (live.locationRevision !== selection.expectedLocationRevision) throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was selected.', 409)
    const allowlist = await this.configuration(sql, selection.hostRef)
    const registration = await this.hosts.authorize(sql, live.principal, selection.hostRef, allowlist.applicationInstallationId)
    if (allowlist.configurationRevision !== selection.configurationRevision || !allowlist.bases.some(base => base.baseId === selection.allowedBaseId && base.accessModes.includes(selection.accessMode)))
      throw new DomainError('ROOT_ACCESS_DENIED', 'Select an allowed base/access mode from the current human-approved host configuration.', 403)
    const row = (await sql.query<{ root_policy_revision: string }>('select root_policy_revision from workspace_root_policy_heads where workspace_id=$1 and host_scope=$2 for share', [selection.workspaceId, policyScope(selection.hostRef, kind)])).rows[0]
    if (Number(row?.root_policy_revision ?? 0) !== selection.expectedRootPolicyRevision) throw new DomainError('ROOT_POLICY_REVISION_CONFLICT', 'The selected host root policy changed.', 409, { currentRootPolicyRevision: Number(row?.root_policy_revision ?? 0) })
    const root = { selection, allowlist, ownerPrincipalId: live.ownerId, registration }
    this.actors.set(root, structuredClone(principal)); return root
  }
  async attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation> {
    if (!this.actors.has(root)) throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Attestation requires the actual main-authorized root object.', 403)
    return this.validateAttestation(root, await this.hosts.attest(root))
  }
  private assertManagedSelection(root: AuthorizedWorkspaceRoot): void {
    const base = root.allowlist.bases.find(value => value.baseId === root.selection.allowedBaseId)
    const relativePath = sourceSha256(Buffer.from(root.selection.workspaceId))
    if (base?.managedBy !== 'worker-pairing' || root.selection.accessMode !== 'read-write'
      || root.selection.relativePath !== relativePath) {
      throw new DomainError('ROOT_ACCESS_DENIED', 'Automatic roots require this workspace’s product-managed folder.', 403)
    }
  }
  async prepareManaged(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation> {
    if (!this.actors.has(root)) {
      throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Managed folder setup requires an authorized root.', 403)
    }
    this.assertManagedSelection(root)
    if (!this.hosts.prepareManaged) {
      throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'Managed folder setup is unavailable on this host.', 409)
    }
    return this.validateAttestation(root, await this.hosts.prepareManaged(root))
  }
  private validateAttestation(root: AuthorizedWorkspaceRoot, raw: unknown): WorkspaceRootAttestation {
    const attestation = WorkspaceRootAttestationSchema.parse(raw)
    const { attestationDigest, ...facts } = attestation
    if (attestation.requestDigest !== rootSelectionDigest(root.selection) || attestationDigest !== rootAttestationDigest(facts)
      || !isDeepStrictEqual(attestation.hostRef, root.selection.hostRef) || attestation.applicationInstallationId !== root.allowlist.applicationInstallationId
      || attestation.configurationRevision !== root.allowlist.configurationRevision || attestation.allowedBaseId !== root.selection.allowedBaseId
      || attestation.relativePath !== root.selection.relativePath || attestation.accessMode !== root.selection.accessMode
      || attestation.managedRuntimeRoot !== root.allowlist.managedRuntimeRoot || !isDeepStrictEqual(attestation.runtimeFilesystem, root.allowlist.runtimeFilesystem))
      throw new DomainError('ROOT_ATTESTATION_CONFLICT', 'Host attestation does not match the exact authorized root selection.', 409)
    return attestation
  }
  browse(root: AuthorizedWorkspaceRoot, relativePath: string) {
    if (!this.actors.has(root)) throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Folder browsing requires the actual main-authorized root object.', 403)
    return this.hosts.browse(root, relativePath)
  }
  async fence(sql: Sql, root: AuthorizedWorkspaceRoot): Promise<void> {
    const principal = this.actors.get(root)
    if (!principal) throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Original scoped root authority is missing.', 403)
    await this.authorizeWorkspace(sql, principal, root.selection.workspaceId)
    const registration = await this.hosts.authorize(sql, principal, root.selection.hostRef, root.allowlist.applicationInstallationId)
    if (!isDeepStrictEqual(registration, root.registration)) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The actual host authorization changed during validation.', 409)
    const row = (await sql.query<{ location_revision: string; archived_at: Date | null }>('select location_revision,archived_at from workspaces where id=$1 for share', [root.selection.workspaceId])).rows[0]
    if (!row || row.archived_at || Number(row.location_revision) !== root.selection.expectedLocationRevision) throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed during host validation.', 409)
    const accepted = await this.configuration(sql, root.selection.hostRef)
    if (!isDeepStrictEqual(accepted, root.allowlist)) throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'Approved host configuration changed during validation.', 409)
    const owner = (await sql.query<{ id: string; revoked_at: Date | null; expires_at: Date }>('select id,revoked_at,expires_at from management_principals where id=$1 for share', [root.ownerPrincipalId])).rows[0]
    if (!owner || owner.revoked_at || owner.expires_at.getTime() <= Date.now()) throw new DomainError('AUTH_REVOKED', 'The root owner is no longer active.', 403)
    // The composing C command repeats caller's live grants under its lock; host
    // authorizer is still called on bind/resolve with the actual principal.
  }
  async bind(sql: Sql, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot, raw: WorkspaceRootAttestation, nextLocationRevision: number): Promise<WorkspaceRootPolicy> {
    return this.bindPolicy(sql, principal, root, raw, { kind: 'location', locationRevision: nextLocationRevision })
  }
  async bindManaged(sql: Sql, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot,
    attestation: WorkspaceRootAttestation): Promise<WorkspaceRootPolicy> {
    this.assertManagedSelection(root)
    return this.bindPolicy(sql, principal, root, attestation,
      { kind: 'managed', locationRevision: root.selection.expectedLocationRevision })
  }
  private async bindPolicy(sql: Sql, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot,
    raw: WorkspaceRootAttestation, location: { kind: RootBindingKind; locationRevision: number }): Promise<WorkspaceRootPolicy> {
    if (this.actors.get(root)?.id !== principal.id) throw new DomainError('ROOT_AUTHORIZATION_MISSING', 'Root binding belongs to another scoped caller.', 403)
    const live = await this.authorizeWorkspace(sql, principal, root.selection.workspaceId, true)
    requireAuthorization(principal, 'workspace_locations:update', { workspaceId: root.selection.workspaceId }); requireAuthorization(live.principal, 'workspace_locations:update', { workspaceId: root.selection.workspaceId })
    const expectedRevision = root.selection.expectedLocationRevision
      + (location.kind === 'location' && root.selection.hostRef.kind === 'main' ? 1 : 0)
    if (location.locationRevision < 0 || location.locationRevision !== expectedRevision
      || live.locationRevision !== location.locationRevision)
      throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed during root binding.', 409)
    const configuration = await this.configuration(sql, root.selection.hostRef)
    if (!isDeepStrictEqual(configuration, root.allowlist)) throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'The accepted root configuration changed.', 409)
    const registration = await this.hosts.authorize(sql, live.principal, root.selection.hostRef, configuration.applicationInstallationId)
    if (!isDeepStrictEqual(registration, root.registration)) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The host registration changed during attestation.', 409)
    const attestation = this.validateAttestation(root, raw)
    const scope = policyScope(root.selection.hostRef, location.kind)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-root:${root.selection.workspaceId}:${scope}`])
    const head = (await sql.query<{ root_policy_id: string; root_policy_revision: string }>('select root_policy_id,root_policy_revision from workspace_root_policy_heads where workspace_id=$1 and host_scope=$2 for update', [root.selection.workspaceId, scope])).rows[0]
    if (Number(head?.root_policy_revision ?? 0) !== root.selection.expectedRootPolicyRevision) {
      throw new DomainError('ROOT_POLICY_REVISION_CONFLICT', 'The selected root policy changed during binding.', 409,
        { currentRootPolicyRevision: Number(head?.root_policy_revision ?? 0) })
    }
    const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: head?.root_policy_id ?? randomUUID(), rootPolicyRevision: String(root.selection.expectedRootPolicyRevision + 1),
      ...(location.kind === 'managed' ? { bindingPurpose: 'ci-enrollment' as const } : {}),
      workspaceId: root.selection.workspaceId, hostRef: root.selection.hostRef, applicationInstallationId: root.allowlist.applicationInstallationId,
      registration, locationRevision: String(location.locationRevision), ownerPrincipalId: live.ownerId, allowedBaseId: root.selection.allowedBaseId,
      configurationRevision: root.allowlist.configurationRevision, relativePath: root.selection.relativePath, accessMode: root.selection.accessMode,
      canonicalProjectRoot: attestation.canonicalProjectRoot, filesystem: attestation.filesystem, directoryIdentityHash: attestation.directoryIdentityHash,
      managedRuntimeRoot: attestation.managedRuntimeRoot, runtimeFilesystem: attestation.runtimeFilesystem, attestationId: attestation.attestationId, attestationDigest: attestation.attestationDigest })
    await sql.query('insert into workspace_root_policies(root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record) values($1,$2,$3,$4,$5,$6::jsonb)',
      [policy.rootPolicyId, policy.rootPolicyRevision, policy.workspaceId, scope, policy.locationRevision, JSON.stringify(policy)])
    await sql.query(`insert into workspace_root_policy_heads(workspace_id,host_scope,root_policy_id,root_policy_revision) values($1,$2,$3,$4)
      on conflict(workspace_id,host_scope) do update set root_policy_id=excluded.root_policy_id,root_policy_revision=excluded.root_policy_revision`,
    [policy.workspaceId, scope, policy.rootPolicyId, policy.rootPolicyRevision]); return policy
  }
  async resolve(sql: Sql, principal: ManagementPrincipal, selection: { workspaceId: string; hostRef: WorkspaceRootPolicy['hostRef']; rootPolicyId: string; rootPolicyRevision: string; locationRevision: string }): Promise<WorkspaceRootPolicy> {
    const live = await this.authorizeWorkspace(sql, principal, selection.workspaceId)
    const snapshot = await authorizationReadSnapshot(sql)
    const selected = snapshot?.placement.destination
    const samePolicy = snapshot?.workspace_id === selection.workspaceId
      && selected?.rootPolicyId === selection.rootPolicyId && selected.rootPolicyRevision === selection.rootPolicyRevision
    const row = snapshot && samePolicy ? snapshot.root_policy : (await sql.query<{ record: unknown; revoked_at: Date | null }>('select record,revoked_at from workspace_root_policies where root_policy_id=$1 and root_policy_revision=$2 and workspace_id=$3 for share', [selection.rootPolicyId, selection.rootPolicyRevision, selection.workspaceId])).rows[0]
    if (!row || row.revoked_at) throw new DomainError('ROOT_POLICY_UNAVAILABLE', 'The exact authorized root policy is missing or revoked.', 409)
    const policy = WorkspaceRootPolicySchema.parse(row.record), configuration = await this.configuration(sql, selection.hostRef)
    const registration = await this.hosts.authorize(sql, live.principal, selection.hostRef, policy.applicationInstallationId)
    if (!isDeepStrictEqual(policy.hostRef, selection.hostRef) || policy.locationRevision !== selection.locationRevision || policy.configurationRevision !== configuration.configurationRevision
      || !isDeepStrictEqual(policy.registration, registration) || !configuration.bases.some(base => base.baseId === policy.allowedBaseId && base.accessModes.includes(policy.accessMode)))
      throw new DomainError('ROOT_POLICY_CONFLICT', 'The accepted root no longer has current host/configuration authority.', 409)
    return policy // Exact history, independent of mutable current workspace selection.
  }
  async inspect(sql: Sql, principal: ManagementPrincipal, policy: WorkspaceRootPolicy): Promise<void> {
    const accepted = await this.resolve(sql, principal, policy)
    const allowlist = await this.configuration(sql, accepted.hostRef)
    const root: AuthorizedWorkspaceRoot = {
      selection: {
        workspaceId: accepted.workspaceId,
        hostRef: accepted.hostRef,
        allowedBaseId: accepted.allowedBaseId,
        configurationRevision: accepted.configurationRevision,
        relativePath: accepted.relativePath,
        accessMode: accepted.accessMode,
        expectedLocationRevision: Number(accepted.locationRevision),
        expectedRootPolicyRevision: Number(accepted.rootPolicyRevision),
      },
      allowlist,
      ownerPrincipalId: accepted.ownerPrincipalId,
      registration: accepted.registration,
    }
    this.actors.set(root, structuredClone(principal))
    const attestation = await this.attest(root)
    if (attestation.canonicalProjectRoot !== accepted.canonicalProjectRoot
      || !isDeepStrictEqual(attestation.filesystem, accepted.filesystem)
      || attestation.directoryIdentityHash !== accepted.directoryIdentityHash
      || !isDeepStrictEqual(attestation.runtimeFilesystem, accepted.runtimeFilesystem)) {
      throw new DomainError('ROOT_DIRECTORY_CHANGED', 'The saved folder changed. Select it again to save its new identity.', 409)
    }
    await this.resolve(sql, principal, accepted)
  }
  async read(sql: Sql, principal: ManagementPrincipal, workspaceId: string): Promise<WorkspaceRootPolicy[]> {
    await this.authorizeWorkspace(sql, principal, workspaceId)
    const rows = await sql.query<{ record: unknown }>(`select p.record from workspace_root_policy_heads h join workspace_root_policies p
      on p.root_policy_id=h.root_policy_id and p.root_policy_revision=h.root_policy_revision
      where h.workspace_id=$1 and p.revoked_at is null order by h.host_scope`, [workspaceId])
    return rows.rows.map(row => WorkspaceRootPolicySchema.parse(row.record)) // Metadata-only history; resolve fences every IO/continuation.
  }
}
