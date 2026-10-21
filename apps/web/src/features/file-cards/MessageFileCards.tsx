import type { FileWithRevision, MessageAttachmentRef } from '@foreman-code/contracts/files'
import { FileCard } from './FileCard'
import type { FileCardClient } from './fileCardClient'
import { fileCardKey, resolveMessageFileCards } from './fileCardPresentation'

export interface MessageFileCardsProps {
  /** Message refs determine order and identity. A missing historical DTO is never replaced by latest. */
  attachments: readonly MessageAttachmentRef[]
  files: readonly FileWithRevision[]
  client: FileCardClient
}

export function MessageFileCards({ attachments, files, client }: MessageFileCardsProps) {
  if (!attachments.length) return null
  const resolved = resolveMessageFileCards(attachments, files)
  return <ul className="file-cards" aria-label="Message files">
    {attachments.map((attachment, index) => {
      const file = resolved[index]
      return <li key={fileCardKey(attachment)}>
        {file ? <FileCard attachment={attachment} file={file} client={client} />
          : <span className="file-card__unavailable" role="status">Unavailable</span>}
      </li>
    })}
  </ul>
}
