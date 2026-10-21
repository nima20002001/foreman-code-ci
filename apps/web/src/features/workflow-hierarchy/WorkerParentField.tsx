import { Select } from '../../shared/ui/nocturne'
import { useGraphDraftStore } from '../graph/store'
import { nodeTitle } from '../graph/nextDraft/model'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { hierarchyNodes } from './authoring'

/** A raw selection belongs to the existing Agent Apply/Cancel form. */
export function WorkerParentField({ draftKey, edit, nodeId }: { draftKey: string; edit: NextDraftEdit; nodeId: string }) {
  const original = edit.graph.hierarchy?.parents.find(member => member.workflowNodeId === nodeId)?.parentNodeId ?? ''
  const selected = edit.workflowForms?.workerParents?.[nodeId] ?? original
  const saved = (edit.context.savedDraft ?? edit.context.draft).graph
  const former = saved.hierarchy?.parents.find(member => member.workflowNodeId === nodeId)?.parentNodeId
  return <section aria-label="Worker team">
    <Select label="Reports to" value={selected} options={[{ value: '', label: 'Choose an Orchestrator' },
      ...hierarchyNodes(edit).filter(item => item.role === 'orchestrator').map(({ node }) => ({ value: node.id, label: nodeTitle(edit.graph, node.id) }))]}
      onChange={event => { const parentNodeId = event.target.value
        useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
          if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen Worker settings.')
          return { ...current, workflowForms: { ...current.workflowForms,
            workerParents: { ...current.workflowForms?.workerParents, [nodeId]: parentNodeId } } }
        })
      }} />
    {selected !== original ? <p>Apply to draft changes this Worker’s team and adds or reuses its parent route together.
      {original ? ` ${nodeTitle(edit.graph, original)} → ${nodeTitle(edit.graph, nodeId)} is no longer a team connection; its existing handoff is kept.` : ''}</p> : null}
    {former && former !== original ? <p role="status">Changed connections · Unsaved: {nodeTitle(saved, former)} → {nodeTitle(edit.graph, nodeId)} is no longer a team connection. The ordinary handoff is kept.</p> : null}
  </section>
}
