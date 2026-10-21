import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { ExecutionLocationSchema } from '@foreman-code/contracts'
import { WorkspaceRootListResultSchema, WorkspaceRootSelectionSchema, WorkspaceRootAttestationSchema, WorkspaceRootPolicySchema, WorkspaceLocationIdentitySchema, type WorkspaceRootSelection, type WorkspaceRootPolicy, type WorkspaceRootAttestation } from '@foreman-code/contracts/workspace-root-policies'
import { WorkspaceBoundLocationGetInputSchema, WorkspaceBoundLocationSetInputSchema, WorkspaceBoundLocationReadbackSchema,
  WorkspaceBoundLocationValidationSchema, WorkspaceBoundLocationBrowseResultSchema, type WorkspaceBoundLocationReadback, type WorkspaceBoundLocationSetInput } from '@foreman-code/contracts/workspace-bound-location'
import { WorkspaceRootConfigurationAdoptSchema } from '@foreman-code/contracts/workspace-bound-location'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { authorizeSource } from '../sources/authority.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK } from '../workspaces/projectFolderCleanup.js'
import type { AuthorizedWorkspaceRoot, WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'

type Sql = Pick<pg.PoolClient, 'query'>
interface LocationRow { execution_location: unknown; location_revision: string; archived_at: Date | null }
/** Workspace primary location and independent host roots share policy services. */
export class WorkspaceBoundLocationService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly roots: WorkspaceRootPolicyPort, private readonly localRunnerId = 'runner-local') {}

  private async authorize(sql: Sql, principal: ManagementPrincipal, action: ManagementAction, workspaceId: string) {
    requireAuthorization(principal, action, { workspaceId })
    const live = await readLiveManagementPrincipal(sql, principal.id)
    await authorizeSource(sql, principal, 'source_roots:read', workspaceId)
    requireAuthorization(principal, 'workspace_locations:read', { workspaceId })
    requireAuthorization(live, 'workspace_locations:read', { workspaceId })
    if (action !== 'workspace_locations:read') {
      requireAuthorization(principal, 'workspace_locations:validate', { workspaceId })
      requireAuthorization(live, 'workspace_locations:validate', { workspaceId })
    }
    if (action === 'workspace_locations:update') await authorizeSource(sql, principal, 'source_roots:bind', workspaceId)
    requireAuthorization(live, action, { workspaceId })
    return live
  }
  private async read<T>(principal: ManagementPrincipal, action: ManagementAction, workspaceId: string,
    work: (sql: Sql, live: ManagementPrincipal) => Promise<T>): Promise<T> {
    requireAuthorization(principal, action, { workspaceId })
    return withTransaction(this.pool, async (client) => {
      const live = await this.authorize(client, principal, action, workspaceId)
      const result = await work(client, live)
      await this.authorize(client, principal, action, workspaceId)
      return result
    })
  }
  async choices(principal: ManagementPrincipal, raw: unknown) {
    const { workspaceId } = WorkspaceBoundLocationGetInputSchema.parse(raw)
    return this.read(principal, 'workspace_locations:read', workspaceId,
      async (sql, live) => WorkspaceRootListResultSchema.parse(await this.roots.list(sql, live, workspaceId)))
  }
  async adopt(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    const input = WorkspaceRootConfigurationAdoptSchema.parse(raw)
    return this.commands.execute({ principal, source, operation: 'workspace.root.configuration.adopt', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:root-configuration`, payload: input,
      authorize: sql => this.authorize(sql, principal, 'workspace_locations:update', input.workspaceId).then(() => undefined),
      perform: async sql => {
        if (!this.roots.adopt) throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'Protected host configuration adoption is unavailable.', 409)
        return this.roots.adopt(sql, principal, input.workspaceId, input.hostRef)
      } })
  }
  private async prepare(principal: ManagementPrincipal, selection: WorkspaceRootSelection, action: ManagementAction) {
    const root = await this.read(principal, action, selection.workspaceId, (sql, live) => this.roots.authorize(sql, live, selection))
    this.assertRoot(root, selection)
    return root
  }
  private assertRoot(root: AuthorizedWorkspaceRoot, selection: WorkspaceRootSelection) {
    if (!sameWorkflowValue(root.selection, selection) || !sameWorkflowValue(root.allowlist.hostRef, selection.hostRef)
      || root.allowlist.configurationRevision !== selection.configurationRevision
      || !root.allowlist.bases.some(base => base.baseId === selection.allowedBaseId && base.accessModes.includes(selection.accessMode))
      || (selection.hostRef.kind === 'main' ? root.registration !== null || root.allowlist.applicationInstallationId !== selection.hostRef.mainId
        : root.registration?.workerInstallationId !== root.allowlist.applicationInstallationId)) {
      throw new DomainError('WORKSPACE_ROOT_BINDING_CONFLICT', 'Root authorization returned another target.', 409)
    }
  }
  private assertAttestation(root: AuthorizedWorkspaceRoot, attestation: ReturnType<typeof WorkspaceRootAttestationSchema.parse>) {
    const selection = root.selection
    if (!sameWorkflowValue(attestation.hostRef, selection.hostRef)
      || attestation.applicationInstallationId !== root.allowlist.applicationInstallationId
      || attestation.configurationRevision !== selection.configurationRevision
      || attestation.allowedBaseId !== selection.allowedBaseId || attestation.relativePath !== selection.relativePath
      || attestation.accessMode !== selection.accessMode || attestation.managedRuntimeRoot !== root.allowlist.managedRuntimeRoot) {
      throw new DomainError('WORKSPACE_ROOT_ATTESTATION_CONFLICT', 'Native attestation does not match the authorized target.', 409)
    }
  }
  async validate(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    const selection = WorkspaceRootSelectionSchema.parse(raw)
    try {
      const root = await this.prepare(principal, selection, 'workspace_locations:validate')
      const attestation = WorkspaceRootAttestationSchema.parse(await this.roots.attest(root))
      this.assertAttestation(root, attestation)
      await this.read(principal, 'workspace_locations:validate', selection.workspaceId, sql => this.roots.fence(sql, root))
      const result = WorkspaceBoundLocationValidationSchema.parse({ workspaceId: selection.workspaceId, selection, attestation, checkedAt: new Date().toISOString() })
      await this.commands.recordAudit(principal.id, source, 'workspace.location.validate', `workspace:${selection.workspaceId}`, 'succeeded', { hostRef: selection.hostRef, allowedBaseId: selection.allowedBaseId })
      return result
    } catch (error) {
      await this.commands.recordAudit(principal.id, source, 'workspace.location.validate', `workspace:${selection.workspaceId}`, 'failed', { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
      throw error
    }
  }
  async browse(principal: ManagementPrincipal, raw: unknown) {
    const selection = WorkspaceRootSelectionSchema.parse(raw)
    const root = await this.prepare(principal, selection, 'workspace_locations:validate')
    const browse = await this.roots.browse(root, selection.relativePath)
    if (browse.relativePath !== selection.relativePath) throw new DomainError('WORKSPACE_ROOT_ATTESTATION_CONFLICT', 'Native browse returned another target.', 409)
    await this.read(principal, 'workspace_locations:validate', selection.workspaceId, sql => this.roots.fence(sql, root))
    return WorkspaceBoundLocationBrowseResultSchema.parse({ workspaceId: selection.workspaceId, selection, browse })
  }
  private projection(policy: WorkspaceRootPolicy) {
    return ExecutionLocationSchema.parse({ runnerId: policy.hostRef.kind === 'main' ? this.localRunnerId : policy.applicationInstallationId, rootPath: policy.canonicalProjectRoot })
  }
  async get(principal: ManagementPrincipal, raw: unknown): Promise<WorkspaceBoundLocationReadback> {
    const { workspaceId } = WorkspaceBoundLocationGetInputSchema.parse(raw)
    return this.read(principal, 'workspace_locations:read', workspaceId, async (sql, live) => {
      const row = (await sql.query<LocationRow>('select execution_location,location_revision::text,archived_at from workspaces where id=$1 for share', [workspaceId])).rows[0]
      if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404)
      const locationRevision = Number(row.location_revision)
      if (!row.execution_location) return WorkspaceBoundLocationReadbackSchema.parse({ evidence: 'unconfigured', workspaceId, locationRevision, executionLocation: null })
      const executionLocation = ExecutionLocationSchema.parse(row.execution_location)
      const policies = (await this.roots.read(sql, live, workspaceId))
        .filter(policy => policy.bindingPurpose !== 'ci-enrollment' && policy.locationRevision === row.location_revision
          && this.projection(policy).runnerId === executionLocation.runnerId)
      if (!policies.length) return WorkspaceBoundLocationReadbackSchema.parse({ evidence: 'legacy_missing', workspaceId, locationRevision, executionLocation })
      const binding = policies[0]!
      if (policies.length !== 1 || binding.workspaceId !== workspaceId || !sameWorkflowValue(this.projection(binding), executionLocation)) {
        throw new DomainError('WORKSPACE_ROOT_BINDING_CONFLICT', 'Persisted workspace location and root binding disagree.', 409)
      }
      return WorkspaceBoundLocationReadbackSchema.parse({ evidence: 'bound', workspaceId, locationRevision, executionLocation, binding })
    })
  }
  private acceptedReceipt(raw: unknown, input: WorkspaceBoundLocationSetInput): WorkspaceBoundLocationReadback {
    const value = WorkspaceBoundLocationReadbackSchema.parse(raw)
    if (value.evidence !== 'bound' || value.workspaceId !== input.workspaceId || value.locationRevision !== input.expectedLocationRevision + (input.hostRef.kind === 'main' ? 1 : 0)
      || value.binding.workspaceId !== input.workspaceId || value.binding.locationRevision !== String(value.locationRevision)
      || value.binding.rootPolicyRevision !== String(input.expectedRootPolicyRevision + 1)
      || !sameWorkflowValue(value.binding.hostRef, input.hostRef) || value.binding.allowedBaseId !== input.allowedBaseId
      || value.binding.configurationRevision !== input.configurationRevision || value.binding.relativePath !== input.relativePath
      || value.binding.accessMode !== input.accessMode || !sameWorkflowValue(this.projection(value.binding), value.executionLocation)) {
      throw new DomainError('WORKSPACE_ROOT_RECEIPT_CONFLICT', 'The stored location receipt does not match the exact accepted command.', 409)
    }
    return value
  }
  async set(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    const input = WorkspaceBoundLocationSetInputSchema.parse(raw)
    const { commandId, ...selection } = input
    let prepared: { root: AuthorizedWorkspaceRoot; attestation: WorkspaceRootAttestation }
    return this.commands.execute({ principal, source, operation: 'workspace.location.set', commandId,
      targetKey: `workspace:${input.workspaceId}:location`, payload: input,
      resourceLock: WORKSPACE_FOLDER_LIFECYCLE_LOCK,
      authorize: sql => this.authorize(sql, principal, 'workspace_locations:update', input.workspaceId).then(() => undefined),
      replayResult: raw => this.acceptedReceipt(raw, input),
      prepare: async () => {
        const root = await this.prepare(principal, selection, 'workspace_locations:update')
        const attestation = WorkspaceRootAttestationSchema.parse(await this.roots.attest(root))
        this.assertAttestation(root, attestation)
        prepared = { root, attestation }
      },
      perform: async sql => {
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.workspaceId}`])
        const row = (await sql.query<LocationRow>('select execution_location,location_revision::text,archived_at from workspaces where id=$1 for update', [input.workspaceId])).rows[0]
        if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404)
        if (row.archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot change execution location.', 409)
        if (row.location_revision !== String(input.expectedLocationRevision)) throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was read.', 409, { currentLocationRevision: Number(row.location_revision) })
        const live = await this.authorize(sql, principal, 'workspace_locations:update', input.workspaceId)
        const root = await this.roots.authorize(sql, live, selection)
        this.assertRoot(root, selection)
        await this.roots.fence(sql, root)
        if (!sameWorkflowValue(root, prepared.root)) {
          throw new DomainError('WORKSPACE_ROOT_BINDING_CONFLICT', 'Root authorization changed during attestation.', 409)
        }
        // The command's session lock excludes folder cleanup while attestation runs outside SQL.
        const { attestation } = prepared
        this.assertAttestation(root, attestation)
        await this.authorize(sql, principal, 'workspace_locations:update', input.workspaceId)
        const nextRevision = input.expectedLocationRevision + (selection.hostRef.kind === 'main' ? 1 : 0)
        const executionLocation = ExecutionLocationSchema.parse({ runnerId: selection.hostRef.kind === 'main' ? this.localRunnerId : root.allowlist.applicationInstallationId, rootPath: attestation.canonicalProjectRoot })
        if (selection.hostRef.kind === 'main') {
          const updated = await sql.query(`update workspaces set execution_location=$2::jsonb,execution_location_identity=$3::jsonb,location_revision=$4 where id=$1 and location_revision=$5`,
            [input.workspaceId, JSON.stringify(executionLocation), JSON.stringify(WorkspaceLocationIdentitySchema.parse({ ...attestation.filesystem, hostRef: attestation.hostRef, applicationInstallationId: attestation.applicationInstallationId, directoryIdentityHash: attestation.directoryIdentityHash })), nextRevision, input.expectedLocationRevision])
          if (updated.rowCount !== 1) throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed during binding.', 409)
        }
        const binding = WorkspaceRootPolicySchema.parse(await this.roots.bind(sql, principal, root, attestation, nextRevision))
        if (binding.workspaceId !== input.workspaceId || binding.locationRevision !== String(nextRevision) || !sameWorkflowValue(this.projection(binding), executionLocation)
          || !sameWorkflowValue(binding.hostRef, attestation.hostRef) || binding.allowedBaseId !== selection.allowedBaseId
          || binding.configurationRevision !== selection.configurationRevision || binding.relativePath !== selection.relativePath
          || binding.accessMode !== selection.accessMode || binding.attestationId !== attestation.attestationId
          || binding.attestationDigest !== attestation.attestationDigest || binding.directoryIdentityHash !== attestation.directoryIdentityHash
          || !sameWorkflowValue(binding.registration, root.registration)) throw new DomainError('WORKSPACE_ROOT_BINDING_CONFLICT', 'Root binding changed the accepted location.', 409)
        await this.authorize(sql, principal, 'workspace_locations:update', input.workspaceId)
        return WorkspaceBoundLocationReadbackSchema.parse({ evidence: 'bound', workspaceId: input.workspaceId, locationRevision: nextRevision, executionLocation, binding })
      },
    })
  }
}
