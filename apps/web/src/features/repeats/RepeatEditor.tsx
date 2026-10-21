import { InfoHint } from '../../shared/ui/InfoHint'
import { useMemo } from 'react'
import type { RepeatBlockV1, WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { Button, Checkbox, Select, TextField } from '../../shared/ui/nocturne'
import { blockOutcomeOptions, localDraftFromPlan, targetLabel, validateRepeatDraft } from './repeatModel'
import './repeats.css'

/** Fields in the existing Board draft, not a second editor or publication path.
 * Partial input is local-only. The common Save validates the complete V3 version. */
export function RepeatEditor({ graph, change, disabled = false }: {
  graph: WorkflowDefinitionV3
  change(update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3): void
  disabled?: boolean
}) {
  const options = useMemo(() => graph.nodes.map((node) => ({ value: node.id, label: node.name ?? node.label ?? node.id })), [graph.nodes])
  const blocks = graph.repeat?.blocks ?? []
  const issues = validateRepeatDraft(localDraftFromPlan(graph.repeat), graph)
  const updateBlock = (index: number, update: (block: RepeatBlockV1) => RepeatBlockV1) => change((current) => {
    if (!current.repeat) return current
    return { ...current, repeat: { ...current.repeat, blocks: current.repeat.blocks.map((block, item) => {
      if (item !== index) return block
      const next = update({ ...block, nodeIds: [...block.nodeIds] })
      const outcome = current.nodes.find((node) => node.id === next.exitNodeId)?.choice?.outcomes.find((item) => item.outcome === next.repeatOutcome)
      return { ...next, limitExit: outcome?.target ?? next.limitExit }
    }) } }
  })
  const removeBlock = (index: number) => change((current) => {
    if (!current.repeat) return current
    const retained = current.repeat.blocks.filter((_, item) => item !== index)
    if (retained.length) return { ...current, repeat: { ...current.repeat, blocks: retained } }
    const { repeat: _removed, ...ordinary } = current
    void _removed
    return ordinary
  })
  const addBlock = () => change((current) => ({ ...current, repeat: { contractVersion: 1,
    blocks: [...(current.repeat?.blocks ?? []), { id: `repeat-${crypto.randomUUID()}`, nodeIds: [],
      entryNodeId: '', exitNodeId: '', maxOccurrences: 2, repeatOutcome: '', earlyExitOutcome: '',
      limitExit: { kind: 'branch_end' } }],
  } }))
  return <section className="repeat-editor" aria-label="Repeat settings">
    <div className="repeat-heading"><div><h3>Repeats<InfoHint label="Repeats">Repeat a section up to a chosen limit. Sections cannot overlap or nest. Use the repeat outcome instead of a connection back to the entry. Allow enough node executions in Workflow settings for the chosen limit. Retries do not count as another repeat.</InfoHint></h3></div></div>
    {!blocks.length ? <p className="repeat-muted">No repeats.</p> : null}
    <div className="repeat-blocks">{blocks.map((block, index) => {
      const outcomes = blockOutcomeOptions(graph, block.exitNodeId)
      const limitTarget = graph.nodes.find((node) => node.id === block.exitNodeId)?.choice?.outcomes.find((item) => item.outcome === block.repeatOutcome)?.target
      const blockIssues = issues.filter((issue) => issue.blockId === block.id)
      return <fieldset className="repeat-block" key={index} disabled={disabled}>
        <legend>Repeat {index + 1}</legend>
        <TextField label="Repeat name" value={block.id} required
          onChange={(event) => updateBlock(index, (value) => ({ ...value, id: event.currentTarget.value }))} />
        <div className="repeat-scope"><span className="repeat-label">Scope<InfoHint label="Scope">Choose one entry-to-exit section.</InfoHint></span>
          <div className="repeat-node-grid">{options.map((option) => <Checkbox key={option.value} label={option.label}
            checked={block.nodeIds.includes(option.value)} onChange={(event) => updateBlock(index, (value) => ({ ...value,
              nodeIds: event.currentTarget.checked ? [...value.nodeIds, option.value] : value.nodeIds.filter((id) => id !== option.value),
            }))} />)}</div></div>
        <div className="repeat-grid">
          <Select label="Entry node" required value={block.entryNodeId} options={[{ value: '', label: 'Choose entry' }, ...options]}
            onChange={(event) => updateBlock(index, (value) => ({ ...value, entryNodeId: event.currentTarget.value }))} />
          <Select label="Exit node" required value={block.exitNodeId} options={[{ value: '', label: 'Choose exit' }, ...options]}
            onChange={(event) => updateBlock(index, (value) => ({ ...value, exitNodeId: event.currentTarget.value, repeatOutcome: '', earlyExitOutcome: '' }))} />
          <TextField label="Maximum occurrences" type="number" min={1} max={2147483647} step={1} required value={block.maxOccurrences}
            labelHint={<InfoHint label="Maximum occurrences">Includes the first run through this section.</InfoHint>}
            onChange={(event) => updateBlock(index, (value) => ({ ...value, maxOccurrences: Number(event.currentTarget.value) }))} />
          <Select label="Repeat outcome" required value={block.repeatOutcome} options={[{ value: '', label: 'Choose outcome' }, ...outcomes.map((outcome) => ({ value: outcome, label: outcome }))]}
            onChange={(event) => updateBlock(index, (value) => ({ ...value, repeatOutcome: event.currentTarget.value }))} />
          <Select label="Early-exit outcome" required value={block.earlyExitOutcome} options={[{ value: '', label: 'Choose outcome' }, ...outcomes.map((outcome) => ({ value: outcome, label: outcome }))]}
            onChange={(event) => updateBlock(index, (value) => ({ ...value, earlyExitOutcome: event.currentTarget.value }))} />
        </div>
        <div className="repeat-limit-route"><strong>At the cap<InfoHint label="At the cap">Continue here when the limit is reached.</InfoHint></strong><span>{targetLabel(limitTarget)}</span></div>
        {blockIssues.length ? <ul className="repeat-errors" aria-label={`Problems in repeat ${index + 1}`}>{blockIssues.map((issue, item) => <li key={item}>{issue.message}</li>)}</ul> : null}
        <Button size="sm" variant="ghost" onClick={() => removeBlock(index)}>Remove repeat</Button>
      </fieldset>
    })}</div>
    <Button size="sm" variant="secondary" disabled={disabled} onClick={addBlock}>Add repeat</Button>
    {issues.filter((issue) => !issue.blockId).length ? <ul className="repeat-errors" aria-label="Repeat plan problems">
      {issues.filter((issue) => !issue.blockId).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}
  </section>
}
