import { useEffect } from 'react'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { dismissBoardNotice, useBoardUndo } from './boardUndo'

/** Bottom-right note naming what the last undo or redo changed on this Board. */
export function BoardUndoNotice({ scope }: { scope: string }) {
  const notice = useBoardUndo((state) => state.notice?.scope === scope ? state.notice : undefined)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => dismissBoardNotice(notice.id), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return <div className="board-undo-notice" role="status" aria-live="polite">
    <Icon name="history" size={15} /><span>{notice.text}</span>
    <IconButton size="sm" variant="ghost" label="Dismiss" onClick={() => dismissBoardNotice(notice.id)}><Icon name="close" size={12} /></IconButton>
  </div>
}
