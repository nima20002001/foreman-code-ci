import { useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { agentTemplateForRole, newAgentGraphqlTools,
  type Agent, type WorkflowAgentProductRole } from '@foreman-code/contracts'
import { Alert, Button, ConfirmDialog, Select } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery } from '../../shared/api/query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { useGraphDraftStore } from '../graph/store'
import { nodeTitle } from '../graph/nextDraft/model'
import { storeEditSnapshot } from '../graph/nextDraft/editIntentStorage'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { hierarchyNodes, stageHierarchyAgent } from './authoring'

type Props = { draftKey: string; edit: NextDraftEdit; report(error: unknown): void;
  openSettings(nodeId: string): void; close(): void }
type CreationForm = NonNullable<NonNullable<NextDraftEdit['workflowForms']>['createAgent']>

export function CreateBoardAgent(props: Props) {
  return <CreationFormFields key={props.edit.instanceId} {...props} />
}
function CreationFormFields({ draftKey, edit, report, openSettings, close }: Props) {
  const form: CreationForm = edit.workflowForms?.createAgent ?? { role: 'coder', name: '', parentNodeId: '' }
  const { role, parentNodeId } = form
  const [replaceRole, setReplaceRole] = useState<WorkflowAgentProductRole>()
  const defaults = useAgentDefaultsQuery(), denied = useProtectedAccessError(defaults)
  const label = role === 'master' ? 'Master' : role === 'orchestrator' ? 'Orchestrator' : 'Worker'
  const seed = useMemo<Agent | undefined>(() => {
    if (!defaults.data) return undefined
    const template = agentTemplateForRole(defaults.data.value, role)
    if (template.harness.harness !== 'codex' && template.harness.harness !== 'claude') return undefined
    return { ...defaultAgentForHarness(template.harness.harness, `agent-${crypto.randomUUID()}`, label, template.harness, role),
      ...(template.nativeTools ? { nativeTools: structuredClone(template.nativeTools) } : {}),
      ...(template.harnessProfileSelection ? { harnessProfileSelection: structuredClone(template.harnessProfileSelection) } : {}),
      graphqlTools: [...(template.graphqlTools ?? newAgentGraphqlTools(role))] }
  }, [defaults.data, label, role])
  const agent = form.agent ?? seed
  const update = (change: Partial<CreationForm>) => useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
    if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen Add Agent.')
    return { ...current, workflowForms: { ...current.workflowForms,
      createAgent: { ...form, agent, ...current.workflowForms?.createAgent, ...change } } }
  })
  const discard = () => useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
    if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen Add Agent.')
    const workflowForms = { ...current.workflowForms }; delete workflowForms.createAgent
    return { ...current, workflowForms }
  })
  const attempt = (action: () => void) => { try { action() } catch (error) { report(error) } }
  const changeRole = (next: WorkflowAgentProductRole) => {
    if (next === role) return
    if (form.settings) setReplaceRole(next)
    else update({ role: next, name: '', parentNodeId: '', agent: undefined, settings: undefined })
  }
  return <section className="next-draft-section" aria-label="Create Agent in workflow">
    <h3>Create Agent</h3>
    <Select label="Role" value={role} onChange={event => attempt(() => changeRole(event.target.value as WorkflowAgentProductRole))}
      options={[{ value: 'master', label: 'Master' }, { value: 'orchestrator', label: 'Orchestrator' }, { value: 'coder', label: 'Worker' }]} />
    {edit.graph.hierarchy && role === 'coder' ? <Select label="Reports to" value={parentNodeId}
      onChange={event => attempt(() => update({ parentNodeId: event.target.value }))} options={[{ value: '', label: 'Choose an Orchestrator' },
        ...hierarchyNodes(edit).filter(item => item.role === 'orchestrator').map(({ node }) => ({ value: node.id, label: nodeTitle(edit.graph, node.id) }))]} /> : null}
    <p className="next-draft-hint">Starts with the current {label} defaults. Edit these settings before adding it to the draft. The Agent is created only when you save this workflow.</p>
    {role === 'master' && !edit.graph.hierarchy && edit.graph.nodes.length ? <p>Choose each Worker’s reporting Orchestrator in Workflow settings before Save.</p> : null}
    {defaults.isLoading && !agent ? <p role="status">Loading Agent defaults…</p> : null}
    {defaults.error || denied || defaults.isSuccess && !agent ? <Alert tone="warning" title="Agent defaults are unavailable.">
      <Button size="sm" onClick={() => void defaults.refetch()}>Retry</Button></Alert> : null}
    {agent && !denied ? <fieldset disabled={defaults.isError || edit.busy || !!edit.pending}>
      <AgentSettingsForm key={`${edit.instanceId}:${agent.id}`} embedded creationLabel={`Add ${label} to draft`}
        agent={agent} retainedForm={form.settings} additionalDirty={!!edit.workflowForms?.createAgent}
        executionPolicy={edit.graph.executionPolicy} workspaceId={edit.graph.workspaceId}
        workflowApprovalHandler={edit.graph.approval?.handler}
        designatedOrchestrator={edit.graph.approval?.designatedOrchestratorAgentId === agent.id}
        workflowWorktree={edit.graph.defaultWorktree}
        onFormChange={settings => attempt(() => update({ settings, name: settings.name }))}
        onDiscardForm={discard} onClose={() => { discard(); close() }}
        canResume={() => {
          try { const current = useGraphDraftStore.getState().nextDrafts[draftKey]; if (!current) return false; storeEditSnapshot(draftKey, current); return true }
          catch { return false }
        }}
        onSave={(created, initialPrompt, _policy, graphqlTools, placement, worktree) => {
          const nodeId = `node-${crypto.randomUUID()}`
          flushSync(() => useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
            if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen Add Agent.')
            const staged = stageHierarchyAgent(current, created, nodeId, parentNodeId || undefined, {
              ...(initialPrompt ? { initialPrompt } : {}), ...(graphqlTools ? { graphqlTools } : {}),
              ...(placement ? { placement } : {}), ...(worktree ? { worktree } : {}),
            })
            const workflowForms = { ...staged.workflowForms }; delete workflowForms.createAgent
            return { ...staged, workflowForms }
          }))
          openSettings(nodeId)
        }} />
    </fieldset> : <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>}
    <ConfirmDialog open={!!replaceRole} onOpenChange={open => { if (!open) setReplaceRole(undefined) }}
      title="Change the new Agent’s role?" description="The unapplied new Agent settings are replaced with the selected role’s current defaults. The workflow draft is unchanged."
      confirmLabel="Use role defaults" onConfirm={() => {
        if (replaceRole) attempt(() => update({ role: replaceRole, name: '', parentNodeId: '', agent: undefined, settings: undefined }))
        setReplaceRole(undefined)
      }} />
  </section>
}
