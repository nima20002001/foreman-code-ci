import type { CallToolResult } from '@modelcontextprotocol/server'
import { ZodError } from 'zod'

import { DomainError, databaseConnectionFailure, databaseReadFailure, publicFailureClass } from '../../modules/errors.js'
import { FileTransferError } from '../../modules/files/tools/transfers.js'
import { deviceBusyFailure } from '../../modules/devices/deviceBusyError.js'

export function toolResult(value: unknown): CallToolResult {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
  const json = JSON.stringify(structuredContent)
  // Some MCP clients read structuredContent only when content is empty.
  const content: CallToolResult['content'] = Buffer.byteLength(json, 'utf8') <= TEXT_MIRROR_BYTES
    ? [{ type: 'text', text: json }] : []
  return { content, structuredContent }
}
export const TEXT_MIRROR_BYTES = 256 * 1024

export function toolFailure(error: unknown, internalMessage = 'The Operator service could not complete the request.'): CallToolResult {
  error = databaseConnectionFailure(databaseReadFailure(deviceBusyFailure(error)))
  // Only this explicitly public, static executable-validation issue is safe
  // to disclose. Other schema failures can contain private stored evidence and
  // retain their existing generic error. Match HTTP's INVALID_REQUEST shape.
  if (error instanceof ZodError) {
    const issues = error.issues.filter((issue) => issue.code === 'custom'
      && issue.params?.publicCode === 'REPEAT_REVIEW_SCOPE_UNSUPPORTED')
    if (issues.length) error = new DomainError('INVALID_REQUEST', 'The request does not match its shared contract.', 400, {
      issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
    })
  }
  if (error instanceof FileTransferError) error = new DomainError(error.code, error.message, 409)
  if (!(error instanceof DomainError)) console.error('DIAG-TOOLFAILURE', error)
  const failureClass = publicFailureClass(error)
  const classified = failureClass ? { class: failureClass } : {}
  const body = error instanceof DomainError
    ? { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), ...classified } }
    : { error: { code: 'INTERNAL_ERROR', message: internalMessage, ...classified } }
  // No structuredContent: it must match the tool's success outputSchema, and
  // Clients may validate it even on isError, masking the error.
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }
}
