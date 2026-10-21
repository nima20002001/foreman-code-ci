import { Button, Dialog, Select } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../graph/store'
import { nodeTitle } from '../graph/nextDraft/model'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { hierarchyNodes, removeHierarchyNode } from './authoring'

export function RemoveHierarchyNodeDialog({ draftKey, edit, pending, report, inspectLatest }: {
  draftKey: string; edit: NextDraftEdit; pending: boolean; report(error: unknown): void
  inspectLatest?(): Promise<void>
}) {
  const form = edit.workflowForms?.removeNode
  const node = edit.graph.nodes.find(item => item.id === form?.nodeId)
  const master = form?.nodeId === edit.graph.hierarchy?.masterNodeId
  const workers = !master && form ? edit.graph.hierarchy?.parents.filter(member => member.parentNodeId === form.nodeId) ?? [] : []
  const destinations = hierarchyNodes(edit).filter(item => item.role === 'orchestrator' && item.node.id !== form?.nodeId)
  const valid = !!node && (!workers.length || destinations.some(item => item.node.id === form?.destinationParentId))
  const discard = () => useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
    const workflowForms = { ...current.workflowForms }; delete workflowForms.removeNode
    return { ...current, workflowForms }
  })
  const apply = () => {
    if (!valid || !form) throw new Error('Choose an Orchestrator before removing the team.')
    useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
      if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen removal.')
      return removeHierarchyNode(current, form.nodeId, form.destinationParentId)
    })
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'remove workflow node', dirty: !!form,
    busy: !!form && pending, saveDisabled: !valid, save: apply, discard })
  const incident = edit.graph.edges.filter(edge => edge.source === form?.nodeId || edge.target === form?.nodeId)
  const named = edit.graph.nodes.filter(item => item.id !== form?.nodeId).flatMap(item => item.choice?.outcomes.flatMap(outcome =>
    outcome.target.kind === 'edge' && incident.some(edge => outcome.target.kind === 'edge' && edge.id === outcome.target.relationshipId)
      ? [`${nodeTitle(edit.graph, item.id)} · ${outcome.outcome}`] : []) ?? [])
  return <Dialog open={!!form} onOpenChange={open => { if (!open && !pending) void leave(discard) }}
    title={node ? `Remove ${nodeTitle(edit.graph, node.id)} from workflow?` : 'Remove workflow node'} closeLabel="Close removal">
    <fieldset disabled={pending}>
      {master ? <p>Removing this Master node stops Master reporting for new runs and removes its incident connections.
        Every other Agent stays. Choose the normal starting node before Save. Earlier Runs keep their original Master.</p>
        : <p>Only this node and its incident connections are removed. Changes stay in the draft until Save workflow.</p>}
      {workers.length ? <>
        <Select label={`Move ${workers.length} Workers to`} value={form?.destinationParentId ?? ''}
          options={[{ value: '', label: 'Choose an Orchestrator' }, ...destinations.map(({ node: destination }) => ({
            value: destination.id, label: nodeTitle(edit.graph, destination.id),
          }))]} onChange={event => { const destinationParentId = event.target.value
            useGraphDraftStore.getState().updateNextDraft(draftKey, current => ({ ...current, workflowForms: {
              ...current.workflowForms, removeNode: { nodeId: form!.nodeId, destinationParentId },
            } }))
          }} />
        {!destinations.length ? <p role="status">Add another Orchestrator or explicitly remove the Workers first. This team cannot be removed yet.</p> : null}
        <p>All {workers.length} Workers stay. Their membership and required parent routes move in the same draft step.</p>
      </> : null}
      <section aria-label="Removal connection changes"><h3>Changed connections</h3>
        <ul>{incident.map(edge => <li key={edge.id}>Remove {nodeTitle(edit.graph, edge.source)} → {nodeTitle(edit.graph, edge.target)}
          {edge.maxWorkHandoffsPerRun !== undefined ? ` · limit ${edge.maxWorkHandoffsPerRun}` : ''}</li>)}
          {form?.destinationParentId ? workers.map(worker => <li key={worker.workflowNodeId}>Add or reuse {nodeTitle(edit.graph, form.destinationParentId)} → {nodeTitle(edit.graph, worker.workflowNodeId)}</li>) : null}</ul>
        {named.length ? <p>These named outcomes will need explicit connection editing before executable Save: {named.join(', ')}. Their saved names are retained.</p> : null}
      </section>
      <Button onClick={discard}>{workers.length && !destinations.length ? 'Keep orchestrator' : 'Cancel'}</Button>
      {inspectLatest ? <Button onClick={() => void inspectLatest()}>Inspect latest</Button> : null}
      <Button variant="danger" disabled={!valid} onClick={() => { try { apply() } catch (error) { report(error) } }}>Apply removal to draft</Button>
    </fieldset>
  </Dialog>
}
