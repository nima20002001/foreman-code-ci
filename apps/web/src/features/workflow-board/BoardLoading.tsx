import { Skeleton } from '../../shared/ui/nocturne'
import './workflowBoard.css'

/** The Board's own loading shape: same footprint as the authoring canvas, so the editor replaces it in place. */
export function BoardLoading() {
  return <section className="workflow-graph board-typed-editor board-loading" data-testid="board-loading" role="status" aria-busy="true">
    <span className="n-sr-only">Loading workflow…</span>
    <div className="workflow-graph-canvas" aria-hidden="true">
      <div className="board-topbar">
        <div className="board-title"><Skeleton width="12rem" height="1.25rem" /></div>
        <div className="board-control-cluster"><Skeleton width="9rem" height="2rem" /></div>
      </div>
      <div className="board-loading-nodes">
        <Skeleton width="11rem" height="4.5rem" /><Skeleton width="11rem" height="4.5rem" /><Skeleton width="11rem" height="4.5rem" />
      </div>
    </div>
  </section>
}
