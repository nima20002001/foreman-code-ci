import { PermanentFileScopeSchema, type PermanentFileScope } from '@foreman-code/contracts/files'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'

import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { DomainError } from '../../errors.js'
import type { FileAccess } from '../authorization.js'
import type { FileQuery } from '../repository.js'
import type { FileScopeAuthorization } from '../service.js'

/** References are management resources, not worker or chat capabilities. No new grants are implied. */
export function referenceFileActions(kind: PermanentFileScope['kind'], access: FileAccess): ManagementAction[] {
  return kind === 'workspace_reference'
    ? access === 'read' ? ['workspaces:read'] : ['workspaces:read', 'workspaces:update']
    : access === 'read' ? ['workflows:read'] : ['workflows:read', 'workflows:update']
}

export class PostgresFileReferenceAuthorization implements FileScopeAuthorization<PermanentFileScope> {
  constructor(private readonly pool: FileQuery) {}

  async resolve(principal: ManagementPrincipal, target: PermanentFileScope, access: FileAccess,
    query: FileQuery = this.pool): Promise<PermanentFileScope> {
    const scope = PermanentFileScopeSchema.parse(target)
    const resource = { workspaceId: scope.workspaceId,
      ...(scope.kind === 'workflow_reference' ? { workflowId: scope.workflowId } : {}) }
    const actions = referenceFileActions(scope.kind, access)
    // Reject worker audiences before looking up a management principal. IDs are never authority.
    for (const action of actions) requireAuthorization(principal, action, resource)
    const live = await readLiveManagementPrincipal(query, principal.id)
    for (const action of actions) requireAuthorization(live, action, resource)

    // Same resource/archival boundaries as workspace/workflow management. Under a write transaction
    // these share locks also serialize grant revocation and archival with the metadata commit.
    const workspace = await query.query<{ archived_at: Date | null }>(
      'select archived_at from workspaces where id=$1 for share', [scope.workspaceId])
    if (!workspace.rows[0]) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
    if (access === 'write' && workspace.rows[0].archived_at) {
      throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot change reference files.', 409)
    }
    if (scope.kind === 'workflow_reference') {
      const workflow = await query.query<{ archived_at: Date | null }>(
        'select archived_at from workflows where workspace_id=$1 and id=$2 for share', [scope.workspaceId, scope.workflowId])
      if (!workflow.rows[0]) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
      if (access === 'write' && workflow.rows[0].archived_at) {
        throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot change reference files.', 409)
      }
    }
    return scope
  }
}
