import type { ReactNode } from 'react'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { RunBoard } from './RunBoard'
import './runBoard.css'

/** Keep the editor owner, DOM and buffered draft mounted at the SAME React key.
 * Pass the complete current-board UI (including Start/Save), not just its canvas.
 * The host must retain its existing guards for body-portalled authoring dialogs.
 */
export function RunBoardSlot({ selection, children }: { selection: SelectedRunState; children: ReactNode }) {
  const current = selection.active && !selection.invalid && selection.identity.runId === null
  return <div className="run-board-slot">
    <div className="run-board-current" hidden={!current} inert={!current}>{children}</div>
    {!current ? <RunBoard selection={selection} /> : null}
  </div>
}
