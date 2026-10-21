import { z } from 'zod'
import {
  AgentFileListInputSchema, FileScopeSchema,
  type FileScope,
} from '@foreman-code/contracts/files'

export const FileListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().optional(),
}).strict()
export const EmptyFileCommandSchema = z.object({}).strict()

/** Fixed key order is intentional: object key order is not idempotency identity. */
export function fileScopeIdentity(input: FileScope): string {
  const scope = FileScopeSchema.parse(input)
  if (scope.kind === 'job_execution') return JSON.stringify([scope.kind, scope.workspaceId, scope.jobExecutionId])
  if (scope.kind === 'workspace_reference') return JSON.stringify([scope.kind, scope.workspaceId])
  if (scope.kind === 'workflow_reference') return JSON.stringify([scope.kind, scope.workspaceId, scope.workflowId])
  const chat = scope.chat
  return JSON.stringify(chat.kind === 'operator'
    ? ['temporary', 'operator', chat.ownerPrincipalId, chat.operatorId, chat.conversationId]
    : ['temporary', 'agent', chat.conversationId, chat.agentId, chat.workspaceId, chat.workflowId,
      chat.runId ?? null, chat.executionId ?? null])
}
export function fileListInput(scope: FileScope, query: unknown) {
  return AgentFileListInputSchema.parse({ scope, ...FileListQuerySchema.parse(query) })
}
