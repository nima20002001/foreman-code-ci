import { createHash } from 'node:crypto'
import type { FileScope } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import type { AgentReferenceContext } from './agentTypes.js'

export interface ReferenceExecutionIdentity {
  workspace_id: string
  workflow_id: string
  agent_id: string
  run_id: string
  execution_id: string
}
export interface ReferenceConversationIdentity {
  id: string
  kind: 'agent' | 'operator'
  workspace_id: string | null
  workflow_id: string | null
  agent_id: string | null
  origin_run_id: string | null
  origin_execution_id: string | null
}

export function referenceIdentityDenied(): never {
  throw new DomainError('FILE_REFERENCE_ACCESS_DENIED', 'The reference caller does not have a valid conversation or execution.', 403)
}

/** No current workflow/Agent lookup: a historical conversation is allowed to outlive its graph node. */
export function conversationReferenceContext(row: ReferenceConversationIdentity,
  origin?: ReferenceExecutionIdentity): AgentReferenceContext | null {
  if (row.kind === 'operator') return null
  if (!row.id || !row.workspace_id || !row.workflow_id || !row.agent_id
    || (row.origin_run_id === null) !== (row.origin_execution_id === null)) return referenceIdentityDenied()
  const context = { conversationId: row.id, workspaceId: row.workspace_id,
    workflowId: row.workflow_id, agentId: row.agent_id }
  if (row.origin_run_id === null) return context
  if (!origin || origin.run_id !== row.origin_run_id || origin.execution_id !== row.origin_execution_id
    || origin.agent_id !== row.agent_id || origin.workspace_id !== row.workspace_id
    || origin.workflow_id !== row.workflow_id) return referenceIdentityDenied()
  return { ...context, runId: origin.run_id, executionId: origin.execution_id }
}

export function effectiveReference(context: AgentReferenceContext, scope: FileScope): boolean {
  return scope.kind === 'workspace_reference' ? scope.workspaceId === context.workspaceId
    : scope.kind === 'workflow_reference' && scope.workspaceId === context.workspaceId && scope.workflowId === context.workflowId
}

export function referenceContextKey(context: AgentReferenceContext): string {
  return JSON.stringify([context.workspaceId, context.workflowId, context.agentId,
    context.conversationId ?? null, context.runId ?? null, context.executionId ?? null])
}
export function referenceCursorKey(principalId: string, context: AgentReferenceContext): string {
  return createHash('sha256').update(JSON.stringify([principalId, referenceContextKey(context)])).digest('hex')
}

export interface ReferenceCursor { phase: 0 | 1; cursor?: string }
export function encodeReferenceCursor(key: string, page: ReferenceCursor): string {
  return Buffer.from(JSON.stringify({ version: 1, key, ...page })).toString('base64url')
}
export function decodeReferenceCursor(raw: string | undefined, key: string): ReferenceCursor {
  if (raw === undefined) return { phase: 0 }
  try {
    if (!raw || raw.length > 4096) throw new Error('size')
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) throw new Error('encoding')
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
    const page = value as Record<string, unknown>
    if (Object.keys(page).some((field) => !['version', 'key', 'phase', 'cursor'].includes(field))
      || page.version !== 1 || page.key !== key || (page.phase !== 0 && page.phase !== 1)
      || (page.cursor !== undefined && (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 2048))) {
      throw new Error('scope')
    }
    return { phase: page.phase, ...(typeof page.cursor === 'string' ? { cursor: page.cursor } : {}) }
  } catch {
    throw new DomainError('FILE_CURSOR_INVALID', 'The cursor does not belong to this effective reference list.', 400)
  }
}
