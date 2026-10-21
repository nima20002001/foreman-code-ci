import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  ApprovedRootAllowlistSchema, WorkspaceRootAttestationSchema, WorkspaceRootBrowseResultSchema,
  type ApprovedRootAllowlist, type WorkspaceRootPolicy, type WorkspaceRootWorkerRequest,
} from '@foreman-code/contracts/workspace-root-policies'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { SourceError } from './manifest.js'
import { attestWorkspaceRoot, browseApprovedRoot, attestSourceNamespace, prepareManagedWorkspaceRoot } from './rootAttestation.js'
import type { AuthorizedWorkspaceRoot, WorkspaceRootHostPort } from './rootPolicyPorts.js'

export interface RootWorkerClient {
  /** W07 existing selected-main authenticated carrier; namespace/version/payload
   * budgets are WORKSPACE_ROOT_EXTENSION, not a second connection system. */
  request(host: ApprovedRootAllowlist['hostRef'], registration: NonNullable<WorkspaceRootPolicy['registration']>, request: WorkspaceRootWorkerRequest): Promise<unknown>
}
const rootFailures: Record<string, { status: number; message: string }> = {
  ROOT_DIRECTORY_MISSING: { status: 409, message: 'The selected folder does not exist on this computer.' },
  ROOT_RELATIVE_PATH_INVALID: { status: 422, message: 'Choose an unambiguous folder relative to an approved base.' },
  ROOT_ACCESS_DENIED: { status: 403, message: 'The selected folder or access mode is not approved on this computer.' },
  ROOT_CONFIGURATION_CONFLICT: { status: 409, message: 'The approved computer folder configuration changed. Reload it.' },
  ROOT_BASE_CHANGED: { status: 409, message: 'The approved base folder was replaced. Its owner must approve it again.' },
  ROOT_DIRECTORY_CHANGED: { status: 409, message: 'The selected folder changed. Reload and select it again.' },
  ROOT_RUNTIME_CHANGED: { status: 409, message: 'The app runtime folder changed. Restore its approved configuration.' },
  ROOT_FILESYSTEM_UNSUPPORTED: { status: 422, message: 'The selected folder must be owned and protected on the approved filesystem.' },
  ROOT_RUNTIME_OVERLAP: { status: 422, message: 'The project folder and app runtime folder must be separate.' },
  SOURCE_ROOT_NOT_PRIVATE: { status: 422, message: 'The approved folder must be owned and protected on this computer.' },
  SOURCE_ROOT_CHANGED: { status: 409, message: 'The approved folder changed during validation. Reload it.' },
  SOURCE_FILESYSTEM_UNSUPPORTED: { status: 422, message: 'The approved folder requires a supported protected filesystem.' },
  EACCES: { status: 422, message: 'The selected folder is not accessible on this computer.' },
  EPERM: { status: 422, message: 'The selected folder is not accessible on this computer.' },
  ELOOP: { status: 422, message: 'Choose a folder without symbolic links.' },
  ENOENT: { status: 422, message: 'An approved project or runtime folder no longer exists on this computer.' },
  ENOTDIR: { status: 422, message: 'Choose a directory on this computer.' },
  unavailable: { status: 503, message: 'The selected computer is unavailable. Reconnect it and retry.' },
  timeout: { status: 503, message: 'The selected computer did not respond. Reconnect it and retry.' },
  transport: { status: 503, message: 'The connection to the selected computer was interrupted. Reconnect it and retry.' },
}
async function publicRootFailure<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) {
    if (error instanceof DomainError && !(error instanceof SourceError)) throw error
    const code = error instanceof SourceError || error instanceof DeviceApplicationError
      ? error.code : (error as NodeJS.ErrnoException | undefined)?.code
    const failure = code && Object.hasOwn(rootFailures, code) ? rootFailures[code] : undefined
    if (failure && code) {
      throw new DomainError(code, failure.message, failure.status, undefined, { cause: error })
    }
    throw error
  }
}
export class InstalledWorkspaceRootHosts implements WorkspaceRootHostPort {
  constructor(private readonly main: ApprovedRootAllowlist,
    private readonly authorizeInstallation: (sql: GraphSqlClient, principal: ManagementPrincipal,
      host: ApprovedRootAllowlist['hostRef'], installationId: string) => Promise<WorkspaceRootPolicy['registration']>,
    private readonly remote: RootWorkerClient) { this.main = ApprovedRootAllowlistSchema.parse(structuredClone(main)) }
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal, host: ApprovedRootAllowlist['hostRef'], installationId: string) {
    return this.authorizeInstallation(sql, principal, host, installationId)
  }
  async configurations(sql: GraphSqlClient, _workspaceId: string): Promise<ApprovedRootAllowlist[]> {
    void _workspaceId
    const rows = await sql.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
      join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
      where c.main_id=$1 order by h.host_scope`, [this.main.hostRef.mainId])
    return rows.rows.map(row => ApprovedRootAllowlistSchema.parse(row.record))
  }
  private local(root: AuthorizedWorkspaceRoot): void {
    if (root.selection.hostRef.kind !== 'main' || root.selection.hostRef.mainId !== this.main.hostRef.mainId
      || root.allowlist.applicationInstallationId !== this.main.applicationInstallationId || root.allowlist.configurationRevision !== this.main.configurationRevision)
      throw new DomainError('ROOT_INSTALLATION_CONFLICT', 'The selected root does not belong to the approved main installation.', 409)
  }
  async attest(root: AuthorizedWorkspaceRoot) {
    if (root.selection.hostRef.kind === 'main') { this.local(root); return publicRootFailure(() => attestWorkspaceRoot(this.main, root.selection)) }
    if (!root.registration) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no current approved registration.', 409)
    const registration = root.registration
    return WorkspaceRootAttestationSchema.parse(await publicRootFailure(() => this.remote.request(root.selection.hostRef, registration,
      { version: 1, operation: 'workspace-roots.attest', selection: root.selection })))
  }
  async prepareManaged(root: AuthorizedWorkspaceRoot) {
    if (root.selection.hostRef.kind === 'main') {
      this.local(root)
      return publicRootFailure(() => prepareManagedWorkspaceRoot(this.main, root.selection))
    }
    if (!root.registration) {
      throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no current approved registration.', 409)
    }
    const registration = root.registration
    return WorkspaceRootAttestationSchema.parse(await publicRootFailure(() => this.remote.request(
      root.selection.hostRef, registration,
      { version: 1, operation: 'workspace-roots.prepare-managed', selection: root.selection })))
  }
  async browse(root: AuthorizedWorkspaceRoot, relativePath: string) {
    if (root.selection.hostRef.kind === 'main') { this.local(root); return publicRootFailure(() => browseApprovedRoot(this.main, root.selection, relativePath)) }
    if (!root.registration) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no current approved registration.', 409)
    const registration = root.registration
    return WorkspaceRootBrowseResultSchema.parse(await publicRootFailure(() => this.remote.request(root.selection.hostRef, registration,
      { version: 1, operation: 'workspace-roots.browse', selection: root.selection, relativePath })))
  }
  async sourceNamespace(policy: WorkspaceRootPolicy, _rootId: string) {
    void _rootId
    if (policy.hostRef.kind === 'main') {
      if (policy.hostRef.mainId !== this.main.hostRef.mainId || policy.applicationInstallationId !== this.main.applicationInstallationId)
        throw new DomainError('ROOT_INSTALLATION_CONFLICT', 'Source namespace belongs to another main.', 409)
      return publicRootFailure(() => attestSourceNamespace(this.main, policy))
    }
    if (!policy.registration) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected device has no approved source namespace registration.', 409)
    const registration = policy.registration
    const value = await publicRootFailure(() => this.remote.request(policy.hostRef, registration,
      { version: 1, operation: 'workspace-roots.source-namespace', policy }))
    // The source binding service validates canonical path, filesystem and digest
    // through its strict persisted root schema after host authority fences.
    return value as Awaited<ReturnType<typeof attestSourceNamespace>>
  }
}
