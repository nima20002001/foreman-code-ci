import { useCallback, useState } from 'react'
import { Dialog } from '../../shared/ui/nocturne/Overlays'
import { MemoryBoard, type MemoryBoardInteraction, type MemoryBoardProps } from './MemoryBoard'

export interface MemoryBoardDialogProps extends MemoryBoardProps {
  open: boolean
  onOpenChange(open: boolean): void
  historicalRun?: boolean
  browserReleaseState?: 'ready' | 'pending' | 'unconfirmed'
}
/** D owns browser release and rail inertness. One shared Dialog hosts board and
 * card editors; its existing backdrop, Escape and focus behavior is preserved. */
export function MemoryBoardDialog({ open, onOpenChange, historicalRun, browserReleaseState = 'ready', onInteractionChange, ...board }: MemoryBoardDialogProps) {
  const [interaction, setInteraction] = useState<MemoryBoardInteraction>()
  const changed = useCallback((next: MemoryBoardInteraction | undefined) => {
    setInteraction(next); onInteractionChange?.(next)
  }, [onInteractionChange])
  return <Dialog open={open} size="xl" className="memory-board-dialog" title="Memory board"
    description="Live memory · shared across runs" closeLabel="Close memory board" busy={interaction?.pending}
    onOpenChange={(next) => {
      if (next) onOpenChange(true)
      else if (interaction) interaction.requestLeave(() => onOpenChange(false))
      else onOpenChange(false)
    }}>
    {historicalRun && <p>Showing current memory, not this run’s past state.</p>}
    {browserReleaseState === 'pending' && <p role="status">Returning browser control…</p>}
    {browserReleaseState === 'unconfirmed' && <p role="status">Browser control has not been confirmed returned.</p>}
    {open && <MemoryBoard {...board} onInteractionChange={changed} />}
  </Dialog>
}
