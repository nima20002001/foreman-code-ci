import { InfoHint } from '../../../shared/ui/InfoHint'
import { flushSync } from 'react-dom'
import { useGraphDraftStore } from '../store'
import { WorkflowSettings } from './WorkflowSettings'
import { BoardNotice } from './BoardNotice'
import { Inbox, Redo2, Save, Undo2 } from 'lucide-react'
import { ActionMenu, Button, ConfirmDialog, EmptyState, Icon, IconButton, Toolbar } from '../../../shared/ui/nocturne'
import { nodeTitle, removeRelationship } from './model'
import { nextDraftDirty, type NextDraftEdit } from './state'
import { WorkflowSaveError } from './WorkflowSaveError'
import { EditIntentStatus } from './EditIntentStatus'
import { ConflictRecoveryPanel } from './ConflictRecoveryPanel'
import { CreateBoardAgent } from '../../workflow-hierarchy/CreateBoardAgent'
import { RemoveHierarchyNodeDialog } from '../../workflow-hierarchy/RemoveHierarchyNodeDialog'
import { AvailableAgentList } from './AuthoringFields'
import { DraftCanvas } from './DraftCanvas'
import { AgentPickerPanel } from '../../workflow-board/AgentPickerPanel'
import { WorkflowName } from '../../workflow-board/WorkflowName'
import { WorkflowWorktreeField } from '../../workflow-board/WorkflowWorktreeField'
import { BoardUndoNotice } from '../../workflow-board/BoardUndoNotice'
import { BoardAlerts, type BoardUpdateFailure } from '../../workflow-board/BoardAlerts'
import { RemoveWorkflowButton } from '../../workflows/RemoveWorkflowButton'
import { useApprovalInboxStore } from '../../approvals'
import { raiseFloating, useFloatingZ } from '../../../shared/ui/floatingStack'
import { RepeatEditor } from '../../repeats/RepeatEditor'
import type { useDraftEditorController } from './useDraftEditorController'

const kindName = (kind: 'execution' | 'approval') => kind === 'approval' ? 'Approval' : 'Handoff'

export function DraftEditorView({ draftKey, edit, updateFailures, controller }: {
  draftKey: string
  edit: NextDraftEdit
  updateFailures?: readonly BoardUpdateFailure[]
  controller: ReturnType<typeof useDraftEditorController>
}) {
  const { graph, context, board, editIntent, undoScope, core, preflight, pendingStart,
    reloading, stopAndSave, discardChanges, reload, inspectLatest, startMutation, starting, start, recoverStart,
    workspace, managedWorkflow, pendingApprovals, agents, hints, requestSave, historyAction, openAgent, panels,
    scheduleWrite, historyPending } = controller
  const { panel, setPanel, settingsPanel, workflowName, openSaveField, openNode, setOpenNode, confirm, setConfirm, runAfterSave,
    message, setGeometryPending, canvas, presentation, change, geometry, report, inspect, openPanel, prepare } = core
  const { dirty, needsSave, canUndo, canRedo, startReloadRequired, startDisabled, startReason, saveBusy,
    affectedRuns, affectedWorkflows, stopBlocked, errorText, locationMessage, panelTitle } = controller.status
  const repeatOpen = panel === 'repeat', settingsOpen = !!panel && panel !== 'repeat' && panel !== 'agents'
  const repeatZ = useFloatingZ('board-repeat', repeatOpen), settingsZ = useFloatingZ('board-settings', settingsOpen)
  return <section className="workflow-graph board-typed-editor" aria-label="Workflow authoring">
    <div className="workflow-graph-canvas">
      <DraftCanvas ref={canvas} draftKey={draftKey} graph={graph} agents={agents} kind="execution"
        baseGraph={edit.context.savedDraft?.graph ?? edit.context.draft.graph}
        semanticLocked={edit.busy || reloading || editIntent.locked || starting || !!edit.pending || !!pendingStart}
        change={change} geometry={geometry} pending={setGeometryPending} report={report} inspect={inspect}
        removalDisabled={edit.busy || reloading || editIntent.locked}
        open={openNode} setOpen={setOpenNode} panels={panels} />
      {!graph.nodes.length ? <div className="board-empty"><EmptyState icon="bot" title="Add your first agent"
        action={<><InfoHint label="Add your first agent">Start with a Master that coordinates teams, an Orchestrator, or a Worker.</InfoHint>
          <Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={() => openPanel('agents')}>Add node</Button>
          <Button onClick={() => void prepare(() => {
            useGraphDraftStore.getState().updateNextDraft(draftKey, current => current.workflowForms?.createAgent ? current : {
              ...current, workflowForms: { ...current.workflowForms, createAgent: { role: 'master', name: '', parentNodeId: '' } },
            })
            setPanel('agents')
          }).catch(report)}>{edit.workflowForms?.createAgent ? 'Continue Agent draft' : 'Add Master'}</Button>
        </>} /></div> : null}
      <header className="board-topbar">
        <div className="board-title">
          <WorkflowName ref={workflowName} name={graph.name} disabled={saveBusy || starting || editIntent.locked}
            onRename={(name) => change((current) => ({ ...current, name }))} />
          <WorkflowWorktreeField workspaceId={graph.workspaceId} value={graph.defaultWorktree}
            savedValue={(edit.context.savedDraft ?? edit.context.draft).graph.defaultWorktree}
            disabled={edit.busy || reloading || editIntent.locked || starting || !!edit.pending || !!pendingStart}
            onChange={defaultWorktree => change(current => {
              const updated = { ...current }
              if (defaultWorktree) updated.defaultWorktree = defaultWorktree
              else delete updated.defaultWorktree
              return updated
            })} />
        </div>
        <div className="board-control-cluster">
          {needsSave || edit.pending || editIntent.locked || canUndo || canRedo ? <Toolbar label="Draft actions">
            {canUndo ? <IconButton label="Undo" variant="ghost" disabled={saveBusy || starting || editIntent.locked || historyPending || scheduleWrite.pending}
              onClick={() => historyAction('undo')}><Undo2 aria-hidden="true" size={16} /></IconButton> : null}
            {canRedo ? <IconButton label="Redo" variant="ghost" disabled={saveBusy || starting || editIntent.locked || historyPending || scheduleWrite.pending}
              onClick={() => historyAction('redo')}><Redo2 aria-hidden="true" size={16} /></IconButton> : null}
            {dirty ? <IconButton label="Discard changes" variant="ghost" disabled={saveBusy || starting} onClick={() => setConfirm('discard')}><Icon name="close" size={22} /></IconButton> : null}
            {needsSave || edit.pending || editIntent.locked ? <>
            {edit.pending ? <Button disabled={saveBusy || starting} onClick={requestSave}>Retry save</Button> : null}
            {editIntent.locked ? <Button disabled={saveBusy || starting || !!editIntent.storageError || stopBlocked} onClick={requestSave}>
              {affectedRuns.length ? 'Stop affected Runs and save' : 'Reconcile Save'}</Button>
              : <IconButton label="Save workflow" disabled={saveBusy || starting || !!editIntent.storageError} onClick={requestSave}><Save aria-hidden="true" size={16} /></IconButton>}
            </> : null}
          </Toolbar> : null}
        {board?.navigationControls}
        <Toolbar label="Workflow controls">
          <RemoveWorkflowButton workspaceId={graph.workspaceId} workflowId={graph.id} name={graph.name}
            revision={managedWorkflow.data?.revision ?? context.draft.publishedRevision}
            renderTrigger={(remove) => <ActionMenu label="Workflow actions" icon="gear" width={220} disabled={saveBusy || starting || editIntent.locked} items={[
              { id: 'rename', label: 'Rename', onSelect: () => workflowName.current?.begin() },
              { id: 'remove', label: 'Remove workflow', icon: 'trash', danger: true, disabled: !managedWorkflow.isSuccess || dirty,
                description: dirty ? 'Save or discard draft changes first.' : undefined,
                onSelect: () => void prepare(remove) },
            ]} />} />
          <IconButton label="Add agent or job to graph" onClick={() => openPanel('agents')}><Icon name="plus" size={16} /></IconButton>
          <IconButton label="Workflow settings" onClick={() => openPanel('workflow')}><Icon name="settings" size={16} /></IconButton>
          <Button variant="secondary" className="n-icon-button workflow-approval-inbox" aria-label={`Open human approval inbox${pendingApprovals ? `, ${pendingApprovals} pending` : ''}`}
            title="Approval inbox" onClick={() => useApprovalInboxStore.getState().openInbox({ workspaceId: graph.workspaceId, workflowId: graph.id })}><Inbox aria-hidden="true" size={16} />
            {pendingApprovals ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{pendingApprovals}</span> : null}</Button>
          {!graph.handoffs ? <Button size="sm" variant="ghost" onClick={() => openPanel('repeat')}>Repeats</Button> : null}
          {board ? <IconButton label="Activities" onClick={board.openRuns}><Icon name="history" size={16} /></IconButton> : null}
          <Button variant="primary" leading={<Icon name="play" size={14} />} aria-label={pendingStart ? 'Reconcile Start' : needsSave ? 'Save and run' : 'Start saved version'}
            title={startReason} disabled={startDisabled} loading={starting} onClick={() => void (pendingStart ? start() : prepare(() => needsSave ? startMutation.mutateAsync({ saveFirst: true }) : start())).catch(report)}>{pendingStart ? 'Confirm start' : needsSave ? 'Save and run' : 'Run'}</Button>
        </Toolbar>
        </div>
      </header>
      <BoardUndoNotice scope={undoScope} />
      <BoardAlerts scope={draftKey} hints={hints} validation={edit.validation} error={editIntent.mutation.error ?? undefined} updateFailures={updateFailures}
        pending={editIntent.mutation.isPending} openField={openSaveField} openIssue={(issue) => {
          if (issue.nodeId) openAgent(issue.nodeId)
          else if (issue.relationshipId) inspect(() => presentation.getState().setFocusedEdgeId(issue.relationshipId))
          else openPanel(issue.code === 'ENTRY_REQUIRED' && !graph.nodes.length ? 'agents' : 'workflow')
        }} />
      <div className="board-notices" aria-live="polite">
        {scheduleWrite.unconfirmed && scheduleWrite.command?.history ? <BoardNotice tone="warning"
          title="The schedule change may have gone through."
          action={<Button size="sm" disabled={scheduleWrite.pending || historyPending}
            onClick={() => historyAction(scheduleWrite.command!.history!.direction)}>Retry schedule change</Button>}>
          Confirm this change before editing the schedule or leaving the Board.</BoardNotice> : null}
        {!pendingStart && workspace.data && workspace.data.locationValidation.status !== 'ready'
          ? <BoardNotice tone="warning" title={locationMessage}
            action={<Button size="sm" onClick={board?.openLocation}>{workspace.data.locationValidation.status === 'unconfigured'
              ? 'Choose folder' : 'Review folder'}</Button>} /> : null}
        {pendingStart ? <BoardNotice tone="warning" title="An earlier start may have gone through."
          action={<><Button size="sm" disabled={starting} onClick={() => void start().catch(report)}>Check again</Button>
            <Button size="sm" disabled={starting} onClick={() => void recoverStart().catch(report)}>Recover Start</Button></>}>
          Confirm it before starting another run. Recovery finds the accepted Run or cancels the pending Start.</BoardNotice> : null}
        {startReloadRequired ? <BoardNotice tone="warning" title="Reload the saved draft before starting another Run."
          action={<Button size="sm" disabled={reloading} onClick={() => void reload()}>Reload saved draft</Button>}>
          Review the latest saved settings before starting again.</BoardNotice> : null}
        {message ? <BoardNotice tone="success" title={message} /> : null}
        {editIntent.storageError ? <BoardNotice tone="danger" live title="Changes can’t be kept in this browser.">{editIntent.storageError}</BoardNotice> : null}
        {editIntent.query.error ? <BoardNotice tone="warning" title="Couldn’t check the status of your last save.">Your changes are still here. {editIntent.query.error.message}</BoardNotice> : null}
        {editIntent.mutation.error ? <WorkflowSaveError error={editIntent.mutation.error} pending={editIntent.outboxPending || !!editIntent.intent && !['saved', 'discarded'].includes(editIntent.intent.state)} openField={openSaveField} /> : null}
        {editIntent.locked && !editIntent.sameDisplayedPayload ? <BoardNotice tone="warning" title="You made more edits after saving started.">They stay here and won’t be overwritten.</BoardNotice> : null}
        {editIntent.query.data?.intent && !['saved', 'discarded'].includes(editIntent.query.data.intent.state) ? <EditIntentStatus data={editIntent.query.data} /> : null}
        {errorText ? <BoardNotice noticeKey={errorText} tone="danger" live title={edit.error?.uncertain ? 'We couldn’t confirm whether that worked.' : 'Something went wrong.'}>
          {errorText}{edit.error?.issues?.length ? <ul>{edit.error.issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul> : null}
        </BoardNotice> : null}
      </div>
      <aside className="board-side-panel" hidden={!repeatOpen} style={repeatOpen ? { zIndex: repeatZ } : { display: 'none' }} aria-label="Business repeats"
        onPointerDownCapture={() => raiseFloating('board-repeat')} onFocusCapture={() => raiseFloating('board-repeat')}>
        <header><h2>Business repeats</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <RepeatEditor graph={graph} change={change} disabled={edit.busy || reloading || editIntent.locked || !!edit.pending || !!pendingStart} />
      </aside>
      {panel === 'agents' ? <AgentPickerPanel close={() => openPanel(null)}>
        <fieldset disabled={edit.busy || reloading || editIntent.locked || starting}>
          <CreateBoardAgent draftKey={draftKey} edit={edit} report={report} close={() => setPanel(null)}
            openSettings={nodeId => { flushSync(() => setPanel(null)); openAgent(nodeId) }} />
          <AvailableAgentList context={context} change={change} report={report} agentEdits={edit.agentEdits} />
        </fieldset>
      </AgentPickerPanel> : null}
      {settingsOpen ? <aside ref={settingsPanel} className="board-side-panel" aria-label={panelTitle || 'Board controls'} style={{ zIndex: settingsZ }}
        onPointerDownCapture={() => raiseFloating('board-settings')} onFocusCapture={() => raiseFloating('board-settings')}>
        <header><h2>{panelTitle}</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <fieldset disabled={edit.busy || reloading || editIntent.locked}>
          {panel === 'workflow' ? <WorkflowSettings draftKey={draftKey} edit={edit} change={change} report={report}
            defaultMs={preflight.data?.capabilities.agentActiveTimeBudget.defaultMs}
            locationReady={workspace.data?.locationValidation.status === 'ready'} locationMessage={locationMessage}
            onChangeFolder={board?.openLocation} onReload={() => {
              if (nextDraftDirty(edit)) setConfirm('reload'); else void reload()
            }} /> : null}
          {panel === 'workflow' ? <ConflictRecoveryPanel draftKey={draftKey} edit={edit}
            pending={reloading || edit.busy || !!edit.pending || editIntent.locked || starting}
            inspectLatest={inspectLatest} report={report} /> : null}
        </fieldset>
      </aside> : null}
      <nav className="board-keyboard-list" aria-label="Agents and connections">
        {graph.nodes.map((node) => <Button size="sm" variant="ghost" key={node.id} onClick={() => openAgent(node.id)}>
          {graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}</Button>)}
        {graph.edges.map((edge) => <Button size="sm" variant="ghost" key={edge.id}
          disabled={edit.busy || reloading || editIntent.locked}
          onClick={() => change((value) => removeRelationship(value, edge.id))}>
          Remove {kindName(edge.kind)} · {nodeTitle(graph, edge.source)} → {nodeTitle(graph, edge.target)}</Button>)}
      </nav>
    </div>
    <ConfirmDialog open={confirm === 'save' && affectedRuns.length > 0 && !stopBlocked} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Stop running work and save?"
      description={`${affectedRuns.length} affected ${affectedRuns.length === 1 ? 'Run requires' : 'Runs require'} Stop or cleanup across ${affectedWorkflows} ${affectedWorkflows === 1 ? 'workflow' : 'workflows'}.${affectedRuns.some((item) => item.pin.workflowId !== graph.id) ? ' This includes shared-Agent work in another workflow.' : ''} Stop-and-save stops every affected Run and waits for full cleanup before saving. Stopped runs are not restarted.`}
      confirmLabel="Stop runs and save" onConfirm={() => { setConfirm(undefined); void prepare(() => runAfterSave.current ? startMutation.mutateAsync({ saveFirst: true, allowStop: true }) : stopAndSave(true)).catch(report) }} />
    <ConfirmDialog open={confirm === 'discard'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Discard your changes?"
      description="Your unsaved edits are removed. Agent positions on the board are kept. Running work isn’t affected."
      confirmLabel="Discard changes" onConfirm={() => { setConfirm(undefined); void prepare(discardChanges).catch(report) }} />
    <ConfirmDialog open={confirm === 'reload'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Inspect the latest saved workflow?"
      description="Your unsaved draft is kept separately for comparison. A fresh editor opens the latest saved workflow."
      confirmLabel="Inspect latest" onConfirm={() => { setConfirm(undefined); void inspectLatest() }} />
    <RemoveHierarchyNodeDialog draftKey={draftKey} edit={edit} pending={reloading || saveBusy || starting || editIntent.locked}
      report={report} inspectLatest={inspectLatest} />
  </section>
}
