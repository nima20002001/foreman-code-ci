export { requiredLocationAccess } from './locationAccess.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { access, mkdir, realpath, rmdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import {
  ExecutionLocationSchema,
  RunExecutionLocationSchema,
  type RunExecutionLocation,
} from '@foreman-code/contracts'
import {
  WorkspaceLocationValidationSchema,
  type ManagementPrincipal,
  type WorkspaceLocationAccessMode,
  type WorkspaceLocationSetInput,
  type WorkspaceLocationValidateInput,
} from '@foreman-code/contracts/management'
import type pg from 'pg'
import { WorkspaceLocationIdentitySchema } from '@foreman-code/contracts/workspace-root-policies'

import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { canonicalRuntimePath, pathsOverlap, withFilesystemDeadline } from './filesystem.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK } from './projectFolderCleanup.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'

export const LOCAL_RUNNER_ID = 'runner-local'

interface LocationIdentity { device: string; inode: string }
interface LocationRow {
  execution_location: unknown | null
  execution_location_identity: unknown | null
  location_revision: string
  archived_at: Date | null
}

function identityHash(identity: LocationIdentity): string {
  return `sha256:${createHash('sha256').update(`${identity.device}:${identity.inode}`).digest('hex')}`
}

function locationError(error: unknown, rootPath: string): DomainError {
  if (error instanceof DomainError) return error
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  if (code === 'ENOENT') return new DomainError('WORKSPACE_LOCATION_NOT_FOUND', `Directory '${rootPath}' does not exist on the selected runner.`, 422)
  if (code === 'ENOTDIR') return new DomainError('WORKSPACE_LOCATION_NOT_DIRECTORY', `Path '${rootPath}' is not a directory on the selected runner.`, 422)
  if (code === 'EACCES' || code === 'EPERM') return new DomainError('WORKSPACE_LOCATION_INACCESSIBLE', `Directory '${rootPath}' is not accessible to the local runner.`, 422)
  return new DomainError('WORKSPACE_LOCATION_UNAVAILABLE', `Directory '${rootPath}' could not be validated on the local runner.`, 422)
}

export class WorkspaceLocationService {
  private readonly managedRuntimeRoot: string | undefined
  private rootPolicies: WorkspaceRootPolicyPort | undefined

  constructor(
    private readonly pool: pg.Pool,
    private readonly commands: PostgresCommandCoordinator,
    managedRuntimeRoot?: string,
    readonly runnerId = LOCAL_RUNNER_ID,
  ) {
    this.managedRuntimeRoot = managedRuntimeRoot ? resolve(managedRuntimeRoot) : undefined
  }

  setRootPolicies(policies: WorkspaceRootPolicyPort): void {
    this.rootPolicies = policies
  }

  async createProjectFolder(principal: ManagementPrincipal, workspaceId: string, parentPath: string, name: string,
    provisioning?: { create(path: string): Promise<void> }) {
    requireAuthorization(principal, 'workspace_locations:provision', { workspaceId })
    requireAuthorization(principal, 'workspace_locations:update', { workspaceId })
    requireAuthorization(principal, 'workspace_locations:read', { workspaceId })
    if (!name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\\')
      || Array.from(name).some((character) => character.charCodeAt(0) < 32)) {
      throw new DomainError('WORKSPACE_FOLDER_NAME_INVALID', 'Use a workspace name without slashes or control characters.', 400)
    }
    const parent = await this.validatePath(workspaceId, this.runnerId, parentPath, 'read-write')
    const path = resolve(parent.validation.location.rootPath, name)
    try {
      if (provisioning) await provisioning.create(path)
      else await mkdir(path)
    } catch (error) {
      if (error instanceof DomainError) throw error
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DomainError('WORKSPACE_FOLDER_EXISTS', 'A folder with this name already exists. Choose another name or location.', 409, undefined, { cause: error })
      }
      throw locationError(error, path)
    }
    try { return await this.validatePath(workspaceId, this.runnerId, path, 'read-write') }
    catch (error) {
      if (!provisioning) await rmdir(path)
      throw error
    }
  }

  private async validatePath(
    workspaceId: string,
    runnerId: string,
    rootPath: string,
    accessMode: WorkspaceLocationAccessMode,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    if (runnerId !== this.runnerId) {
      throw new DomainError('RUNNER_UNSUPPORTED', `Runner '${runnerId}' is not supported by this API instance.`, 400)
    }
    if (rootPath.includes('\0')) {
      throw new DomainError('WORKSPACE_LOCATION_INVALID', 'The workspace location contains an invalid NUL character.', 400)
    }
    if (!isAbsolute(rootPath)) {
      throw new DomainError('WORKSPACE_LOCATION_NOT_ABSOLUTE', 'The workspace location must be an absolute runner path.', 400)
    }
    try {
      return await withFilesystemDeadline(async (check) => {
        const canonicalPath = await check(() => realpath(rootPath))
        if (this.managedRuntimeRoot) {
          const runtimePath = await canonicalRuntimePath(this.managedRuntimeRoot, check)
          if (pathsOverlap(canonicalPath, runtimePath)) {
            throw new DomainError(
              'WORKSPACE_LOCATION_RUNTIME_OVERLAP',
              'The project directory and Foreman Code-managed runtime storage must not contain one another.',
              422,
            )
          }
        }
        const details = await check(() => stat(canonicalPath, { bigint: true }))
        if (!details.isDirectory()) {
          throw new DomainError('WORKSPACE_LOCATION_NOT_DIRECTORY', `Path '${rootPath}' is not a directory on the selected runner.`, 422)
        }
        await check(() => access(canonicalPath, constants.R_OK | constants.X_OK | (accessMode === 'read-write' ? constants.W_OK : 0)))
        const location = ExecutionLocationSchema.parse({ runnerId, rootPath: canonicalPath })
        const identity: LocationIdentity = { device: String(details.dev), inode: String(details.ino) }
        return {
          validation: WorkspaceLocationValidationSchema.parse({
            workspaceId, location, accessMode, checkedAt: new Date().toISOString(),
          }),
          identity,
        }
      }, signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw locationError(error, rootPath)
    }
  }

  async validate(
    principal: ManagementPrincipal,
    source: 'http' | 'mcp',
    input: WorkspaceLocationValidateInput,
  ) {
    requireAuthorization(principal, 'workspace_locations:validate', { workspaceId: input.workspaceId })
    const workspace = await this.pool.query<{ archived_at: Date | null }>(
      'select archived_at from workspaces where id = $1', [input.workspaceId],
    )
    if (!workspace.rows[0]) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${input.workspaceId}' was not found.`, 404)
    if (workspace.rows[0].archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot validate a new execution location.', 409)
    try {
      const result = (await this.validatePath(input.workspaceId, input.runnerId, input.rootPath, input.accessMode)).validation
      await this.commands.recordAudit(principal.id, source, 'workspace.location.validate', `workspace:${input.workspaceId}`, 'succeeded', {
        runnerId: input.runnerId, accessMode: input.accessMode,
      })
      return result
    } catch (error) {
      await this.commands.recordAudit(principal.id, source, 'workspace.location.validate', `workspace:${input.workspaceId}`, 'failed', {
        runnerId: input.runnerId, code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
      })
      throw error
    }
  }

  async set(
    principal: ManagementPrincipal,
    source: 'http' | 'mcp',
    input: WorkspaceLocationSetInput,
  ) {
    requireAuthorization(principal, 'workspace_locations:update', { workspaceId: input.workspaceId })
    return this.commands.execute({
      principal, source, operation: 'workspace.location.set', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:location`, payload: input,
      authorize: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.workspaceId}`])
        await client.query('select id from workspaces where id = $1 for update', [input.workspaceId])
        const live = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(live, 'workspace_locations:update', { workspaceId: input.workspaceId })
      },
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.workspaceId}`])
        const current = await client.query<LocationRow>(
          `select execution_location, execution_location_identity, location_revision, archived_at
           from workspaces where id = $1 for update`, [input.workspaceId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${input.workspaceId}' was not found.`, 404)
        if (row.archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot change execution location.', 409)
        const revision = Number(row.location_revision)
        if (revision !== input.expectedLocationRevision) {
          throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was read.', 409, { currentLocationRevision: revision })
        }
        const modern = await client.query(
          'select 1 from workspace_root_policy_heads where workspace_id=$1 limit 1', [input.workspaceId],
        )
        if (modern.rows.length) {
          throw new DomainError('WORKSPACE_ROOT_BINDING_REQUIRED',
            'This workspace uses approved computer roots. Change its folder through the root location settings.', 409)
        }
        let folderPath: string
        try { folderPath = await withFilesystemDeadline((check) => check(() => realpath(input.rootPath))) }
        catch (error) { throw locationError(error, input.rootPath) }
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${folderPath}`])
        const accepted = await this.validatePath(input.workspaceId, input.runnerId, input.rootPath, 'read-only')
        const nextRevision = revision + 1
        await client.query(
          `update workspaces set execution_location = $2::jsonb, execution_location_identity = $3::jsonb,
             location_revision = $4 where id = $1`,
          [input.workspaceId, JSON.stringify(accepted.validation.location), JSON.stringify(accepted.identity), nextRevision],
        )
        return {
          workspaceId: input.workspaceId,
          executionLocation: accepted.validation.location,
          locationRevision: nextRevision,
          validation: accepted.validation,
        }
      },
    })
  }

  /** Internal transaction seam for controlled provisioning; never accepts caller filesystem input over MCP. */
  async assignProvisioned(client: pg.PoolClient, principal: ManagementPrincipal, input: WorkspaceLocationSetInput) {
    requireAuthorization(principal, 'workspace_locations:provision', {workspaceId: input.workspaceId})
    requireAuthorization(principal, 'workspace_locations:update', {workspaceId: input.workspaceId})
    const accepted = await this.validatePath(input.workspaceId, input.runnerId, input.rootPath, 'read-only')
    const result = await client.query(
      `update workspaces set execution_location=$2::jsonb,execution_location_identity=$3::jsonb,location_revision=location_revision+1
       where id=$1 and location_revision=$4 and archived_at is null and execution_location is null`,
      [input.workspaceId, JSON.stringify(accepted.validation.location), JSON.stringify(accepted.identity), input.expectedLocationRevision],
    )
    if (result.rowCount !== 1) throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed during provisioning.', 409)
    return {workspaceId: input.workspaceId, executionLocation: accepted.validation.location, locationRevision: input.expectedLocationRevision + 1}
  }

  async inspectionSnapshot(workspaceId: string, signal?: AbortSignal): Promise<RunExecutionLocation> {
    signal?.throwIfAborted()
    const snapshot = await withTransaction(this.pool, async (client) => {
      const rows = await client.query<{ location_revision: string }>(
        'select location_revision from workspaces where id=$1 for update', [workspaceId],
      )
      if (!rows.rows[0]) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
      return this.snapshot(client, workspaceId, Number(rows.rows[0].location_revision), 'read-only', signal)
    })
    await this.revalidateSnapshot(workspaceId, snapshot, 'read-only', signal)
    return snapshot
  }

  async snapshot(
    client: GraphSqlClient,
    workspaceId: string,
    expectedLocationRevision: number,
    accessMode: WorkspaceLocationAccessMode,
    signal?: AbortSignal,
  ): Promise<RunExecutionLocation> {
    const snapshot = await this.snapshotAssigned(client, workspaceId, expectedLocationRevision, signal)
    const current = await this.validatePath(workspaceId, snapshot.runnerId, snapshot.rootPath, accessMode, signal)
    if (identityHash(current.identity) !== snapshot.identityHash) {
      throw new DomainError('WORKSPACE_LOCATION_CHANGED', 'The selected directory was replaced after it was saved. Validate and save it again.', 409)
    }
    return snapshot
  }

  /** Records the workspace selection for a Run whose complete Agent placement
   * admission validates execution directories through their owning hosts. */
  async snapshotAssigned(
    client: GraphSqlClient,
    workspaceId: string,
    expectedLocationRevision: number,
    signal?: AbortSignal,
  ): Promise<RunExecutionLocation> {
    signal?.throwIfAborted()
    const result = await client.query<LocationRow>(
      `select execution_location, execution_location_identity, location_revision, archived_at
       from workspaces where id = $1 for update`, [workspaceId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, 404)
    if (row.archived_at) throw new DomainError('PARENT_ARCHIVED', 'Archived workspaces cannot start new runs.', 409)
    const revision = Number(row.location_revision)
    if (revision !== expectedLocationRevision) {
      throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was selected.', 409, { currentLocationRevision: revision })
    }
    if (!row.execution_location || !row.execution_location_identity) {
      throw new DomainError('WORKSPACE_LOCATION_UNCONFIGURED', 'Set a valid workspace execution location before starting a run.', 409)
    }
    const location = ExecutionLocationSchema.parse(row.execution_location)
    const storedIdentity = WorkspaceLocationIdentitySchema.parse(row.execution_location_identity)
    signal?.throwIfAborted()
    return RunExecutionLocationSchema.parse({ ...location, locationRevision: revision, identityHash: identityHash(storedIdentity) })
  }

  async revalidateSnapshot(
    workspaceId: string,
    snapshot: RunExecutionLocation,
    accessMode: WorkspaceLocationAccessMode,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.validatePath(workspaceId, snapshot.runnerId, snapshot.rootPath, accessMode, signal)
    if (identityHash(current.identity) !== snapshot.identityHash) {
      throw new DomainError('WORKSPACE_LOCATION_CHANGED', 'The Run directory is no longer the accepted directory.', 409)
    }
  }

  async revalidateRunAuthorization(
    principalId: string,
    workspaceId: string,
    workflowId: string,
    client?: GraphSqlClient,
    atCommit = false,
  ): Promise<void> {
    // Preserve the accepted ceiling and live root owner without acquiring a nested connection.
    try {
      const { principal } = await currentOperatorAuthority(client ?? this.pool, principalId, atCommit)
      requireAuthorization(principal, 'runs:start', { workspaceId, workflowId })
      requireAuthorization(principal, 'workspace_locations:read', { workspaceId })
    } catch (error) {
      const denied = error instanceof DomainError && (error.status === 401 || error.status === 403)
        && (error.code.startsWith('AUTH_') || error.code === 'ACCESS_DENIED')
      if (!denied) {
        throw error
      }
      throw new DomainError('RUN_AUTHORIZATION_REVOKED', 'The authority that accepted this Run is no longer valid.', 403, undefined, { cause: error })
    }
  }

  async inspect(principal: ManagementPrincipal, workspaceId: string, client: GraphSqlClient = this.pool) {
    requireAuthorization(principal, 'workspace_locations:read', { workspaceId })
    const result = await client.query<LocationRow>(
      `select execution_location, execution_location_identity, location_revision, archived_at
       from workspaces where id = $1`, [workspaceId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, 404)
    return this.inspectRow(principal, workspaceId, row, client)
  }

  async inspectMany(principal: ManagementPrincipal, workspaceIds: string[]) {
    for (const workspaceId of workspaceIds) requireAuthorization(principal, 'workspace_locations:read', { workspaceId })
    const result = await this.pool.query<LocationRow & { id: string }>(
      `select id, execution_location, execution_location_identity, location_revision, archived_at
       from workspaces where id = any($1::text[])`, [workspaceIds],
    )
    return new Map(await Promise.all(result.rows.map(async (row) =>
      [row.id, await this.inspectRow(principal, row.id, row, this.pool)] as const)))
  }

  private async inspectRow(principal: ManagementPrincipal, workspaceId: string, row: LocationRow, sql: GraphSqlClient) {
    const locationRevision = Number(row.location_revision)
    if (!row.execution_location) return { executionLocation: null, locationRevision, locationValidation: { status: 'unconfigured' as const } }
    const executionLocation = ExecutionLocationSchema.parse(row.execution_location)
    if (!row.execution_location_identity) {
      return {
        executionLocation, locationRevision,
        locationValidation: {
          status: 'unavailable' as const, checkedAt: new Date().toISOString(),
          error: { code: 'WORKSPACE_LOCATION_IDENTITY_MISSING', message: 'Validate and save this legacy location again before starting a run.' },
        },
      }
    }
    try {
      const modern = WorkspaceLocationIdentitySchema.safeParse(row.execution_location_identity)
      if (modern.success && 'hostRef' in modern.data) {
        if (!this.rootPolicies) throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'Computer root inspection is unavailable.', 503)
        const policies = await this.rootPolicies.read(sql, principal, workspaceId)
        const current = policies.filter(policy => policy.bindingPurpose !== 'ci-enrollment'
          && policy.locationRevision === String(locationRevision)
          && (policy.hostRef.kind === 'main' ? this.runnerId : policy.applicationInstallationId) === executionLocation.runnerId)
        const policy = current[0]
        if (current.length !== 1 || !policy || policy.canonicalProjectRoot !== executionLocation.rootPath
          || (policy.hostRef.kind === 'main' ? this.runnerId : policy.applicationInstallationId) !== executionLocation.runnerId
          || policy.directoryIdentityHash !== modern.data.directoryIdentityHash
          || !isDeepStrictEqual(policy.hostRef, modern.data.hostRef)
          || policy.applicationInstallationId !== modern.data.applicationInstallationId
          || policy.filesystem.device !== modern.data.device || policy.filesystem.inode !== modern.data.inode
          || policy.filesystem.mountId !== modern.data.mountId) {
          throw new DomainError('WORKSPACE_ROOT_BINDING_CONFLICT', 'Saved location and computer root binding disagree.', 409)
        }
        await this.rootPolicies.inspect(sql, principal, policy)
      } else {
        await this.revalidateSnapshot(workspaceId, RunExecutionLocationSchema.parse({
          ...executionLocation,
          locationRevision,
          identityHash: identityHash(row.execution_location_identity as LocationIdentity),
        }), 'read-only')
      }
      return { executionLocation, locationRevision, locationValidation: { status: 'ready' as const, checkedAt: new Date().toISOString() } }
    } catch (error) {
      const domain = locationError(error, executionLocation.rootPath)
      return {
        executionLocation, locationRevision,
        locationValidation: {
          status: 'unavailable' as const, checkedAt: new Date().toISOString(),
          error: { code: domain.code, message: domain.message },
        },
      }
    }
  }
}
