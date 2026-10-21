import { InfoHint } from '../../../shared/ui/InfoHint'
import { useState } from 'react'
import { AGENT_INTERVAL_MAX_SECONDS, AGENT_INTERVAL_MIN_SECONDS, AGENT_INTERVAL_PROMPT_MAX_LENGTH, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { Select, Switch, Textarea, TextField } from '../../../shared/ui/nocturne'
import type { DraftNode } from './model'
import { largestUnit, unitSeconds, UNITS, type Unit } from './intervalLabel'

/** An Agent loop, off by default. While its Run is active, the Agent is re-activated in its own session on each loop,
 * with the loop prompt or a default check of the Run. Workflow schedules, which start Runs, are separate. */
export function IntervalFields({ node, change }: {
  node: DraftNode; change: (update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => void
}) {
  const everySeconds = node.kind === 'job' ? undefined : node.interval?.everySeconds
  const [unit, setUnit] = useState<Unit>(() => everySeconds ? largestUnit(everySeconds) : 'minutes')
  const [count, setCount] = useState(() => everySeconds ? String(everySeconds / unitSeconds(largestUnit(everySeconds))) : '1')
  const [prompt, setPrompt] = useState(() => node.kind === 'job' ? '' : node.interval?.prompt ?? '')
  if (node.kind === 'job') return null
  const write = (seconds: number | undefined, text = prompt) => change((graph) => ({ ...graph, nodes: graph.nodes.map((item) => {
    if (item.id !== node.id || item.kind === 'job') return item
    const next = { ...item }
    if (seconds === undefined) delete next.interval
    else next.interval = { everySeconds: seconds, ...(text.trim() ? { prompt: text.trim() } : {}) }
    return next
  }) }))
  const seconds = Number(count) * unitSeconds(unit)
  const valid = Number.isInteger(seconds) && seconds >= AGENT_INTERVAL_MIN_SECONDS && seconds <= AGENT_INTERVAL_MAX_SECONDS
  const apply = (nextCount: string, nextUnit: Unit) => {
    setCount(nextCount); setUnit(nextUnit)
    const value = Number(nextCount) * unitSeconds(nextUnit)
    if (Number.isInteger(value) && value >= AGENT_INTERVAL_MIN_SECONDS && value <= AGENT_INTERVAL_MAX_SECONDS) write(value)
  }
  return <fieldset className="next-draft-choice"><legend>Loop<InfoHint label="Loop while the workflow runs">While this workflow's Run is active, this agent is woken in its own session on every loop and stops when the Run ends. Workflow schedules, which start Runs, are separate. Loops never hand off work or use maximum parallelism slots. They wait for work on this node to finish, and work on this node waits for a running loop. Each Run allows at most 1,000 loops. Needs native approval handling or a Codex agent that never asks for approval, and no artifact outputs.</InfoHint></legend>
    <Switch label="Loop while the workflow runs" checked={everySeconds !== undefined}
      onChange={(event) => write(event.currentTarget.checked ? (valid ? seconds : 60) : undefined)} />
    {everySeconds !== undefined ? <div className="next-draft-inline">
      <TextField label="Every" type="number" inputMode="numeric" min={1} step={1} value={count}
        error={valid ? undefined : 'Choose between 10 seconds and 24 hours.'}
        onChange={(event) => apply(event.target.value, unit)} />
      <Select label="Unit" value={unit} options={UNITS.map(({ value, label }) => ({ value, label }))}
        onChange={(event) => apply(count, event.target.value as Unit)} />
    </div> : null}
    {everySeconds !== undefined ? <Textarea label="Each loop" rows={3}
      labelHint={<InfoHint label="Each loop">What the agent does on each loop. Leave empty for the default check of the Run.</InfoHint>}
      maxLength={AGENT_INTERVAL_PROMPT_MAX_LENGTH} value={prompt}
      placeholder="Check the Run for failed or stuck nodes, failing CI and repeated errors."
      onChange={(event) => { setPrompt(event.target.value); write(everySeconds, event.target.value) }} /> : null}
  </fieldset>
}
