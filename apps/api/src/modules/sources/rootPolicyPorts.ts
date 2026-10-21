import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ApprovedRootAllowlist, WorkspaceRootSelection, WorkspaceRootPolicy, WorkspaceRootAttestation, WorkspaceRootBrowseResult } from '@foreman-code/contracts/workspace-root-policies'
export interface AuthorizedWorkspaceRoot {
  selection: WorkspaceRootSelection; allowlist: ApprovedRootAllowlist; ownerPrincipalId: string
  registration: WorkspaceRootPolicy['registration']
}
/** C supplies existing commands/HTTP/MCP around this one generic root authority. */
export interface WorkspaceRootPolicyPort {
  adopt?(sql: GraphSqlClient, principal: ManagementPrincipal, workspaceId: string, host: ApprovedRootAllowlist['hostRef']): Promise<ApprovedRootAllowlist>
  list(sql: GraphSqlClient, principal: ManagementPrincipal, workspaceId: string): Promise<{ workspaceId: string; policies: WorkspaceRootPolicy[]; allowlists: ApprovedRootAllowlist[]; readiness: 'metadata-only' }>
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal, selection: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot>
  authorizeManaged?(sql: GraphSqlClient, principal: ManagementPrincipal,
    selection: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot>
  attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  prepareManaged?(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  inspect(sql: GraphSqlClient, principal: ManagementPrincipal, policy: WorkspaceRootPolicy): Promise<void>
  browse(root: AuthorizedWorkspaceRoot, relativePath: string): Promise<WorkspaceRootBrowseResult>
  fence(sql: GraphSqlClient, root: AuthorizedWorkspaceRoot): Promise<void>
  bind(sql: GraphSqlClient, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot, attestation: WorkspaceRootAttestation, nextLocationRevision: number): Promise<WorkspaceRootPolicy>
  bindManaged?(sql: GraphSqlClient, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot,
    attestation: WorkspaceRootAttestation): Promise<WorkspaceRootPolicy>
  resolve(sql: GraphSqlClient, principal: ManagementPrincipal,
    selection: { workspaceId: string; hostRef: WorkspaceRootPolicy['hostRef']; rootPolicyId: string; rootPolicyRevision: string; locationRevision: string }): Promise<WorkspaceRootPolicy>
  read(sql: GraphSqlClient, principal: ManagementPrincipal, workspaceId: string): Promise<WorkspaceRootPolicy[]>
}
export interface WorkspaceRootHostPort {
  /** Read the original protected human-approved host configuration over its authenticated carrier. */
  configuration?(sql: GraphSqlClient, host: ApprovedRootAllowlist['hostRef']): Promise<ApprovedRootAllowlist>
  /** Main SQL authority calls W07's existing device/main authorizer before host I/O. */
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal, host: ApprovedRootAllowlist['hostRef'], installationId: string): Promise<WorkspaceRootPolicy['registration']>
  /** Persisted human-approved host configuration only; no probe/browse on list. */
  configurations(sql: GraphSqlClient, workspaceId: string): Promise<ApprovedRootAllowlist[]>
  attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  prepareManaged?(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  browse(root: AuthorizedWorkspaceRoot, relativePath: string): Promise<WorkspaceRootBrowseResult>
  sourceNamespace(policy: WorkspaceRootPolicy, rootId: string): Promise<{ canonicalPath: string; filesystem: WorkspaceRootPolicy['filesystem']; attestationId: string; attestationDigest: string }>
}
