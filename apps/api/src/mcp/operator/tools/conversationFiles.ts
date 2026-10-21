import {
  ConversationFileCommandInputSchema, ConversationFileReadInputSchema, ConversationFileReadResultSchema,
  ConversationFilesListInputSchema, ConversationFileUploadInputSchema, FileMutationResultSchema, FilePageSchema,
} from '@foreman-code/contracts/files'
import { DomainError } from '../../../modules/errors.js'
import { defineOperatorTool, toolAvailable, type OperatorToolDefinition } from '../definition.js'

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** Discovery accepts either chat kind; the service authorizes the requested conversation on every call. */
function conversationTool(tool: OperatorToolDefinition): OperatorToolDefinition {
  const mutation = tool.requires.some(([action]) => action === 'agent_chat:write')
  const operator: OperatorToolDefinition = { ...tool, requires: mutation
    ? [['operator_chat:write', 'global'], ['operator_chat:read', 'global']]
    : [['operator_chat:read', 'global']] }
  return { ...tool,
    discoverable: (context, resource) => toolAvailable(context, tool, resource) || toolAvailable(context, operator),
    permissionDetail: 'Requires agent_chat:read (and agent_chat:write for mutations) in the Agent conversation scope, '
      + 'or operator_chat:read (and operator_chat:write for mutations) for an owned Operator conversation.',
  }
}

export const conversationFileTools: readonly OperatorToolDefinition[] = [
  conversationTool(defineOperatorTool({
    name: 'conversation_file_upload',
    requires: [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
    enabled: services => !!services.temporaryFiles,
    description: 'Stage a temporary chat attachment from canonical contentBase64 and upload metadata (up to 25 MiB). '
      + 'conversation is {kind: operator, conversationId} or {kind: agent, workspaceId, conversationId}. '
      + 'Use agent_chat_ensure_conversation before the first Agent attachment. Retry identical upload.requestId and metadata. '
      + 'Call conversation_file_finalize to publish, or conversation_file_cancel to discard staging. '
      + 'Uses normal conversation read/write authority; does not issue or accept native file-session credentials.',
    inputSchema: ConversationFileUploadInputSchema, outputSchema: FileMutationResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false },
    run: (context, input) => {
      if (!context.reauthorize) throw new DomainError('AUTH_REQUIRED', 'Upload request authentication is unavailable.', 401)
      return context.services.temporaryFiles!.uploadInline(context.principal, input, context.reauthorize)
    },
  })),
  conversationTool(defineOperatorTool({
    name: 'conversation_file_finalize',
    requires: [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
    enabled: services => !!services.temporaryFiles,
    description: 'Finalize a staged temporary attachment using conversation and original requestId. '
      + 'Verifies stored size and checksum through the HTTP file service. Identical retries return the same file and revision. '
      + 'Requires conversation read/write authority; canceled uploads remain canceled.',
    inputSchema: ConversationFileCommandInputSchema, outputSchema: FileMutationResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false },
    run: (context, { conversation, requestId }) => context.services.temporaryFiles!
      .finalize(context.principal, conversation, requestId, 'mcp'),
  })),
  conversationTool(defineOperatorTool({
    name: 'conversation_file_cancel',
    requires: [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
    enabled: services => !!services.temporaryFiles,
    description: 'Cancel an unsent temporary attachment using conversation and original requestId. '
      + 'Retains its removal tombstone and deletes staging bytes. Safe to retry; finalized files cannot be canceled. '
      + 'Requires conversation read/write authority.',
    inputSchema: ConversationFileCommandInputSchema, outputSchema: FileMutationResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false, destructiveHint: true },
    run: (context, { conversation, requestId }) => context.services.temporaryFiles!
      .cancel(context.principal, conversation, requestId, 'mcp'),
  })),
  conversationTool(defineOperatorTool({
    name: 'conversation_files_list', requires: [['agent_chat:read', 'resource']],
    enabled: services => !!services.temporaryFiles,
    description: 'List persisted temporary files in one authorized conversation, including pending and removed files. '
      + 'Use nextCursor for paging. Requires conversation read authority; Operator conversations must belong to the caller.',
    inputSchema: ConversationFilesListInputSchema, outputSchema: FilePageSchema, annotations: readAnnotations,
    run: (context, { conversation, ...query }) => context.services.temporaryFiles!
      .list(context.principal, conversation, query),
  })),
  conversationTool(defineOperatorTool({
    name: 'conversation_file_read', requires: [['agent_chat:read', 'resource']],
    enabled: services => !!services.temporaryFiles,
    description: 'Read a pinned temporary fileId/revisionId from an authorized conversation. '
      + 'Returns up to 64 KiB of canonical base64 with offset and eof, or an explicit unavailable state. '
      + 'Requires conversation read authority; never follows a host path or issues a native file-session credential.',
    inputSchema: ConversationFileReadInputSchema, outputSchema: ConversationFileReadResultSchema, annotations: readAnnotations,
    run: async (context, { conversation, ...input }) => ({ value: await context.services.temporaryFiles!
      .read(context.principal, conversation, input) }),
  })),
]
