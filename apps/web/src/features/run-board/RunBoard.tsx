import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunBoardNodeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { runReadErrorLabel, useSelectedRunSnapshot } from '../runs-selector/query'
import { SelectedNodePlacement } from '../node-placement/SelectedNodePlacement'
import { RunNodeInspector } from './RunNodeInspector'
import { useRunNodeInspectionNavigation } from './inspectionNavigation'
import { RunBoardCanvas } from './RunBoardCanvas'
import { useRunVersionQuery } from '../workflow-board/inspect/queries'
import { SavedWorkflowWorktree } from '../workflow-board/SavedWorkflowWorktree'
import './runBoard.css'
import { useWorkflowBoard } from '../workflow-board/context'
import { useHierarchy } from '../workflow-hierarchy/queries'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import type { AvailableRunBoardSnapshot } from './model'

export type RunBoardProps = { selection: SelectedRunState }

/** Accept the SAME selected-Run hook result as RunsSelector, including its visit
 * generation. A naked runId loses the A -> B -> A fence. Query owns every read.
 */
export function RunBoard({ selection }: RunBoardProps) {
  const query = useSelectedRunSnapshot(selection)
  const inspection = useRunNodeInspectionNavigation(selection)
  const board = useWorkflowBoard()
  if (!selection.active) return null
  if (selection.invalid) return <section className="run-board" aria-label="Selected Run board"><p role="status">Invalid Run</p></section>
  if (selection.identity.runId === null) return null

  const current = selection.isCurrent(selection.generation)
  const snapshot = current ? query.snapshot : undefined
  const failed = current && query.isError && !snapshot
  const loading = !failed && !snapshot
  return <section className={!board && inspection.nodeId ? 'run-board run-board-inspecting' : 'run-board'}
    aria-label="Selected Run board" aria-busy={loading}
    data-run-id={selection.identity.runId} data-generation={selection.generation.id}>
    {query.isError && snapshot ? <p role="status">Run refresh failed. Showing the last successful read.
      <button type="button" onClick={() => void query.refetch()}>Retry Run refresh</button></p> : null}
    {failed ? <div className="run-board-message" role="status">
      <span>{runReadErrorLabel(query.error)}</span>
      <button type="button" onClick={() => {
        if (selection.isCurrent(selection.generation)) void query.refetch()
      }}>Retry</button>
    </div> : loading ? <p role="status">{query.isPaused ? 'Offline' : 'Loading…'}</p>
      : snapshot?.kind === 'unavailable' ? <p role="status">Snapshot unavailable</p>
      : snapshot?.kind === 'available' ? <RunBoardContents selection={selection} snapshot={snapshot} inspection={inspection}
        activitySnapshot={query.activitySnapshot} /> : null}
  </section>
}

function RunBoardContents({ selection, snapshot, inspection, activitySnapshot }: {
  selection: SelectedRunState; snapshot: AvailableRunBoardSnapshot;
  inspection: ReturnType<typeof useRunNodeInspectionNavigation>;
  activitySnapshot: ReturnType<typeof useSelectedRunSnapshot>['activitySnapshot']
}) {
  const board = useWorkflowBoard()
  const visible = board?.canvasVisible !== false && !board?.memoryOpen
  const hierarchy = useHierarchy({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId },
    { enabled: visible })
  const denied = useProtectedAccessError(hierarchy)
  const saved = !denied && hierarchy.data?.workflowVersionId === snapshot.workflowVersionId ? hierarchy.data : undefined
  const panel = board?.sidePanel
  const inspect = visible && !!inspection.nodeId && (!board || panel?.kind === 'agent' && panel.tab === 'details')
  const details = inspect ? <RunNodeInspector key={`inspector:${selection.generation.id}:${inspection.nodeId}`}
    selection={selection} snapshot={snapshot} nodeId={inspection.nodeId!} hierarchy={saved}
    executionId={inspection.executionId} onInspect={inspection.inspect} /> : null
  const settings = panel?.kind === 'agent' && panel.tab === 'settings' && !board?.memoryOpen
    ? <section aria-label="Saved Agent settings"><h3>{snapshot.nodes.find(node => node.id === panel.nodeId)?.name ?? panel.nodeId}</h3>
      <p>This Run keeps its saved Agent configuration. Return to the draft to edit settings for future Runs.</p></section> : null
  return <>
    <span className="run-board-label">Read only</span>
    <RunDefaultWorktree selection={selection} workflowVersionId={snapshot.workflowVersionId} />
    {snapshot.nodes.length ? <RunBoardCanvas key={selection.generation.id} snapshot={snapshot} visible={visible}
      hierarchy={saved} activitySnapshot={activitySnapshot} onInspectNode={inspection.inspect} /> : <p role="status">No nodes</p>}
    {board ? board.sidePanelHost ? createPortal(<>{details}{settings}
      {!visible && !board.memoryOpen && panel?.kind === 'agent' && panel.tab === 'details'
        ? <p>Open Graph to inspect this saved execution. Your selection is retained.</p> : null}
    </>, board.sidePanelHost) : null : details}
    {visible ? <SelectedRunComputers key={`placement:${selection.generation.id}`} selection={selection} nodes={snapshot.nodes} /> : null}
  </>
}

function RunDefaultWorktree({ selection, workflowVersionId }: {
  selection: SelectedRunState; workflowVersionId: string
}) {
  const scope = { ...selection.identity, runId: selection.identity.runId!, workflowVersionId,
    executionSemanticsVersion: 3 as const }
  const version = useRunVersionQuery(scope)
  if (!selection.isCurrent(selection.generation)) return null
  if (version.isError) return <p role="status">Saved default worktree is unavailable for this Run.</p>
  if (!version.data) return <p role="status">Reading this Run’s saved default worktree…</p>
  return <SavedWorkflowWorktree workspaceId={scope.workspaceId} value={version.data.version.definition.defaultWorktree} />
}

function SelectedRunComputers({ selection, nodes }: { selection: SelectedRunState; nodes: readonly RunBoardNodeSnapshot[] }) {
  const [open, setOpen] = useState(false)
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Computers accepted for this Run</summary>
    {open ? nodes.map((node) => <section key={node.id} aria-label={`Computer evidence for ${node.name}`}>
      <h3>{node.name}</h3><SelectedNodePlacement selection={selection} nodeId={node.id} />
    </section>) : null}
  </details>
}
