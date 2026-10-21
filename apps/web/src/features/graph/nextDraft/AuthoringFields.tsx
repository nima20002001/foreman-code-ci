import { JOB_WORKFLOW_OUTCOMES } from '@foreman-code/contracts/job-workflow'
import { isHierarchyReportingRoute, withBrowserToolDefaults } from '@foreman-code/contracts'
import { useId, useState } from 'react'
import type { WorkflowDefinitionV3, WorkflowRelationship } from '@foreman-code/contracts/wave25'
import type { DraftAgentEdits } from './agentEdits'
import { changeApprovalHandler, entryChoices, nodeTitle, putRelationship,
  removeRelationship, roleEvidence, setWorkConnectionLimit, type DraftNode, type NextDraftContext } from './model'
import { WorkConnectionLimitEditor } from './WorkConnectionLimitEditor'
import { IntervalFields } from './IntervalFields'
import { Button, Icon, IconButton, SegmentedControl, Select, Switch, TextField, type SelectOption } from '../../../shared/ui/nocturne'
import { InfoHint } from '../../../shared/ui'
import { useWorkflowBoard } from '../../workflow-board/context'
import { useCollaborationUISlots } from '../../../shared/ui/collaborationSlots'

export type EditGraph = (update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => void
function nodeOptions(graph: WorkflowDefinitionV3, except?: string): SelectOption[] {
  return graph.nodes.filter((node) => node.id !== except).map((node) => ({ value: node.id, label: nodeTitle(graph, node.id) }))
}
function changeNode(change: EditGraph, nodeId: string, update: (node: DraftNode) => DraftNode) {
  change((graph) => ({ ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? update(node) : node) }))
}

export function EntryFields({ graph, context, change, agentEdits }: { graph: WorkflowDefinitionV3; context: NextDraftContext; change: EditGraph; agentEdits?: DraftAgentEdits }) {
  const choices = entryChoices(graph, context, agentEdits), id = useId()
  return <section aria-labelledby={id} className="next-draft-section">
    <h3 id={id}>Starting node</h3>
    {graph.hierarchy ? <p>The Master starts this workflow: {nodeTitle(graph, graph.hierarchy.masterNodeId)}.</p> :
    <Select data-save-field="entry" label="Starts the workflow" value={graph.entryNodeId ?? ''} aria-invalid={!choices.valid}
      labelHint={<InfoHint label="Starts the workflow">{choices.mode === 'master' ? 'The Master starts this workflow.' : choices.mode === 'orchestrator' ? 'Only an Orchestrator can start a workflow that has one.' : 'The first node to run. It can’t receive a dependency.'}</InfoHint>}
      onChange={(event) => change((value) => ({ ...value, entryNodeId: event.target.value || null }))} options={[
        { value: '', label: 'Choose a node' },
        ...graph.nodes.map((node) => ({ value: node.id, disabled: !choices.eligible.some((item) => item.id === node.id), label: nodeTitle(graph, node.id) })),
      ]} />}
    {graph.entryNodeId && !graph.nodes.some((node) => node.id === graph.entryNodeId) ? <p role="alert">The starting node was removed. Choose another one.</p> : null}
  </section>
}

export function ApprovalFields({ graph, context, change, report, agentEdits }: { graph: WorkflowDefinitionV3; context: NextDraftContext; change: EditGraph; report: (error: unknown) => void; agentEdits?: DraftAgentEdits }) {
  let hint = 'Agents ask you before sensitive actions. Requests appear in the approval inbox.'
  if (graph.approval?.handler === 'orchestrator') {
    hint = 'The starting Master or Orchestrator reviews requests from agents it has an approval connection to.'
  } else if (graph.approval?.handler === 'native') {
    hint = 'Each Agent must explicitly use native approval handling. Saved permission rules still apply; requests do not go to the app’s approval inbox.'
  }
  return <section className="next-draft-section" aria-label="Approval handling">
    <h3>Approvals</h3>
    <Select data-save-field="approval" label="Approval handler" value={graph.approval?.handler ?? ''}
      labelHint={graph.approval?.handler !== 'orchestrator' ? <InfoHint label="Approval handler">{hint}</InfoHint> : undefined}
      onChange={(event) => {
      const handler = event.target.value
      if (handler !== 'user' && handler !== 'orchestrator' && handler !== 'native') return
      try { change((value) => changeApprovalHandler(value, handler)) } catch (error) { report(error) }
    }} options={[{ value: '', label: 'Choose who approves', disabled: true }, { value: 'user', label: 'You, the Operator' },
      { value: 'orchestrator', label: 'A coordinator agent' }, { value: 'native', label: 'Native harness' }]} />
    {graph.approval?.handler === 'orchestrator' ? <Select data-save-field="orchestrator" label="Reviewing coordinator" value={graph.approval.designatedOrchestratorAgentId ?? ''}
      labelHint={<InfoHint label="Reviewing coordinator">{hint}</InfoHint>}
      onChange={(event) => change((value) => ({ ...value, approval: { handler: 'orchestrator', ...(event.target.value ? { designatedOrchestratorAgentId: event.target.value } : {}) } }))} options={[
        { value: '', label: 'Choose a coordinator' },
        ...graph.nodes.filter((node) => node.kind!=='job').filter((node) => {
          const role = roleEvidence(context, node.agentId, agentEdits).role
          return role === 'orchestrator' || role === 'master' && graph.entryNodeId === node.id
        }).map((node) => ({ value: node.agentId, label: nodeTitle(graph, node.id) })),
      ]} /> : null}
  </section>
}

/** The node's place in this workflow: whether it starts it and where its result goes. */
export function NodeWorkflowFields({ graph, node, context, change, agentEdits }: { graph: WorkflowDefinitionV3; node: DraftNode; context: NextDraftContext; change: EditGraph; agentEdits?: DraftAgentEdits }) {
  const sharedFields = useCollaborationUISlots()
  const fields = useWorkflowBoard()?.collaborationFields ?? sharedFields
  const choices = entryChoices(graph, context, agentEdits)
  const eligible = choices.eligible.some((item) => item.id === node.id)
  const starts = graph.entryNodeId === node.id
  const role = node.kind === 'job' ? undefined : roleEvidence(context, node.agentId, agentEdits).role
  const member = graph.hierarchy?.parents.find(item => item.workflowNodeId === node.id)
  return <section className="next-draft-section" aria-label="In this workflow">
    <h3>In this workflow</h3>
    <Switch label="Starts the workflow" checked={starts} disabled={!!graph.hierarchy || !eligible && !starts}
      hint={!eligible && !starts ? choices.mode === 'master' ? 'Only the Master can start this workflow.' : choices.mode === 'orchestrator' ? 'Only an Orchestrator can start this workflow.' : 'This node can’t start the workflow.' : undefined}
      onChange={(event) => { const checked = event.currentTarget.checked; change((value) => ({ ...value, entryNodeId: checked ? node.id : value.entryNodeId === node.id ? null : value.entryNodeId })) }} />
    {graph.hierarchy && role === 'coder' ? <p>Reports to {member ? nodeTitle(graph, member.parentNodeId) : 'Unassigned'} · Applied draft</p> : null}
    {graph.hierarchy && role === 'orchestrator' ? <p>Reports to {nodeTitle(graph, graph.hierarchy.masterNodeId)} (Master).</p> : null}
    {node.kind !== 'job' ? fields?.nodeBrowser?.({ workspaceId: graph.workspaceId, workflowId: graph.id,
      nodeId: node.id, value: node.browser, onChange: browser => changeNode(change, node.id, current => {
        if (current.kind === 'job') return current
        const next = { ...current }; if (browser) next.browser = browser; else delete next.browser
        return withBrowserToolDefaults(next)
      }) }) : null}
    <ChoiceFields graph={graph} node={node} change={change} coordinator={!!graph.hierarchy && (role === 'master' || role === 'orchestrator')} />
    {graph.hierarchy ? <>
      {node.join ? <Button size="sm" onClick={() => changeNode(change, node.id, value => { const next = { ...value }; delete next.join; return next })}>Remove unsupported join</Button> : null}
      {node.kind !== 'job' && node.interval ? <Button size="sm" onClick={() => changeNode(change, node.id, value => {
        if (value.kind === 'job') return value
        const next = { ...value }; delete next.interval; return next
      })}>Turn off unsupported interval</Button> : null}
    </> : <IntervalFields node={node} change={change} />}
  </section>
}

export function ChoiceFields({ graph, node, change, coordinator = false }: { graph: WorkflowDefinitionV3; node: DraftNode; change: EditGraph; coordinator?: boolean }) {
  const hierarchyRequests = !!graph.hierarchy && !!graph.handoffs && node.kind !== 'job'
  const outgoing = graph.edges.filter((edge) => edge.kind === 'execution'
    && (edge.source === node.id || graph.hierarchy && graph.handoffs && edge.workRequestDirection === 'both' && edge.target === node.id))
  const outcomes = node.choice?.outcomes ?? []
  const setOutcomes = (update: (items: typeof outcomes) => typeof outcomes) => changeNode(change, node.id, (value) => ({ ...value, choice: { outcomes: update(value.choice?.outcomes ?? []) } }))
  return <fieldset className="next-draft-choice"><legend>{hierarchyRequests ? coordinator ? 'Delegation routes' : 'Request and review routes' : `When this ${node.kind === 'job' ? 'job' : 'agent'} finishes`}</legend>
    {hierarchyRequests ? <p>{coordinator ? 'Delegates work and waits for reports. A delegation can select several direct children.' : 'Each named outcome identifies a saved request or review route.'} Only explicitly selected requests run; unselected routes create no obligation.</p> : <Select label="Routing mode" labelHint={node.choice ? <InfoHint label="Routing mode">{node.kind === 'job'
      ? 'The observed process and output result select the matching dependency.'
      : 'The agent ends with an outcome name, and only the matching handoff runs.'}</InfoHint> : undefined} value={node.choice ? 'choice' : 'fanout'} onChange={(event) => changeNode(change, node.id, (value) => {
      if (event.target.value === 'choice') return { ...value, choice: { outcomes: [] } }
      const next = { ...value }; delete next.choice; return next
    })} options={[{ value: 'fanout', label: 'Continue to every connected node' }, { value: 'choice', label: 'Choose one handoff by outcome' }]} />}
    {node.choice || hierarchyRequests ? <>
      {hierarchyRequests && !coordinator ? <details className="next-draft-details"><summary>Result format</summary>
        <p>Use the saved outcome in the handoff request envelope. The result protocol supplies summary and board fields.</p>
        <pre>{'{"routing":{"kind":"request","outcome":"review"},"data":{"latestDeliverable":{},"remainingFindings":[]}}'}</pre>
      </details> : node.kind!=='job' && !coordinator?<details className="next-draft-details"><summary>Result format</summary>
        <p>Return exactly this JSON, with no other text:</p>
        <pre>{'{"routing":{"outcome":"approved"},"data":{}}'}</pre>
      </details>:null}
      {outcomes.map((item, index) => <div className="next-draft-outcome" key={index}>
        {node.kind==='job'?<Select label={`Outcome ${index+1}`} value={item.outcome} options={[{value:'',label:'Choose observed outcome'},...JOB_WORKFLOW_OUTCOMES.map(outcome=>({value:outcome,label:outcome.replaceAll('_',' ')}))]} onChange={event=>setOutcomes(items=>items.map((value,i)=>i===index?{...value,outcome:event.target.value}:value))}/>:<TextField label={`Outcome ${index + 1}`} value={item.outcome} maxLength={48} pattern="[a-z][a-z0-9_]{0,47}" placeholder="approved"
          onChange={(event) => setOutcomes((items) => items.map((value, i) => i === index ? { ...value, outcome: event.target.value } : value))} />}
        <Select label={`Target for outcome ${index + 1}`} value={item.target.kind === 'branch_end' ? 'end' : `edge:${item.target.relationshipId}`}
          onChange={(event) => setOutcomes((items) => items.map((value, i) => i !== index ? value : { ...value, target: event.target.value === 'end'
            ? { kind: 'branch_end' } : { kind: 'edge', relationshipId: event.target.value.slice(5) } }))} options={[
            { value: 'edge:', label: 'Choose where it goes' },
            ...(item.target.kind === 'edge' && item.target.relationshipId && !outgoing.some((edge) => item.target.kind === 'edge' && edge.id === item.target.relationshipId)
              ? [{ value: `edge:${item.target.relationshipId}`, label: 'Removed handoff' }] : []),
            ...outgoing.map((edge) => ({ value: `edge:${edge.id}`, label: `Hand off to ${nodeTitle(graph, edge.source === node.id ? edge.target : edge.source)}` })),
            { value: 'end', label: 'End here' },
          ]} />
        <IconButton size="sm" variant="ghost" label={`Remove outcome ${index + 1}`} onClick={() => setOutcomes((items) => items.filter((_, i) => i !== index))}><Icon name="close" size={14} /></IconButton>
      </div>)}
      <Button size="sm" leading={<Icon name="plus" size={14} />} disabled={outcomes.length >= 16} onClick={() => setOutcomes((items) => [...items, { outcome: '', target: { kind: 'edge', relationshipId: '' } }])}>Add outcome</Button>
    </> : null}
  </fieldset>
}

export function RelationshipFields({ graph, relationship, change, report }: { graph: WorkflowDefinitionV3; relationship: WorkflowRelationship; change: EditGraph; report: (error: unknown) => void }) {
  const put = (update: Partial<WorkflowRelationship>) => {
    try { change((value) => putRelationship(value, { ...relationship, ...update })) } catch (error) { report(error) }
  }
  const approval = relationship.kind === 'approval'
  return <section className="next-draft-section" aria-label="Connection settings">
    <h3>Connection settings<InfoHint label="Connection settings">{approval
      ? 'The reviewer answers approval requests from the other agent. It doesn’t pass work.'
      : 'When the first agent finishes, its result goes to the second one.' + (!graph.handoffs
        ? ' One-pass dependencies activate each selected node once. Configure an explicit finite repeat block when work must repeat.' : '')}</InfoHint></h3>
    <Select label={approval ? 'Reviewer' : 'From'} value={relationship.source} onChange={(event) => put({ source: event.target.value })} options={nodeOptions(graph)} />
    <Select label={approval ? 'Asks for approval' : 'To'} value={relationship.target} onChange={(event) => put({ target: event.target.value })} options={nodeOptions(graph)} />
    <TextField label="Label" labelHint={<InfoHint label="Label">Optional. Shown on the connection.</InfoHint>} value={relationship.label ?? ''} onChange={(event) => put({ label: event.target.value })} />
    {!approval && graph.handoffs ? <WorkConnectionLimitEditor value={relationship.maxWorkHandoffsPerRun}
      onApply={(limit) => { try { change((value) => setWorkConnectionLimit(value, relationship.id, limit)) } catch (error) { report(error) } }} /> : null}
    <Button variant="danger" size="sm" onClick={() => change((value) => removeRelationship(value, relationship.id))}>Remove connection</Button>
  </section>
}

/** Connections to and from one agent, with a keyboard way to add one (dragging from the rim port also works). */
export function NodeConnections({ graph, nodeId, change, report }: { graph: WorkflowDefinitionV3; nodeId: string; change: EditGraph; report: (error: unknown) => void }) {
  const [target, setTarget] = useState(''), [kind, setKind] = useState<WorkflowRelationship['kind']>('execution')
  const related = graph.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId)
  return <section className="next-draft-section" aria-label="Connections">
    <h3>Connections</h3>
    {related.length ? <ul className="next-draft-connections">{related.map((edge) => {
      const outgoing = edge.source === nodeId, other = nodeTitle(graph, outgoing ? edge.target : edge.source)
      const reporting = isHierarchyReportingRoute(graph.hierarchy, edge)
      const text = edge.kind === 'approval' ? outgoing ? `Reviews ${other}` : `Asks ${other} for approval`
        : reporting ? outgoing ? `Orchestrates ${other}` : `Reports to ${other}` : outgoing ? `Hands off to ${other}` : `Receives from ${other}`
      return <li key={edge.id} data-direction={outgoing ? 'out' : 'in'}><Icon name="arrow" size={14} /><span>{text}{edge.label ? ` · ${edge.label}` : ''}</span>
        <IconButton size="sm" variant="ghost" label={`Remove connection: ${text}`} onClick={() => change((value) => removeRelationship(value, edge.id))}><Icon name="close" size={14} /></IconButton></li>
    })}</ul> : <p className="next-draft-hint">No connections yet. Drag from the dot on the agent’s right edge to another agent.</p>}
    {graph.nodes.length > 1 ? <form className="next-draft-connect" onSubmit={(event) => {
      event.preventDefault()
      if (!target) return
      try {
        change((value) => value.edges.some((edge) => edge.kind === kind && edge.source === nodeId && edge.target === target) ? value
          : putRelationship(value, { id: `relationship-${crypto.randomUUID()}`, kind, source: nodeId, target })); setTarget('')
      } catch (error) { report(error) }
    }}>
      <SegmentedControl label="Connection type" value={kind} onValueChange={(value) => setKind(value === 'approval' ? 'approval' : 'execution')}
        options={[{ value: 'execution', label: 'Handoff' }, { value: 'approval', label: 'Approval' }]} />
      <div className="next-draft-inline">
        <Select label={kind === 'approval' ? 'Reviews' : 'Hand off to'} value={target} onChange={(event) => setTarget(event.target.value)}
          options={[{ value: '', label: 'Choose a node' }, ...nodeOptions(graph, nodeId)]} />
        <Button type="submit" disabled={!target}>Connect</Button>
      </div>
    </form> : null}
  </section>
}

