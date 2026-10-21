import { InfoHint } from '../../../shared/ui'
import { Button, TextField } from '../../../shared/ui/nocturne'
import { AgentActiveTimeField } from './AgentActiveTimeField'
import { ApprovalFields, EntryFields, type EditGraph } from './AuthoringFields'
import type { NextDraftEdit } from './state'

export function WorkflowSettings({ edit, change, report, defaultMs, locationReady, locationMessage,
  onChangeFolder, onReload }: {
  edit: NextDraftEdit
  change: EditGraph
  report(error: unknown): void
  defaultMs: number | undefined
  locationReady: boolean
  locationMessage: string
  onChangeFolder: (() => void) | undefined
  onReload(): void
}) {
  const { graph, context, agentEdits } = edit
  return <>
    <EntryFields graph={graph} context={context} agentEdits={agentEdits} change={change} />
    <ApprovalFields graph={graph} context={context} agentEdits={agentEdits} change={change} report={report} />
    <section className="next-draft-section" aria-label="Execution bounds">
      <h3>Limits{graph.handoffs ? <InfoHint label="Limits">Set each work connection’s Run-wide handoff limit on its line. The Board keeps these edits as a draft until Save.</InfoHint> : null}</h3>
      {graph.executionPolicy ? <AgentActiveTimeField policy={graph.executionPolicy} defaultMs={defaultMs}
        onChange={(executionPolicy) => change((item) => ({ ...item, executionPolicy }))} /> : null}
      {graph.executionPolicy ? <div className="next-draft-inline">
        <TextField data-save-field="limits" label="Maximum parallelism"
          labelHint={<InfoHint label="Maximum parallelism">Agents running at once</InfoHint>}
          type="number" min={1} max={100}
          value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''}
          onChange={(event) => {
            const value = event.target.valueAsNumber
            change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } }))
          }} />
        <TextField data-save-field="executions" label="Maximum node executions"
          labelHint={<InfoHint label="Maximum node executions">Agent turns per run</InfoHint>}
          type="number" min={1} max={10000}
          value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''}
          onChange={(event) => {
            const value = event.target.valueAsNumber
            change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } }))
          }} />
      </div> : <Button data-save-field="limits" size="sm" onClick={() => change((item) => ({ ...item,
        executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set limits</Button>}
      {graph.requiredAgentCount !== undefined ? <div className="next-draft-inline">
        <TextField label="Required Agent count" type="number" min={0} max={10000}
          value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''}
          onChange={(event) => {
            const requiredAgentCount = event.target.valueAsNumber
            change((item) => ({ ...item, requiredAgentCount }))
          }} />
        <Button size="sm" variant="ghost" onClick={() => change((item) => {
          const next = { ...item }
          delete next.requiredAgentCount
          return next
        })}>Remove fixed Agent count</Button>
      </div> : null}
    </section>
    <section className="next-draft-section">
      <h3>Execution folder<InfoHint label="Execution folder">Runs work in this workspace’s folder.</InfoHint></h3>
      {!locationReady ? <p className="next-draft-hint">{locationMessage}</p> : null}
      <Button size="sm" onClick={onChangeFolder}>Change folder</Button>
    </section>
    <section className="next-draft-section"><h3>Draft</h3>
      <p className="next-draft-hint">{context.draft.baseWorkflowVersionId
        ? <>Based on saved version <code>{context.draft.baseWorkflowVersionId}</code>.</>
        : 'This workflow hasn’t been saved yet.'}</p>
      <Button size="sm" disabled={!!edit.pending} onClick={onReload}>Reload saved draft</Button>
    </section>
  </>
}
