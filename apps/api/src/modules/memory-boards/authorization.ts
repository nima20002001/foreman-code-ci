import type { AgentSubject, MemoryBoardScope } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { MemoryBoardAuthority, MemoryTool, MutationContext, SubjectAccess } from './types.js'
import { memoryWriteTools } from './types.js'
import { same, scopeContains } from './identity.js'

export function requireSubjectTool(access: SubjectAccess, scope: MemoryBoardScope, tool: MemoryTool): void {
  if (!scopeContains(scope, access.subject.agent) || !access.tools.includes(tool)
    || (access.readOnly && memoryWriteTools.some(name => name === tool))) {
    throw new DomainError('ACCESS_DENIED', 'This agent cannot use that memory tool in this board.', 403)
  }
}
export async function authorizeCaller(tx: GraphTransactionSql, authority: MemoryBoardAuthority,
  principal: ManagementPrincipal, scope: MemoryBoardScope, tool: MemoryTool): Promise<MutationContext> {
  const access = await authority.caller(tx,principal)
  if (access) {
    requireSubjectTool(access,scope,tool)
    return { actor: { kind: 'agent', id: access.subject.agent.agentId, displayName: access.subject.agent.displayName },
      principalId: access.principalId, subject: access.subject, caller: principal, tool }
  }
  if (principal.audience !== 'operator') throw new DomainError('ACCESS_DENIED','A valid scoped agent identity is required.',403)
  const write = memoryWriteTools.some(name => name === tool)
  const action = scope.kind === 'workspace'
    ? write ? 'workspaces:update' : 'workspaces:read'
    : write ? 'workflows:update' : 'workflows:read'
  requireAuthorization(principal,action,scope)
  return { actor: { kind: 'operator', id: principal.id, displayName: principal.name },
    principalId: principal.id, caller: principal, tool }
}
export async function authorizeSubject(tx: GraphTransactionSql, authority: MemoryBoardAuthority,
  subject: AgentSubject, scope: MemoryBoardScope, tool: MemoryTool): Promise<MutationContext> {
  const access = await authority.subject(tx,subject)
  if (!same(access.subject,subject)) throw new DomainError('ACCESS_DENIED','The saved agent identity has changed.',403)
  requireSubjectTool(access,scope,tool)
  return { actor: { kind: 'agent', id: subject.agent.agentId, displayName: subject.agent.displayName },
    principalId: access.principalId, subject, caller: subject, tool }
}
