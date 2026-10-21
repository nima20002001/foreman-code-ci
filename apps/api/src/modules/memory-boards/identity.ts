import { createHash } from 'node:crypto'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { AgentNodeRef, LogicalWorkRef, MemoryBoardScope } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

export { canonicalJson }
export function inputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}
export function scopeKey(scope: MemoryBoardScope): string { return canonicalJson(scope) }
export function nodeKey(node: AgentNodeRef): string {
  return canonicalJson({ workspaceId: node.workspaceId, workflowId: node.workflowId,
    workflowNodeId: node.workflowNodeId, agentId: node.agentId })
}
export function workKey(work: LogicalWorkRef): string { return canonicalJson(work) }
export function scopeContains(scope: MemoryBoardScope, node: AgentNodeRef): boolean {
  return scope.workspaceId === node.workspaceId
    && (scope.kind === 'workspace' || scope.workflowId === node.workflowId)
}
export function invalid(message: string, details?: Record<string, unknown>): never {
  throw new DomainError('VALIDATION_ERROR', message, 400, details)
}
export function missing(entity: string): never { throw new DomainError('NOT_FOUND', `${entity} was not found.`, 404) }
export function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right) }
