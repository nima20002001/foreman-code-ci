import { McpServer } from '@modelcontextprotocol/server'
import { ZodError } from 'zod'
import {
  AgentFileListInputSchema, AgentFileListResultSchema, AgentFileReadInputSchema, AgentFileReadResultSchema,
  AgentFileCreateWorkingCopyInputSchema, AgentFileCreateWorkingCopyResultSchema,
  AgentFilePublishInputSchema, AgentFilePublishResultSchema,
  AgentFileWriteWorkingCopyInputSchema, AgentFileWriteWorkingCopyResultSchema,
  AgentFileApplyFormatEditInputSchema, AgentFileApplyFormatEditResultSchema,
} from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { isMutation } from './context.js'
import type { AgentFileToolService } from './service.js'
import { FileTransferError } from './transfers.js'
import { ALL_FILE_TOOL_NAMES, type FileToolOperation } from './types.js'
import { markdownReadText } from './markdownReadText.js'

/** A native facade may wrap these operations without changing any frozen tool schema. */
export type FileMcpService = Pick<AgentFileToolService, 'list' | 'read' | 'createWorkingCopy' | 'publish'>
  & Partial<Pick<AgentFileToolService, 'writeWorkingCopy' | 'applyFormatEdit'>> & {
  sessions: Pick<AgentFileToolService['sessions'], 'authenticate'>
    & Partial<Pick<AgentFileToolService['sessions'], 'authenticateSharedEndpoint'>>
    & { discover?: AgentFileToolService['sessions']['authenticate'] }
  /** Trusted runner annotation only; never a tool input or an immutable source path. */
  workingCopyLocation?(token: string, artifactId: string): Promise<string>
}

const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false })

export async function createFileMcpServer(service: FileMcpService, token: string): Promise<McpServer> {
  const discover = service.sessions.discover ?? service.sessions.authenticate.bind(service.sessions)
  const caller = await discover(token)
  const enabled = new Set<FileToolOperation>()
  for (const name of ALL_FILE_TOOL_NAMES) {
    if (!caller.context.allowedTools.includes(name) || (isMutation(name) && !caller.context.allowMutation)) continue
    try { await discover(token, name); enabled.add(name) }
    catch (error) { if (!(error instanceof DomainError) || error.status !== 403) throw error }
  }
  const allowed = (name: FileToolOperation) => enabled.has(name)
  const server = new McpServer({ name: 'graphql-files', version: '1.0.0' }, { instructions:
    `File-only tools for this authenticated native turn. No workflow Foreman Code tools, worker authority, or Operator credentials. `
    + `Scope/destination fields are assertions, not selectors; use ${JSON.stringify(caller.context.scope)}. `
    + 'Permanent references are read-only. Writes require the accepted harness to permit mutation. Publish only completed runner artifact handles.' })
  const invoke = async <T>(operation: () => Promise<T>, describe?: (value: T) => Promise<string | undefined>) => {
    try {
      const value = await operation()
      const result = toolResult(value)
      const detail = await describe?.(value)
      return detail ? { ...result, content: [...result.content, { type: 'text' as const, text: detail }] } : result
    }
    catch (error) {
      const publicError = error instanceof ZodError ? new DomainError('INVALID_REQUEST', 'The input does not match the shared file contract.', 400)
        : error instanceof FileTransferError ? new DomainError(error.code, error.message, 409) : error
      return toolFailure(publicError, 'The file service could not complete the request.')
    }
  }
  if (allowed('files.list')) server.registerTool('files.list', {
    description: 'List a bounded metadata-only manifest for the authenticated conversation. Reference manifests require FIL-37. Scope cannot change the caller context.',
    inputSchema: AgentFileListInputSchema, outputSchema: AgentFileListResultSchema, annotations: annotations(false),
  }, async (input) => invoke(() => service.list(token, input)))
  if (allowed('files.read')) server.registerTool('files.read', {
    description: 'Read at most 64 KiB using exact fileId and revisionId pins. Markdown includes UTF-8 text alongside the base64 bytes. Expired or removed files return unavailable; never substitute a newer revision.',
    inputSchema: AgentFileReadInputSchema, outputSchema: AgentFileReadResultSchema, annotations: annotations(false),
  }, async (input) => invoke(() => service.read(token, input), async (result) => markdownReadText(result)))
  if (allowed('files.create_working_copy')) server.registerTool('files.create_working_copy', {
    description: 'Copy authorized pinned bytes to an isolated runner artifact handle in this authenticated turn. No host path or permanent write target is accepted.',
    inputSchema: AgentFileCreateWorkingCopyInputSchema, outputSchema: AgentFileCreateWorkingCopyResultSchema, annotations: annotations(true),
  }, async (input) => invoke(() => service.createWorkingCopy(token, input), async (result) => {
    const path = await service.workingCopyLocation?.(token, result.value.artifactId)
    return path ? JSON.stringify({ artifactId: result.value.artifactId, path }) : undefined
  }))
  if (allowed('files.publish_result')) server.registerTool('files.publish_result', {
    description: 'Publish a completed artifact as new immutable temporary file/revision IDs in its originating conversation, linked to this turn. commandId is the retry key; changed bytes conflict.',
    inputSchema: AgentFilePublishInputSchema, outputSchema: AgentFilePublishResultSchema, annotations: annotations(true),
  }, async (input) => invoke(() => service.publish(token, input)))
  // Old native facades do not advertise new operations until their safe dispatch is wired.
  if (service.writeWorkingCopy && allowed('files.write_working_copy')) server.registerTool('files.write_working_copy', {
    description: 'Replace all bytes of an owned temporary working-copy handle (at most 25 MiB, canonical base64). Optional baseRevisionId guards the working snapshot, not the source. Never writes project files or permanent references; publish separately.',
    inputSchema: AgentFileWriteWorkingCopyInputSchema, outputSchema: AgentFileWriteWorkingCopyResultSchema,
    annotations: { ...annotations(true), destructiveHint: true, idempotentHint: false },
  }, async (input) => invoke(() => service.writeWorkingCopy!(token, input)))
  if (service.applyFormatEdit && allowed('files.apply_format_edit')) server.registerTool('files.apply_format_edit', {
    description: 'Edit an owned temporary working copy: append_text for Markdown/DOCX/PDF, resize_image, or replace_zip_entry for one existing regular entry. Server derives the format. Use baseRevisionId on retries to avoid applying an edit twice; publish separately. Project permissions do not change.',
    inputSchema: AgentFileApplyFormatEditInputSchema, outputSchema: AgentFileApplyFormatEditResultSchema,
    annotations: { ...annotations(true), destructiveHint: true, idempotentHint: false },
  }, async (input) => invoke(() => service.applyFormatEdit!(token, input)))
  return server
}

