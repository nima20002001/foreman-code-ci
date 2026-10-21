import { useQuery } from '@tanstack/react-query'
import type { JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import { Alert, Button } from '../../shared/ui/nocturne'
import { jobsClient } from './client'
import { jobError, jobReadRetry } from './model'
import { JobResult } from './JobResult'
import { ApiError } from '../../shared/api/client'

/** Resolve the persisted Run/job relationship; a node execution ID is never assumed to be a job ID. */
export function JobRunResult({ reference, definitionVersionId }: {
  reference: JobWorkflowAdmissionReference; definitionVersionId: string
}) {
  const query = useQuery({ queryKey: ['jobs', 'workflow-execution', reference],
    queryFn: ({ signal }) => jobsClient.workflowExecution(reference, { signal }), retry: jobReadRetry,
    gcTime: 0, placeholderData: () => undefined,
    refetchInterval: query => !query.state.data && (!query.state.error
      || ApiError.is(query.state.error) && query.state.error.status === 404) ? 3000 : false,
  })
  if (query.isError) return <Alert title="Run job result unavailable" tone="warning">
    {jobError(query.error)} <Button size="sm" disabled={query.isFetching}
      onClick={() => void query.refetch()}>Retry job result</Button>
  </Alert>
  if (!query.data) return <p role="status">Reading the job accepted for this exact Run execution…</p>
  return <JobResult key={query.data.jobExecutionId} workspaceId={reference.workspaceId} executionId={query.data.jobExecutionId}
    expectedWorkflow={query.data} expectedDefinitionVersionId={definitionVersionId} />
}
