import {
  FILE_EXTENSIONS_BY_MEDIA_TYPE, FILE_MEDIA_TYPES, FileNameSchema, MAX_FILE_BYTES,
  TemporaryFileScopeSchema, type FileMediaType, type TemporaryFileScope,
} from '@foreman-code/contracts/files'

export const ATTACHMENT_ACCEPT = [
  ...FILE_MEDIA_TYPES,
  ...Object.values(FILE_EXTENSIONS_BY_MEDIA_TYPE).flat().map((extension) => `.${extension}`),
].join(',')

export interface SelectionIssue { label: string; message: string }
export type InspectedAttachment =
  | { ok: true; filename: string; mediaType: FileMediaType }
  | { ok: false; issue: SelectionIssue }

/** Picker hints are not byte validation. FIL-03 must independently inspect the bytes. */
export function inspectAttachment(file: File): InspectedAttachment {
  const name = FileNameSchema.safeParse(file.name)
  if (!name.success) return { ok: false, issue: { label: 'Invalid name', message: 'Use a filename of at most 255 characters, without paths or control characters.' } }
  if (file.size > MAX_FILE_BYTES) return { ok: false, issue: { label: 'Too large', message: `Files must be at most ${MAX_FILE_BYTES / 1024 / 1024} MiB.` } }
  const extension = name.data.includes('.') ? name.data.slice(name.data.lastIndexOf('.') + 1).toLowerCase() : ''
  const mediaType = FILE_MEDIA_TYPES.find((type) => FILE_EXTENSIONS_BY_MEDIA_TYPE[type].includes(extension))
  if (!mediaType) return { ok: false, issue: { label: 'Unsupported', message: 'Choose PNG, JPEG, WebP, GIF, PDF, DOCX, Markdown or ZIP.' } }
  // Empty/generic browser MIME values are common for Markdown and ZIP. Canonicalize
  // from the allowed extension, but reject a contradictory recognized MIME value.
  if (FILE_MEDIA_TYPES.some((type) => type === file.type) && file.type !== mediaType) {
    return { ok: false, issue: { label: 'Type mismatch', message: 'The filename extension and browser file type do not match.' } }
  }
  return { ok: true, filename: name.data, mediaType }
}

/** Fixed tuple order: object property order and optional undefined fields are irrelevant. */
export function attachmentDraftKey(input: TemporaryFileScope): string {
  const { chat } = TemporaryFileScopeSchema.parse(input)
  return JSON.stringify(chat.kind === 'operator'
    ? ['operator', chat.ownerPrincipalId, chat.operatorId, chat.conversationId]
    : ['agent', chat.workspaceId, chat.workflowId, chat.agentId, chat.conversationId, chat.runId ?? null, chat.executionId ?? null])
}
