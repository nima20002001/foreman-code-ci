import type { ArtifactAttempt, ArtifactGrantReference, ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../repository.js'
import type { ArtifactEdgeAuthorization } from './edges.js'

export interface AcceptedArtifactAttemptFence {
  /** W08 must resolve durable dispatch intent and lock its current owner grant, plus W07
   * registration/key and accepted root. A caller-supplied attempt is only an assertion. */
  assertCurrent(attempt: ArtifactAttempt, authority: ArtifactGrantReference, query: FileQuery): Promise<void>
  /** Bind outputKey to the producer attempt's persisted accepted output, not arbitrary file metadata. */
  assertPublishedOutput(binding: ArtifactEdgeBinding, query: FileQuery): Promise<void>
}
export class PostgresArtifactEdgeAuthorization implements ArtifactEdgeAuthorization {
  constructor(private readonly attempts: AcceptedArtifactAttemptFence) {}
  async assertCurrent(b: ArtifactEdgeBinding, query: FileQuery): Promise<void> {
    // Stable lock order; delegated parents are revalidated by the shared management reader.
    const principals = new Map<string, ManagementPrincipal>()
    for (const id of [...new Set([b.sender.principalId, b.receiver.principalId])].sort()) {
      principals.set(id, await readLiveManagementPrincipal(query, id))
    }
    for (const [attempt, authority] of [[b.producer, b.sender], [b.consumer, b.receiver]] as const) {
      requireAuthorization(principals.get(authority.principalId)!, 'agent_chat:read', {
        workspaceId: attempt.workspaceId, workflowId: attempt.workflowId, runId: attempt.runId,
      })
      await this.attempts.assertCurrent(attempt, authority, query)
    }
    await this.attempts.assertPublishedOutput(b, query)
    if (b.scope.kind !== 'temporary' || b.scope.chat.kind !== 'agent'
      || b.scope.chat.workspaceId !== b.producer.workspaceId || b.scope.chat.workflowId !== b.producer.workflowId
      || b.scope.chat.runId !== b.producer.runId || b.scope.chat.executionId !== b.producer.executionId) {
      throw new DomainError('FILE_EDGE_DENIED', 'Only originating accepted agent outputs can be delegated by an edge.', 403)
    }
    const scope = b.scope.chat
    const source = await query.query(`select id from operator_conversations where id=$1 and kind='agent'
      and workspace_id=$2 and workflow_id=$3 and origin_run_id=$4 and origin_execution_id=$5
      and agent_id=$6 and deleted_at is null for share`,
    [scope.conversationId, scope.workspaceId, scope.workflowId, scope.runId, scope.executionId, scope.agentId])
    const publication = await query.query(`select record from file_tool_publications
      where owner_principal_id=$1 and request_id=$2 and binding=$3 and file_id=$4 and revision_id=$5
        and record #>> '{context,ownerPrincipalId}'=$6
        and record #>> '{context,scope,chat,conversationId}'=$7`,
    [b.publication.ownerPrincipalId, b.publication.requestId, b.publication.binding,
      b.pins.fileId, b.pins.revisionId, b.sender.principalId, scope.conversationId])
    if (source.rowCount !== 1 || publication.rowCount !== 1) {
      throw new DomainError('FILE_EDGE_DENIED', 'The accepted sender does not own this originating publication.', 403)
    }
  }
}
