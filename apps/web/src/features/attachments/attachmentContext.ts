import { createContext } from 'react'
import type { AttachmentDrafts } from './attachmentDrafts'

export const AttachmentDraftContext = createContext<AttachmentDrafts | null>(null)
