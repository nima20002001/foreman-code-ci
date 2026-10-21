import { useEffect, useRef, useState } from 'react'
import { File as FileIcon, Paperclip, RotateCcw, X } from 'lucide-react'
import { IconButton, TextField } from '../../shared/ui/nocturne'
import { useFileDrop } from '../../shared/ui/useFileDrop'
import { ATTACHMENT_ACCEPT } from './attachmentFiles'
import type { AttachmentItem, ConversationAttachments } from './useConversationAttachments'
import './attachments.css'

function AttachmentThumbnail({ item }: { item: AttachmentItem }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!item.mediaType?.startsWith('image/') || typeof URL.createObjectURL !== 'function') return
    const preview = URL.createObjectURL(item.file)
    setUrl(preview)
    // View-owned URLs: revoke on remove, conversation switch and provider unmount.
    // The File stays in the conversation draft, so remounting can create a new URL.
    return () => URL.revokeObjectURL(preview)
  }, [item.file, item.mediaType])
  return url ? <img className="attachment-thumbnail" src={url} alt="" width={24} height={24} />
    : <FileIcon size={18} aria-hidden="true" className="attachment-file-icon" />
}

export function ChatAttachmentControl({ draft, disabled = false, composerDrop }: {
  draft: ConversationAttachments; disabled?: boolean; composerDrop?: Pick<ReturnType<typeof useFileDrop>, 'dropError' | 'clearDropError'>
}) {
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pickerTarget = useRef<ConversationAttachments['addFiles'] | null>(null)
  const drop = useFileDrop({ disabled: disabled || !draft.canAdd, onFiles: draft.addFiles })
  return <div className="attachment-control" {...(composerDrop ? {} : drop.dropTargetProps)}>
    <TextField ref={input} type="file" label="Choose attachments" className="attachment-picker"
      accept={ATTACHMENT_ACCEPT} multiple tabIndex={-1} disabled={disabled || !draft.canAdd}
      onChange={(event) => {
        drop.clearDropError(); composerDrop?.clearDropError()
        const files = Array.from(event.currentTarget.files ?? [])
        event.currentTarget.value = '' // Choosing the same file again must fire change.
        const addFiles = pickerTarget.current ?? draft.addFiles
        pickerTarget.current = null
        addFiles(files)
      }} />
    <IconButton ref={button} label="Attach files" size="sm" variant="ghost"
      disabled={disabled || !draft.canAdd} onClick={() => {
        // Even an OS picker left open across navigation belongs to its opening draft.
        pickerTarget.current = draft.addFiles
        input.current?.click()
      }}>
      <Paperclip size={18} aria-hidden="true" />
    </IconButton>
    <div className="attachment-content">
      {draft.items.length > 0 && <ul className="attachment-list" aria-label="Attachments">
        {draft.items.map((item) => <li className="attachment-chip" data-state={item.status} key={item.id}>
          <AttachmentThumbnail item={item} />
          <span className="attachment-name" title={item.filename}>{item.filename}</span>
          <span className="attachment-status" role="status" title={item.error ?? (item.status === 'ready' ? 'Ready to attach. Not sent.' : item.statusLabel)}>
            <span className="attachment-sr-only">{item.filename}: </span>{item.statusLabel}
            {item.error && <span className="attachment-sr-only">. {item.error}</span>}
            {item.status === 'ready' && <span className="attachment-sr-only">. Not sent.</span>}
          </span>
          {item.status === 'uploading' && <progress className="attachment-progress" max={100}
            value={item.progress ?? undefined} aria-label={`Uploading ${item.filename}`} />}
          {item.canRetry && <IconButton label={`Retry upload ${item.filename}`} size="sm" variant="ghost" disabled={disabled}
            onClick={() => draft.retry(item.id)}><RotateCcw size={14} aria-hidden="true" /></IconButton>}
          <IconButton label={`Remove attachment ${item.filename}`} size="sm" variant="ghost" disabled={disabled}
            onClick={() => { draft.remove(item.id); button.current?.focus() }}><X size={14} aria-hidden="true" /></IconButton>
        </li>)}
      </ul>}
      {draft.pickerIssue && <span className="attachment-picker-issue" role="alert">{draft.pickerIssue}</span>}
      {(drop.dropError || composerDrop?.dropError) && <span className="attachment-picker-issue" role="alert">{drop.dropError || composerDrop?.dropError}</span>}
    </div>
  </div>
}
