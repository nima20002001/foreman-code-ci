import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { FilePageSchema, type PermanentFileScope } from '@foreman-code/contracts/files'
import type { ManagementScope } from '@foreman-code/contracts/management'

import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'
import { referenceFileActions } from '../../../modules/files/references/authorization.js'
import {
  FileReferenceAddInputSchema, FileReferenceListInputSchema, FileReferenceReadInputSchema,
  FileReferenceReadResultSchema, FileReferenceRemoveToolInputSchema, FileReferenceMutationResultSchema,
} from '@foreman-code/contracts/files'
import { toolFailure } from '../../shared/results.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'
import { FILE_REFERENCE_TOOL_NAMES, type FileReferenceToolName } from '../toolNames.js'

export { FILE_REFERENCE_TOOL_NAMES, type FileReferenceToolName }

function compatibleScope(left: ManagementScope, right: ManagementScope): ManagementScope | undefined {
  const result: ManagementScope = {}
  for (const dimension of ['workspaceIds', 'workflowIds'] as const) {
    const a = left[dimension], b = right[dimension]
    const ids = a && b ? a.filter((id) => b.includes(id)) : a ?? b
    if (ids?.length === 0) return undefined
    if (ids) result[dimension] = ids
  }
  return result
}

/** Discovery requires overlapping read/write grants. Every call still rechecks live resource authority. */
export function fileReferenceToolAvailable(context: OperatorRequestContext, name: FileReferenceToolName,
  resource: AuthorizedResource = {}): boolean {
  if (!context.services.fileReferences || context.principal.audience !== 'operator') return false
  const access = name === 'reference_file_add' || name === 'reference_file_remove' ? 'write' : 'read'
  return (['workspace_reference', 'workflow_reference'] as const).some((kind: PermanentFileScope['kind']) => {
    if (Object.keys(resource).length) {
      if (!resource.workspaceId || (kind === 'workflow_reference' && !resource.workflowId)) return false
      const scope = kind === 'workspace_reference'
        ? { workspaceId: resource.workspaceId }
        : { workspaceId: resource.workspaceId, workflowId: resource.workflowId! }
      return referenceFileActions(kind, access).every((action) => isAuthorized(context.principal, action, scope))
    }
    let compatible: ManagementScope[] = [{}]
    for (const action of referenceFileActions(kind, access)) {
      if (!hasAction(context.principal, action)) return false
      const grants = context.principal.grants.filter((grant) => grant.actions.includes(action)
        && !grant.scope.runIds && (kind !== 'workspace_reference' || !grant.scope.workflowIds)
        && Object.values(grant.scope).every((ids) => ids === undefined || ids.length > 0))
      const next: ManagementScope[] = []
      for (const current of compatible) for (const grant of grants) {
        const combined = compatibleScope(current, grant.scope)
        if (combined) next.push(combined)
        // Conservative bound, never turn an expensive discovery into broader authority.
        if (next.length > 10_000) return false
      }
      if (!next.length) return false
      compatible = next
    }
    return true
  })
}

export function registerFileReferenceTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.fileReferences
  if (!service) return
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (fileReferenceToolAvailable(context, 'reference_files_list')) server.registerTool('reference_files_list', {
    description: 'List permanent reference files in one exact workspace_reference or workflow_reference scope, including pending files and removal tombstones. Workspace references are not copied into workflow lists. Requires workspaces:read or workflows:read for that resource; no worker access. Use the opaque nextCursor for bounded paging.',
    inputSchema: FileReferenceListInputSchema, outputSchema: FilePageSchema, annotations: readAnnotations,
  }, async ({ scope, ...query }) => invokeOperatorTool(context, 'reference_files_list',
    () => service.list(context.principal, scope, query)))
  if (fileReferenceToolAvailable(context, 'reference_file_read')) server.registerTool('reference_file_read', {
    description: 'Read up to 64 KiB of a permanent reference using exact fileId+revisionId and offset/length. Returns canonical base64 and eof; never follows the current head. Requires the scope\'s read grant. Removed/pending bytes are unavailable. This Operator tool does not grant Agent reference access.',
    inputSchema: FileReferenceReadInputSchema, outputSchema: FileReferenceReadResultSchema, annotations: readAnnotations,
  }, async ({ scope, ...input }) => invokeOperatorTool(context, 'reference_file_read',
    async () => ({ value: await service.read(context.principal, scope, input) })))
  if (fileReferenceToolAvailable(context, 'reference_file_add')) server.registerTool('reference_file_add', {
    description: 'Add a NEW permanent reference (up to 25 MiB). Supply scope, upload {requestId,filename,mediaType,byteSize,sha256}, and canonical contentBase64. Performs the same allocate/verify/finalize flow as HTTP; retry with identical requestId and metadata. Requires overlapping read+update grants for that workspace or workflow. Never overwrites, executes content, reads a host path/URL, or grants worker write access.',
    inputSchema: FileReferenceAddInputSchema, outputSchema: FileReferenceMutationResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false },
  }, async (input) => invokeOperatorTool(context, 'reference_file_add', () => service.add(context.principal, input)))
  if (fileReferenceToolAvailable(context, 'reference_file_remove')) server.registerTool('reference_file_remove', {
    description: 'Remove an exactly pinned permanent reference using commandId, scope, fileId and revisionId. Requires the scope\'s read+update grants. Idempotent and audited; preserves the tombstone and immutable revision metadata, does not replace bytes or expire other files. Worker Agents cannot remove references.',
    inputSchema: FileReferenceRemoveToolInputSchema, outputSchema: FileReferenceMutationResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false, destructiveHint: true },
  }, async ({ scope, ...input }) => invokeOperatorTool(context, 'reference_file_remove',
    () => service.remove(context.principal, scope, input, 'mcp')))
}

const ToolCallSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(FILE_REFERENCE_TOOL_NAMES) }).passthrough() }).passthrough()

/** A denied caller cannot bypass discovery by naming an unlisted tool directly. */
export async function unavailableFileReferenceToolCall(context: OperatorRequestContext, raw: unknown) {
  const parsed = ToolCallSchema.safeParse(raw)
  if (!parsed.success || fileReferenceToolAvailable(context, parsed.data.params.name)) return undefined
  const name = parsed.data.params.name
  await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: parsed.data.id,
    result: toolFailure(new DomainError('ACCESS_DENIED', 'Reference files require an installed service and appropriate Operator resource grants.', 403)) }
}
