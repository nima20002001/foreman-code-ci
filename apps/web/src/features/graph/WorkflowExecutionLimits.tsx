import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useId, useRef, useState } from 'react'
import type { WorkflowExecutionPolicy } from '@foreman-code/contracts'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'
import { focusFirstInvalid } from '../settings/fieldValidation'
import '../settings/settingsUsability.css'

export function WorkflowExecutionLimits({ value, nodeCount, onApply }: {
  value: WorkflowExecutionPolicy
  nodeCount: number
  onApply(value: WorkflowExecutionPolicy): void
}) {
  const minimum = Math.max(1, nodeCount)
  const [nodeLimit, setNodeLimit] = useState(String(value.maxNodeExecutions))
  const [parallelism, setParallelism] = useState(String(value.maxParallelism))
  const [applied, setApplied] = useState(false)
  const prefix = useId()
  const root = useRef<HTMLFieldSetElement>(null)
  const nodeValue = Number(nodeLimit)
  const parallelValue = Number(parallelism)
  const invalidNode = !nodeLimit.trim() || !Number.isInteger(nodeValue) || nodeValue < minimum || nodeValue > 10_000
  const invalidParallel = !parallelism.trim() || !Number.isInteger(parallelValue) || parallelValue < 1 || parallelValue > 100
  const nodeHelp = `Enter a whole number between ${minimum} and 10,000, enough for every node.`
  const parallelHelp = 'Enter a whole number between 1 and 100.'
  const apply = () => {
    if (invalidNode || invalidParallel) { window.requestAnimationFrame(() => focusFirstInvalid(root.current)); return }
    onApply({ maxNodeExecutions: nodeValue, maxParallelism: parallelValue })
    setApplied(true)
  }
  useUnsavedChanges({ scope: 'surface', label: 'workflow execution limits',
    dirty: nodeLimit !== String(value.maxNodeExecutions) || parallelism !== String(value.maxParallelism),
    saveDisabled: invalidNode || invalidParallel,
    error: invalidNode ? nodeHelp : invalidParallel ? parallelHelp : undefined,
    save: apply, discard: () => { setNodeLimit(String(value.maxNodeExecutions)); setParallelism(String(value.maxParallelism)) },
  })
  return <fieldset ref={root} className="workflow-execution-limits"><legend>Workflow execution limits</legend>
    <p>These limits apply to the entire workflow, not one agent.</p>
    <TextField label="Maximum node executions" id={`${prefix}-nodes`} type="number" min={minimum} max={10_000} step={1} value={nodeLimit}
      error={invalidNode ? nodeHelp : undefined} hint={invalidNode ? undefined : nodeHelp} onChange={(event) => { setNodeLimit(event.target.value); setApplied(false) }} />
    <TextField label="Maximum parallel agents" id={`${prefix}-parallel`} type="number" min={1} max={100} step={1} value={parallelism}
      error={invalidParallel ? parallelHelp : undefined} hint={invalidParallel ? undefined : parallelHelp} onChange={(event) => { setParallelism(event.target.value); setApplied(false) }} />
    <Button variant="primary" onClick={apply}>Apply workflow limits to draft</Button>
    {applied ? <Alert live tone="success" title="Workflow limits applied to the draft.">Use Save graph to persist them.</Alert> : null}
  </fieldset>
}
