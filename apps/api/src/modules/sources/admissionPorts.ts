import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ApprovedSource, ApprovedSourcePin, SourceRootRecord, SourceRootSelection, SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@foreman-code/contracts/source-admission'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { MaterializationAttempt } from './ports.js'

export interface AuthorizedSourceRoot {
  workspaceId: string; selection: SourceRootSelection; ownerPrincipalId: string
  mainId: string; deviceId: string | null; workerInstallationId: string | null
  /** Registered app-owned runtime namespace, never the user's source directory. */
  canonicalPath: string; authorizationRevision: number | null; keyRevision: number | null
}
/** Existing workspace/host/root catalog MUST authorize before any path probe.
 * Host I/O runs outside SQL; fence only rechecks persisted live authority.
 */
export interface RegisteredSourceRootPort {
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal,
    input: { workspaceId: string; selection: SourceRootSelection; accessMode: RootBinding['accessMode'] }): Promise<AuthorizedSourceRoot>
  attest(root: AuthorizedSourceRoot): Promise<{ canonicalPath: string; filesystem: RootBinding['filesystem']; attestationId: string; attestationDigest: string }>
  fence(sql: GraphSqlClient, root: AuthorizedSourceRoot): Promise<void>
}
export interface SourceAdmissionPort {
  bindRoot(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; commandId: string; expectedBindingRevision: number
    source: ApprovedSourcePin; selection: SourceRootSelection; accessMode: RootBinding['accessMode']
  }): Promise<{ value: SourceRootRecord }>
  prepareRunSources(principal: ManagementPrincipal, input: {
    workspaceId: string; commandId: string; source: 'http' | 'mcp'; roots: readonly SourceRootRecord[]
  }): Promise<readonly SourceRootRecord[]>
  resolveApprovedSource(sql: GraphSqlClient, principal: ManagementPrincipal,
    workspaceId: string, pin: ApprovedSourcePin): Promise<ApprovedSource>
  resolveRootBinding(sql: GraphSqlClient, principal: ManagementPrincipal,
    input: { workspaceId: string; rootId: string; bindingRevision: number; source: ApprovedSourcePin }): Promise<SourceRootRecord>
  /** The caller allocates the real execution/attempt first; no synthetic Run or Agent. */
  prepareExecution(input: { principal: ManagementPrincipal; workspaceId: string; rootId: string; bindingRevision: number;
    source: ApprovedSourcePin; attempt: MaterializationAttempt; operationId: string }): Promise<SourceMaterializationRecord>
  verifyWorkingDirectory(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord; relativeCwd: string }): Promise<VerifiedSourceWorkingTree>
  verifyPreparation(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord }): Promise<string>
  verifyExecution(input: { principal: ManagementPrincipal; record: SourceMaterializationRecord }): Promise<string>
}
export interface SourceClosureProofPort {
  /** Actual original W08 operation/attempt physical closure plus main projection.
   * A disconnect, lease timeout, PID absence or expiry is never closure proof.
   */
  confirmedClosed(record: SourceMaterializationRecord): Promise<boolean>
}
