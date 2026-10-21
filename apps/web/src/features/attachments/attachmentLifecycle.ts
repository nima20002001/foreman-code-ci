import {
  FilePageSchema, MAX_FILE_PAGE_SIZE, type File as FileMetadata, type FilePage, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import { attachmentDraftKey } from './attachmentFiles'

export const attachmentLifecycleQueryKey = ['chat-attachment-lifecycle'] as const

/** Only lifecycle metadata is refreshed. List discovery heads never replace a send pin. */
export async function readAttachmentLifecycle(scope: TemporaryFileScope, original: FileMetadata,
  signal: AbortSignal): Promise<FileMetadata> {
  const chat = scope.chat
  const conversation = encodeURIComponent(chat.conversationId)
  const root = chat.kind === 'operator' ? `/api/operator/conversations/${conversation}/files`
    : `/api/workspaces/${encodeURIComponent(chat.workspaceId)}/agent-chat/conversations/${conversation}/files`
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const query: URLSearchParams = new URLSearchParams({ limit: String(MAX_FILE_PAGE_SIZE), ...(cursor ? { cursor } : {}) })
    const page: FilePage = await apiClient.request(`${root}?${query}`, FilePageSchema, { signal })
    for (const { file } of page.items) {
      if (file.scope.kind !== 'temporary' || attachmentDraftKey(file.scope) !== attachmentDraftKey(scope)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The file list does not match this conversation.' })
      }
      if (file.fileId === original.fileId) {
        if (file.createdAt !== original.createdAt) {
          throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The file identity changed.' })
        }
        return file
      }
    }
    cursor = page.pageInfo.nextCursor
    if (cursor && seen.has(cursor)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The file list did not advance.' })
    if (cursor) seen.add(cursor)
  } while (cursor)
  throw new ApiError({ code: 'FILE_NOT_FOUND', message: 'The attachment could not be checked.' }, 404)
}
