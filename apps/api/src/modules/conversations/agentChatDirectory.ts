import { posix } from 'node:path'
import { stat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { AgentConfigurationVersion, ExecutionLocation } from '@foreman-code/contracts'
import { AgentChatDirectoryBindingSchema, type AgentChatDirectoryBinding } from '@foreman-code/contracts/agent-chat'
import { SavedNodePlacementSchema, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { requiredLocationAccess } from '../workspaces/location.js'
import { DomainError } from '../errors.js'
import { workspaceRootHostScope } from '../sources/rootPolicies.js'
import { readAcceptedPlacement } from '../placement/persistence.js'
import { lockWorkspaceFolders } from '../workspaces/folderLocks.js'

function unavailable(message: string): never { throw new DomainError('AGENT_CHAT_DIRECTORY_UNAVAILABLE', message, 409) }

/** Admission holds the saved Main directory until the queued turn commits. */
export async function assertAgentChatDirectoryAvailable(sql: SqlQuery, conversationId: string) {
  const directory = (await sql.query<{
    path: string; host_kind: string; origin_run_id: string | null; workflow_node_id: string
  }>(`
    select c.record->>'workingDirectory' as path,c.origin_run_id,c.workflow_node_id,
      coalesce(c.worker_conversation_binding#>>'{profile,target,hostRef,kind}',
        c.record#>>'{directoryBinding,placement,hostRef,kind}',
        v.record#>>'{harnessProfileSelection,target,hostRef,kind}', 'main') as host_kind
    from operator_conversations c
    left join agent_configuration_versions v on v.id=c.agent_configuration_version_id
    where c.id=$1 and c.kind='agent'`, [conversationId])).rows[0]
  if (!directory?.path) unavailable('The conversation’s saved folder is unavailable.')
  const placement = directory.origin_run_id
    ? await readAcceptedPlacement(sql, directory.origin_run_id, directory.workflow_node_id) : undefined
  if ((placement?.hostRef.kind ?? directory.host_kind) === 'device') return
  await lockWorkspaceFolders(sql, [directory.path])
  try {
    if ((await stat(directory.path)).isDirectory()) return
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  unavailable('The conversation’s saved folder is unavailable. Restore it before sending another message.')
}

/** The workspace's current folder on the Agent's paired computer, as an implicit project-root node placement. */
async function deviceWorkspacePlacement(sql: SqlQuery, workspaceId: string,
  selector: NonNullable<AgentConfigurationVersion['harnessProfileSelection']>): Promise<SavedNodePlacement> {
  const rows = (await sql.query<{ policy: unknown }>(`select p.record as policy from workspace_root_policy_heads h
    join workspace_root_policies p on p.root_policy_id=h.root_policy_id and p.root_policy_revision=h.root_policy_revision
    where h.workspace_id=$1 and h.host_scope=$2 and p.revoked_at is null`,
  [workspaceId, workspaceRootHostScope(selector.target.hostRef)])).rows
  if (rows.length !== 1) unavailable('This Agent runs on another computer that has no workspace folder for this workspace. Set one before chatting.')
  const policy = WorkspaceRootPolicySchema.parse(rows[0]!.policy)
  return SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
    rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision,
    projectRoot: policy.canonicalProjectRoot, cwdPolicy: 'project-root', relativeCwd: '', instanceId: selector.instanceId,
    instanceRevision: selector.instanceRevision, harnessInstallationId: selector.target.harnessInstallationId })
}

/** Called inside Agent-chat admission; reading the saved directory does not grant source-management access. */
export async function resolveAgentChatDirectory(input: {
  sql: SqlQuery
  configuration: AgentConfigurationVersion
  workflowVersionId: string
  placement?: SavedNodePlacement
  location?: ExecutionLocation
}): Promise<{ workingDirectory: string; directoryBinding?: AgentChatDirectoryBinding }> {
  const selector = input.configuration.harnessProfileSelection
  if (!input.placement) {
    const host = selector?.target.hostRef
    const expectedRunner = host?.kind === 'device' ? `device:${host.deviceId}` : 'runner-local'
    if (selector && host?.kind === 'device' && input.location?.runnerId !== expectedRunner) {
      // The Agent runs on its paired computer: chat in that computer's workspace folder, never Main's.
      return resolveAgentChatDirectory({ ...input,
        placement: await deviceWorkspacePlacement(input.sql, input.configuration.workspaceId, selector) })
    }
    if (!input.location) unavailable('Set a workspace folder before chatting with this Agent.')
    if (input.location.runnerId !== expectedRunner) unavailable('The workspace folder belongs to another execution host.')
    return { workingDirectory: input.location.rootPath }
  }
  const placement = SavedNodePlacementSchema.parse(input.placement)
  if (!selector || !isDeepStrictEqual(selector.target.hostRef, placement.hostRef)
    || selector.instanceId !== placement.instanceId || selector.instanceRevision !== placement.instanceRevision
    || selector.target.harnessInstallationId !== placement.harnessInstallationId) {
    unavailable('The saved node placement differs from its Agent profile. Save matching settings before chatting.')
  }
  const relative = placement.relativeCwd
  if (relative.includes('\0') || relative.length > 1024 || posix.isAbsolute(relative)
    || relative !== '' && relative.split('/').some(part => ['.', '..', ''].includes(part))
    || placement.cwdPolicy === 'project-root' && relative !== ''
    || placement.cwdPolicy === 'project-subdirectory' && relative === '') unavailable('The saved node folder is invalid.')
  const row = (await input.sql.query<{ policy: unknown; configuration: unknown; revoked_at: Date | null }>(`
    select p.record as policy,c.record as configuration,p.revoked_at from workspace_root_policies p
    join workspace_root_host_configuration_heads h on h.host_scope=p.host_scope
    join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
    where p.root_policy_id=$1 and p.root_policy_revision=$2 and p.workspace_id=$3 and p.host_scope=$4`,
  [placement.rootPolicyId, placement.rootPolicyRevision, input.configuration.workspaceId,
    workspaceRootHostScope(placement.hostRef)])).rows[0]
  if (!row || row.revoked_at) unavailable('The saved node root is missing or revoked.')
  const policy = WorkspaceRootPolicySchema.parse(row.policy)
  const approved = ApprovedRootAllowlistSchema.parse(row.configuration)
  if (policy.workspaceId !== input.configuration.workspaceId || !isDeepStrictEqual(policy.hostRef, placement.hostRef)
    || !isDeepStrictEqual(approved.hostRef, placement.hostRef)
    || policy.applicationInstallationId !== selector.target.applicationInstallationId
    || approved.applicationInstallationId !== policy.applicationInstallationId
    || policy.rootPolicyId !== placement.rootPolicyId || policy.rootPolicyRevision !== placement.rootPolicyRevision
    || policy.locationRevision !== placement.locationRevision || policy.canonicalProjectRoot !== placement.projectRoot
    || policy.configurationRevision !== approved.configurationRevision
    || !approved.bases.some(base => base.baseId === policy.allowedBaseId && base.accessModes.includes(policy.accessMode))
    || requiredLocationAccess([input.configuration]) === 'read-write' && policy.accessMode !== 'read-write') {
    unavailable('The saved node root no longer matches its approved host settings.')
  }
  return { workingDirectory: posix.join(policy.canonicalProjectRoot, relative),
    directoryBinding: AgentChatDirectoryBindingSchema.parse({ workflowVersionId: input.workflowVersionId, placement, policy }) }
}

export async function revalidateAgentChatDirectory(sql: SqlQuery,
  configuration: AgentConfigurationVersion, raw: AgentChatDirectoryBinding, workingDirectory: string) {
  const binding = AgentChatDirectoryBindingSchema.parse(raw)
  const current = await resolveAgentChatDirectory({ sql, configuration,
    workflowVersionId: binding.workflowVersionId, placement: binding.placement })
  if (current.workingDirectory !== workingDirectory || !isDeepStrictEqual(current.directoryBinding, binding)) {
    unavailable('The conversation’s saved node directory changed.')
  }
}
