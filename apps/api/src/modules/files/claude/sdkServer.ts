import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  AgentFileListInputSchema, AgentFileReadInputSchema, AgentFileCreateWorkingCopyInputSchema,
  AgentFileWriteWorkingCopyInputSchema, AgentFileApplyFormatEditInputSchema, AgentFilePublishInputSchema,
} from '@foreman-code/contracts/files'
import type { ClaudeMcpToolManifest } from '../../harnesses/claudeSdk/mcpPolicy.js'
import type { FileToolOperation } from '../tools/types.js'

export type ClaudeFileSdk = { createSdkMcpServer: typeof createSdkMcpServer; tool: typeof tool }

export function createClaudeFileTools(input: {
  sdk: ClaudeFileSdk
  allowMutation: boolean
  invoke(operation: FileToolOperation, args: unknown, extra: unknown): Promise<CallToolResult>
}) {
  const invoke = input.invoke
  const sdk = input.sdk
  const definitions = [
    sdk.tool('files.list', 'List metadata in the admitted conversation scope.',
      { ...AgentFileListInputSchema.shape, limit: AgentFileListInputSchema.shape.limit.unwrap().optional() },
      (args, extra) => invoke('files.list', args, extra), { annotations: { readOnlyHint: true, openWorldHint: false } }),
    sdk.tool('files.read', 'Read bounded bytes of exact file and revision pins. Markdown includes UTF-8 text alongside the base64 bytes.',
      { ...AgentFileReadInputSchema.shape, offset: AgentFileReadInputSchema.shape.offset.unwrap().optional(), length: AgentFileReadInputSchema.shape.length.unwrap().optional() },
      (args, extra) => invoke('files.read', args, extra), { annotations: { readOnlyHint: true, openWorldHint: false } }),
    ...(input.allowMutation ? [
      sdk.tool('files.create_working_copy', 'Create a temporary owned artifact from authorized pinned bytes.', AgentFileCreateWorkingCopyInputSchema.shape,
        (args, extra) => invoke('files.create_working_copy', args, extra)),
      sdk.tool('files.write_working_copy', 'Replace bytes of an owned temporary working copy.', AgentFileWriteWorkingCopyInputSchema.shape,
        (args, extra) => invoke('files.write_working_copy', args, extra)),
      sdk.tool('files.apply_format_edit', 'Edit an owned temporary working copy using the shared format contract.', AgentFileApplyFormatEditInputSchema.shape,
        (args, extra) => invoke('files.apply_format_edit', args, extra)),
      sdk.tool('files.publish_result', 'Publish a completed temporary artifact in its originating conversation.', AgentFilePublishInputSchema.shape,
        (args, extra) => invoke('files.publish_result', args, extra)),
    ] : []),
  ]
  const server = sdk.createSdkMcpServer({ name: 'graphql-files', version: '1.0.0', tools: definitions,
    instructions: 'File-only admitted native message tools. Scope fields assert the admitted conversation; they cannot select another owner. Permanent references are read-only.' })
  const manifest: ClaudeMcpToolManifest = { serverName: 'graphql-files',
    source: { kind: 'sdk', name: 'graphql-files', version: '1.0.0' },
    tools: definitions.map(definition => definition.name) }
  return { server, manifest }
}
