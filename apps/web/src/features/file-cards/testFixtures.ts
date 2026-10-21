import { createHash } from 'node:crypto'
import { FileWithRevisionSchema, FileRevisionSchema, temporaryFileExpiresAt, type FileMediaType, type FileScope, type FileState } from '@foreman-code/contracts/files'

export const TEST_DOWNLOAD_PATH = '/api/operator/conversations/conversation-a/files/{fileId}/revisions/{revisionId}/content'
export const TEST_HANDLER_PATH = '*/api/operator/conversations/conversation-a/files/:fileId/revisions/:revisionId/content'
export const TEST_AGENT_DOWNLOAD_PATH = '/api/workspaces/workspace-a/agent-chat/conversations/conversation-a/files/{fileId}/revisions/{revisionId}/content'
export const MIME_CASES = [
  ['image/png', 'picture.png'], ['image/jpeg', 'picture.jpg'], ['image/jpeg', 'picture.jpeg'],
  ['image/webp', 'picture.webp'], ['image/gif', 'picture.gif'], ['application/pdf', 'document.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document.docx'],
  ['text/markdown', 'notes.md'], ['application/zip', 'archive.zip'],
] as const

const imageBase64: Record<string, string> = {
  'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOomLYFAANMAcNBFdB9AAAAAElFTkSuQmCC',
  'image/jpeg': '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDQooor0jgP/9k=',
  'image/webp': 'UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoBAAEAAUAmJQBOl0AAhgAA/uJGvtTBJGUv+vgCniQAAA==',
  'image/gif': 'R0lGODdhAQABAIEAAHiWtAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==',
}
export function fixtureBytes(mediaType: FileMediaType): Uint8Array<ArrayBuffer> {
  // Binary images are real, one-pixel fixtures. Nonimages are inert test payloads: no parsing is requested.
  return new Uint8Array(imageBase64[mediaType] ? Buffer.from(imageBase64[mediaType], 'base64')
    : Buffer.from(mediaType === 'text/markdown' ? '# Notes\n<svg onload="alert(1)"></svg>\n' : 'inert attachment fixture'))
}
export function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

export const TEMP_SCOPE: FileScope = {
  kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner-a', operatorId: 'operator-a', conversationId: 'conversation-a' },
}
export const PERMANENT_SCOPES: FileScope[] = [
  { kind: 'workflow_reference', workspaceId: 'workspace-a', workflowId: 'workflow-a' },
  { kind: 'workspace_reference', workspaceId: 'workspace-a' },
]

export function fixture(options: {
  mediaType?: FileMediaType; filename?: string; state?: FileState; scope?: FileScope;
  fileId?: string; revisionId?: string; currentRevisionId?: string; createdAt?: string;
  retentionDurationSeconds?: number; bytes?: Uint8Array;
} = {}) {
  const mediaType = options.mediaType ?? 'text/markdown'
  const filename = options.filename ?? MIME_CASES.find(([mime]) => mime === mediaType)![1]
  const fileId = options.fileId ?? 'file-a'
  const revisionId = options.revisionId ?? 'revision-a'
  const scope = options.scope ?? TEMP_SCOPE
  const createdAt = options.createdAt ?? new Date(Date.now() - 60_000).toISOString()
  const retentionDurationSeconds = options.retentionDurationSeconds ?? 3 * 24 * 60 * 60
  const bytes = options.bytes ?? fixtureBytes(mediaType)
  const file=FileWithRevisionSchema.parse({
    file: {
      fileId, currentRevisionId: options.currentRevisionId ?? revisionId, scope,
      state: options.state ?? 'ready', createdAt,
      ...(scope.kind === 'temporary' ? {
        retentionDurationSeconds, expiresAt: temporaryFileExpiresAt(createdAt, retentionDurationSeconds),
      } : {}),
    },
    revision: { fileId, revisionId, filename, mediaType, byteSize: bytes.byteLength, sha256: hash(bytes), origin: 'upload', createdAt },
  })
  return {...file,revision:FileRevisionSchema.parse(file.revision)}
}
