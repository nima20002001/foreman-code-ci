import { InfoHint } from '../../../shared/ui/InfoHint'
import type { PinnedPanelNode } from './DraftCanvas'
import { JobNodePanel } from '../../jobs'
import { AgentFacts, Button, EmptyState, type AgentPanel } from '../../../shared/ui/nocturne'
import { nodeTitle, removeNode, roleEvidence } from './model'
import { editorAgents } from './agentEdits'
import { type NextDraftEdit } from './state'
import { useGraphEditIntent } from './useGraphEditIntent'
import { NodeConnections, NodeWorkflowFields } from './AuthoringFields'
import { AgentInfoTabs } from '../../workflow-board/AgentInfoTabs'
import { type AgentPanels } from './DraftCanvas'
import { AgentChatPanel } from '../AgentPanels'
import { agentSettingRows } from '../signalEdge'
import { runNodeView, useSelectedRunRecord } from '../../workflow-board/runFacts'
import { useWorkflowBoard } from '../../workflow-board/context'
import { BoardAgentSettings } from '../../workflow-board/AgentControls'
import type { DraftEditorCore } from './useDraftEditorCore'

export function useDraftAgentPanels({ draftKey, edit, editIntent, core, board, reloading, agents }: {
  draftKey: string
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  core: DraftEditorCore
  board: ReturnType<typeof useWorkflowBoard>
  reloading: boolean
  agents: ReturnType<typeof editorAgents>
}) {
  const graph = edit.graph
  const context = edit.context
  const runRecord = useSelectedRunRecord()
  const { inspect, presentation, setOpenNode, setPanel, change, report } = core
  const openAgent = (nodeId: string, next: AgentPanel = 'settings') => inspect(() => {
    presentation.getState().setFocusedNodeId(nodeId); presentation.getState().setFocusedEdgeId(undefined)
    if (board?.selectSidePanel) board.selectSidePanel({ kind: 'agent', nodeId, tab: next === 'info' ? 'details' : next })
    else setOpenNode({ nodeId, panel: next })
  })
  const closePanel = () => board?.selectSidePanel ? board.selectSidePanel({ kind: 'none' }) : setOpenNode(undefined)
  const panels = (nodeId: string, pinned?: PinnedPanelNode): AgentPanels => {
    const node = pinned ? {...pinned,id:nodeId} : graph.nodes.find((item) => item.id === nodeId)
    if (!node) return { chat: null, settings: null, info: null }
    if('jobDefinitionId' in node) {
      const details=<JobNodePanel workspaceId={graph.workspaceId} definitionId={node.jobDefinitionId} definitionRevision={node.jobDefinitionRevision} definitionVersionId={node.jobDefinitionVersionId} workflowExecution={pinned?.kind==='job'?pinned.workflowExecution:undefined}/>
      return {chat:details,info:details,settings:pinned?details:<fieldset disabled={edit.busy||reloading||editIntent.locked}><p>Saved job revision {node.jobDefinitionRevision}</p><Button onClick={()=>{setOpenNode(undefined);change(value=>removeNode(value,node.id))}}>Remove job node</Button><NodeWorkflowFields graph={graph} node={node} context={context} agentEdits={edit.agentEdits} change={change}/></fieldset>}
    }
    const pinnedAgent = pinned?.kind !== 'job' ? pinned : undefined
    const agent = agents.find((item) => item.id === node.agentId)
    const run = runNodeView(runRecord, Boolean(board?.run), node.id, node.agentId)
    const statusLabel = board?.run ? [run.label, run.activity].filter(Boolean).join(' · ') : 'Draft'
    const savedGraph = (context.savedDraft ?? context.draft).graph
    const savedNode = savedGraph.nodes.some((item) =>
      item.kind !== 'job' && item.id === node.id && item.agentId === node.agentId)
    const unsavedChat = !pinned && !board?.run
      && (!context.draft.baseWorkflowVersionId || !agent?.configurationVersionId || !savedNode)
    const chat = unsavedChat ? <EmptyState icon="chat" title="Save this Agent and workflow to chat"
      description="Save the Agent settings and workflow changes, then reopen chat. Workflow alerts list any missing setup." />
      : <AgentChatPanel name={pinned?.name ?? nodeTitle(graph, node.id)} activity={run.activity} running={run.state === 'running'}
      role={pinnedAgent?.role ?? (agent?.productRole === 'master' ? 'Master' : agent?.productRole === 'orchestrator' ? 'Orchestrator' : 'Worker')} runLabel={pinnedAgent?.runLabel ?? run.label} onClose={() => inspect(closePanel)}
      context={{ workspaceId: graph.workspaceId, workflowId: graph.id, workflowNodeId: node.id, agentId: node.agentId,
        ...(board?.run ? { runId: board.run.runId } : {}) }}
      onNewConversation={() => {
        // Navigation only. Never replace/resume a missing native session under the old key.
        if (board?.run) {
          board.selectRun()
          if (graph.nodes.some((item) => item.id === node.id && item.kind!=='job' && item.agentId === node.agentId)) setOpenNode({ nodeId: node.id, panel: 'chat' })
          else { setOpenNode(undefined); setPanel('agents') }
        } else { setOpenNode(undefined); setPanel('agents') }
      }} />
    if (pinned) return { chat, chatHasHeader: true,
      settings: <h3>Settings<InfoHint label="Settings">This is a saved Run Agent. Return to the draft to edit settings for future work. Chat does not change this Run.</InfoHint></h3>,
      info: <AgentInfoTabs scope={board?.run} agentId={node.agentId} details={<AgentFacts items={[{ label: 'Status', value: statusLabel },
        { label: 'Node', value: node.id, mono: true }, { label: 'Agent', value: node.agentId, mono: true },
        { label: 'Run', value: board?.run?.runId, mono: true }]} />} /> }
    const role = roleEvidence(context, node.agentId, edit.agentEdits)
    return {
      chat,
      chatHasHeader: !unsavedChat,
      settings: <fieldset className="board-popover-fields" disabled={edit.busy || reloading || editIntent.locked}>
        <BoardAgentSettings draftKey={draftKey} edit={edit} nodeId={node.id} close={closePanel}
          remove={() => { setOpenNode(undefined); change((value) => removeNode(value, node.id)) }} />
        <NodeWorkflowFields graph={graph} node={graph.nodes.find((item) => item.id === node.id)!} context={context} agentEdits={edit.agentEdits} change={change} />
      </fieldset>,
      info: <AgentInfoTabs scope={board?.run} agentId={node.agentId} details={<>
        <AgentFacts items={[
          { label: 'Status', value: statusLabel },
          { label: 'Role', value: role.role === 'master' ? 'Master' : role.role === 'orchestrator' ? 'Orchestrator' : role.role === 'coder' ? 'Worker' : 'Unknown' },
          { label: 'Starts workflow', value: graph.entryNodeId === node.id ? 'Yes' : 'No' },
          ...(agent ? agentSettingRows(agent) : []),
        ]} />
        <fieldset className="board-popover-fields" disabled={edit.busy || reloading || editIntent.locked}>
          <NodeConnections graph={graph} nodeId={node.id} change={change} report={report} />
        </fieldset>
        <details className="next-draft-details"><summary>Identifiers</summary>
          <AgentFacts items={[{ label: 'Node', value: node.id, mono: true }, { label: 'Agent', value: node.agentId, mono: true },
            ...(role.configurationVersionId ? [{ label: 'Configuration', value: role.configurationVersionId, mono: true }] : [])]} />
        </details>
      </>} />,
    }
  }
  return { openAgent, panels }
}
