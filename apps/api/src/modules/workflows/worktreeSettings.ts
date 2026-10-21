import type pg from 'pg'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { SourceRootReference, WorkflowWorktreeSettings, WorktreeComputerSelection } from '@foreman-code/contracts/worktree-settings'
import { sameWorkflowValue, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import type { PostgresSourceService } from '../sources/service.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { requireAuthorization } from '../access/policy.js'
import { requiredLocationAccess } from '../workspaces/locationAccess.js'
import { DomainError } from '../errors.js'
import { assertWorktreeComputers } from './worktreeComputers.js'

export interface WorkflowWorktreeServices {
  readyRoot(principal: ManagementPrincipal, workspaceId: string,
    sql: pg.PoolClient): Promise<SourceRootReference | undefined>
  sources: Pick<PostgresSourceService, 'resolveRootBinding' | 'resolveApprovedSource'>
  roots: Pick<WorkspaceRootPolicyPort, 'resolve'>
}

export function workflowHasWorktreeSettings(definition: WorkflowDefinitionV3): boolean {
  return Boolean(definition.defaultWorktree) || definition.nodes.some(node => node.kind !== 'job'
    && Boolean(node.worktree || node.placement?.source || node.placement?.rootBinding))
}

export function authorizeWorkflowWorktreeContent(principal: ManagementPrincipal,
  input: { workspaceId: string; graph?: WorkflowDefinitionV3 | undefined }): void {
  if (input.graph && workflowHasWorktreeSettings(input.graph)) {
    requireWorkflowWorktreeReads(principal, input.workspaceId)
  }
}

export function requireWorkflowWorktreeReads(principal: ManagementPrincipal, workspaceId: string): void {
  const scope = { workspaceId }
  requireAuthorization(principal, 'sources:read', scope)
  requireAuthorization(principal, 'source_roots:read', scope)
  requireAuthorization(principal, 'workspace_locations:read', scope)
}

async function validateRoot(input: {
  sql: pg.PoolClient
  principal: ManagementPrincipal
  workspaceId: string
  reference: SourceRootReference
  services: WorkflowWorktreeServices
  newSelection: boolean
}): Promise<{ root: SourceRootRecord; policy: WorkspaceRootPolicy; repository: string | undefined }> {
  const { sql, principal, workspaceId, reference, services } = input
  const row = (await sql.query<{ record: unknown }>(`select record from source_root_bindings
    where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share`,
  [workspaceId, reference.rootId, reference.bindingRevision])).rows[0]
  if (!row) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The selected root binding is not in this workspace.', 404)
  const saved = SourceRootRecordSchema.parse(row.record)
  const root = await services.sources.resolveRootBinding(sql, principal, {
    workspaceId, ...reference, source: saved.source,
  })
  const source = await services.sources.resolveApprovedSource(sql, principal, workspaceId, root.source)
  const policy = await services.roots.resolve(sql, principal, { workspaceId, ...root.selection })
  if (!sameWorkflowValue(root.registration, policy.registration)
    || root.binding.accessMode === 'exclusive-write' && policy.accessMode !== 'read-write') {
    throw new DomainError('WORKTREE_BINDING_CONFLICT', 'Select an approved source with compatible root access.', 409)
  }
  const sourceRepository = source.manifest.git?.repository
  if (input.newSelection && sourceRepository) {
    const workspace = (await sql.query<{ repository: { owner: string; name: string } | null }>(
      "select record->'repository' as repository from workspaces where id=$1 for share", [workspaceId])).rows[0]
    const repository = workspace?.repository
    if (!repository || sourceRepository !== `${repository.owner}/${repository.name}`) {
      throw new DomainError('WORKTREE_REPOSITORY_CONFLICT', 'Select a source from the workspace repository.', 409)
    }
  }
  return { root, policy, repository: sourceRepository }
}

export async function validateWorkflowWorktrees(input: {
  sql: pg.PoolClient
  principal: ManagementPrincipal
  definition: WorkflowDefinitionV3
  previous?: WorkflowDefinitionV3
  configurations?: readonly AgentConfigurationVersion[]
  services?: WorkflowWorktreeServices | undefined
}): Promise<void> {
  if (!workflowHasWorktreeSettings(input.definition)) return
  const { sql, principal, definition, previous, services } = input
  requireWorkflowWorktreeReads(principal, definition.workspaceId)
  if (!services) throw new DomainError('WORKTREE_SERVICES_UNAVAILABLE', 'Workflow worktree selection is unavailable.', 503)
  const roots = new Map<string, { root: SourceRootRecord; policy: WorkspaceRootPolicy; repository: string | undefined }>()
  const resolve = async (reference: SourceRootReference, oldReference?: SourceRootReference) => {
    const key = `${reference.rootId}:${reference.bindingRevision}`
    let root = roots.get(key)
    if (!root) {
      root = await validateRoot({ sql, principal, workspaceId: definition.workspaceId, reference, services,
        newSelection: !sameWorkflowValue(reference, oldReference) })
      roots.set(key, root)
    }
    return root
  }
  if (definition.defaultWorktree) {
    const { root, repository } = await resolve(definition.defaultWorktree.rootBinding, previous?.defaultWorktree?.rootBinding)
    assertGitSource(repository)
    if (definition.defaultWorktree.branchPrefix) assertWritableBranch(root)
  }
  const computers: WorktreeComputerSelection[] = []
  for (const node of definition.nodes) {
    if (node.kind === 'job') continue
    const configured = node.worktree || definition.defaultWorktree || node.placement?.source || node.placement?.rootBinding
    if (!configured) continue
    if (node.placement && (!node.placement.rootBinding || !node.placement.source)) {
      throw new DomainError('WORKTREE_BINDING_REQUIRED', 'Select an approved source and root for this Agent placement.', 409)
    }
    const reference = node.placement?.rootBinding ?? definition.defaultWorktree?.rootBinding
      ?? await inheritedMainReference(sql, definition.workspaceId)
    const oldNode = previous?.nodes.find(item => item.id === node.id)
    const oldReference = oldNode && oldNode.kind !== 'job' ? oldNode.placement?.rootBinding : undefined
    const { root, policy, repository } = await resolve(reference, oldReference ?? previous?.defaultWorktree?.rootBinding)
    if (node.placement && (!sameWorkflowValue(node.placement.source, root.source)
      || !sameWorkflowValue(root.selection, {
        hostRef: node.placement.hostRef, rootPolicyId: node.placement.rootPolicyId,
        rootPolicyRevision: node.placement.rootPolicyRevision, locationRevision: node.placement.locationRevision,
      }) || node.placement.projectRoot !== policy.canonicalProjectRoot || !validRelativeCwd(node.placement))) {
      throw new DomainError('WORKTREE_BINDING_CONFLICT', 'The Agent placement does not match its approved root.', 409)
    }
    const branchPrefix = node.worktree?.branchPrefix ?? definition.defaultWorktree?.branchPrefix
    if (branchPrefix) {
      assertGitSource(repository)
      assertWritableBranch(root)
      computers.push({ branchPrefix, agentName: node.name ?? node.label ?? node.agentId,
        hostRef: root.selection.hostRef })
    }
    const configuration = input.configurations?.find(item => item.agentId === node.agentId)
    if (configuration && requiredLocationAccess([configuration]) === 'read-write'
      && root.binding.accessMode !== 'exclusive-write') {
      throw new DomainError('WORKTREE_ACCESS_CONFLICT', 'This Agent requires a writable approved root.', 409)
    }
  }
  await assertWorktreeComputers(sql, computers)
}

function assertGitSource(repository: string | undefined): void {
  if (!repository) throw new DomainError('WORKTREE_BINDING_CONFLICT', 'Select an approved Git source for this worktree setting.', 409)
}

function assertWritableBranch(root: SourceRootRecord): void {
  if (root.binding.accessMode !== 'exclusive-write') {
    throw new DomainError('WORKTREE_ACCESS_CONFLICT', 'An Agent branch prefix requires a writable approved root.', 409)
  }
}

async function inheritedMainReference(sql: pg.PoolClient, workspaceId: string): Promise<SourceRootReference> {
  const rows = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
    join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
    where c.workspace_id=$1 and b.record#>>'{selection,hostRef,kind}'='main' for share of c,b`, [workspaceId])
  if (rows.rows.length !== 1) {
    throw new DomainError('WORKTREE_BINDING_REQUIRED', 'Select an approved root for this Agent branch prefix.', 409)
  }
  const root = SourceRootRecordSchema.parse(rows.rows[0]!.record)
  return { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }
}

function validRelativeCwd(placement: SavedNodePlacement): boolean {
  const value = placement.relativeCwd
  if (value.length > 1024 || value.includes('\0') || value.startsWith('/')) return false
  if (value !== '' && value.split('/').some(part => part === '..' || part === '.' || part === '')) return false
  return placement.cwdPolicy === 'project-root' ? value === '' : value !== ''
}

export async function workflowCreationWorktree(input: {
  sql: pg.PoolClient
  principal: ManagementPrincipal
  workspaceId: string
  requested: WorkflowWorktreeSettings | null | undefined
  services?: WorkflowWorktreeServices | undefined
}): Promise<WorkflowWorktreeSettings | undefined> {
  if (input.requested === null) return undefined
  if (input.requested) return input.requested
  const reference = await input.services?.readyRoot(input.principal, input.workspaceId, input.sql)
  return reference ? { rootBinding: reference } : undefined
}
