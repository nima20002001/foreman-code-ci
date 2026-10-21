import { useQuery } from '@tanstack/react-query'
import type { JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import type { JobDefinitionRecord } from '@foreman-code/contracts/job-verification'
import { Alert, Button, Card, CardBody } from '../../shared/ui/nocturne'
import { jobsClient } from './client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { useJobDefinitions } from './query'
import { jobError, jobReadRetry } from './model'
import { JobSpecFacts } from './JobSpecFacts'
import { JobRunResult } from './JobRunResult'
import './jobs.css'

/** Board adapters supply the job variant's saved definition pins; accepted results never reconstruct them. */
export function JobNodePanel({ workspaceId, definitionId, definitionRevision, definitionVersionId, workflowExecution }: { workspaceId: string; definitionId: string; definitionRevision: number; definitionVersionId:string; workflowExecution?: JobWorkflowAdmissionReference }) {
  const definition = useQuery({ queryKey: ['jobs', workspaceId, 'definition', definitionId, definitionVersionId], queryFn: ({ signal }) => jobsClient.definitionVersion(workspaceId, definitionId,definitionVersionId, { signal }), enabled: !workflowExecution, retry: jobReadRetry })
  const blocked = useBlockingReadError(definition)
  if (workflowExecution) return <JobRunResult reference={workflowExecution} definitionVersionId={definitionVersionId} />
  if (definition.error && (blocked || !definition.data)) return <Alert title="Job unavailable" tone="danger">{jobError(definition.error)}</Alert>
  if (!definition.data) return <p role="status">Loading saved job node…</p>
  if (definition.data.revision !== definitionRevision) return <Alert title="Saved job revision unavailable" tone="warning">This node pins revision {definitionRevision}, but its saved version was returned as revision {definition.data.revision}. No substitute command is shown for this saved node.</Alert>
  return <Card><CardBody>{definition.error ? <p role="alert">Job refresh failed. Showing the last successful read.</p> : null}<h3 className="job-wrap">{definition.data.name}</h3><p>Noninteractive job · saved definition revision {definitionRevision}.</p><JobSpecFacts spec={definition.data.spec} /></CardBody></Card>
}

export function JobNodePicker({ workspaceId, onChoose }: { workspaceId: string; onChoose: (definition: JobDefinitionRecord) => void }) {
  const definitions = useJobDefinitions(workspaceId)
  return <section className="job-node-picker" aria-label="Choose a saved job for this node"><h3>Saved job</h3>{Boolean(definitions.error) && <Alert title="Jobs unavailable" tone="danger">{jobError(definitions.error)}</Alert>}
    {definitions.isPending && <p role="status">Loading saved jobs…</p>}
    {definitions.data?.map(definition => <Button className="job-wrap" key={definition.id} onClick={() => onChoose(definition)}>{definition.name} · revision {definition.revision}</Button>)}
    {definitions.data?.length === 0 && <p>No saved jobs yet. Ask an agent to create a job, then add it here.</p>}
  </section>
}
