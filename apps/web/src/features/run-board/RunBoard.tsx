import { useState } from 'react'
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

export type RunBoardProps = { selection: SelectedRunState }

/** Accept the SAME selected-Run hook result as RunsSelector, including its visit
 * generation. A naked runId loses the A -> B -> A fence. Query owns every read.
 */
export function RunBoard({ selection }: RunBoardProps) {
  const query = useSelectedRunSnapshot(selection)
  const inspection = useRunNodeInspectionNavigation(selection)
  if (!selection.active) return null
  if (selection.invalid) return <section className="run-board" aria-label="Selected Run board"><p role="status">Invalid Run</p></section>
  if (selection.identity.runId === null) return null

  const current = selection.isCurrent(selection.generation)
  const snapshot = current ? query.snapshot : undefined
  const failed = current && query.isError && !snapshot
  const loading = !failed && !snapshot
  return <section className={inspection.nodeId ? 'run-board run-board-inspecting' : 'run-board'}
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
      : snapshot?.kind === 'available' ? <>
        <span className="run-board-label">Read only</span>
        <RunDefaultWorktree selection={selection} workflowVersionId={snapshot.workflowVersionId} />
        {snapshot.nodes.length ? <RunBoardCanvas key={selection.generation.id} snapshot={snapshot}
          activitySnapshot={query.activitySnapshot} onInspectNode={inspection.inspect} /> : <p role="status">No nodes</p>}
        {inspection.nodeId ? <RunNodeInspector key={`inspector:${selection.generation.id}:${inspection.nodeId}`}
          selection={selection} snapshot={snapshot} nodeId={inspection.nodeId}
          executionId={inspection.executionId} onInspect={inspection.inspect} /> : null}
        <SelectedRunComputers key={`placement:${selection.generation.id}`} selection={selection} nodes={snapshot.nodes} />
      </> : null}
  </section>
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
