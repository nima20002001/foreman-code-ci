import type { JobWorkflowExecutionReference } from '@foreman-code/contracts/job-workflow'
import type { JobArtifact, JobInitiatingAgent } from '@foreman-code/contracts/jobs'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { Alert, Badge, Card, CardBody, PageHeader } from '../../shared/ui/nocturne'
import { useJobArtifacts, useJobExecution } from './query'
import { jobError, processLabel } from './model'
import { JobLogs } from './JobLogs'
import { ArtifactDownload } from './ArtifactDownload'
import { JobSpecFacts } from './JobSpecFacts'
import { JobVerificationResult } from './JobVerificationResult'

function outputStatus(execution: JobExecutionRecord, output: JobExecutionRecord['acceptedSpec']['outputs'][number],
  artifact: JobArtifact | undefined,
  artifacts: { isError: boolean; isPending: boolean }): string {
  if (artifact) return artifact.state
  if (artifacts.isError) return 'Artifact history unavailable'
  if (execution.publication === 'failed') {
    return execution.resultIssue
      ? `Publication failed: ${execution.resultIssue.replaceAll('_', ' ')}.` : 'Publication failed.'
  }
  if (artifacts.isPending) return 'Loading publication…'
  if (execution.publication === 'complete') return output.required ? 'Required artifact missing' : 'Optional output absent'
  return 'Awaiting publication'
}

export function JobResult({ workspaceId, executionId, expectedWorkflow,
  expectedDefinitionVersionId, expectedInitiatingAgent }: {
  workspaceId: string
  executionId: string
  expectedWorkflow?: JobWorkflowExecutionReference
  expectedDefinitionVersionId?: string
  expectedInitiatingAgent?: JobInitiatingAgent
}) {
  const result = useJobExecution(workspaceId, executionId)
  const artifacts = useJobArtifacts(workspaceId, executionId, Boolean(result.data))
  if (result.error && !result.data) return <Alert title="Result unavailable" tone="danger">{jobError(result.error)}</Alert>
  if (!result.data) return <p role="status">Loading job execution…</p>
  const execution = result.data
  if (expectedDefinitionVersionId && execution.acceptedSpec.definitionVersionId !== expectedDefinitionVersionId
    || expectedWorkflow && (execution.id !== expectedWorkflow.jobExecutionId || execution.workflow?.workflowId !== expectedWorkflow.workflowId
      || execution.workflow.runId !== expectedWorkflow.runId || execution.workflow.nodeId !== expectedWorkflow.nodeId
      || execution.workflow.nodeExecutionId !== expectedWorkflow.nodeExecutionId)) {
    return <Alert title="Run job result identity mismatch" tone="warning">The returned result does not match this saved node and Run execution. No substitute result is displayed.</Alert>
  }
  if (expectedInitiatingAgent && (!execution.initiatingAgent
    || execution.initiatingAgent.workflowId !== expectedInitiatingAgent.workflowId
    || execution.initiatingAgent.runId !== expectedInitiatingAgent.runId
    || execution.initiatingAgent.agentId !== expectedInitiatingAgent.agentId
    || execution.initiatingAgent.executionId !== expectedInitiatingAgent.executionId)) {
    return <Alert title="CI origin mismatch" tone="warning">This job does not belong to the selected Agent execution.</Alert>
  }
  return <div className="jobs-page">
    <PageHeader title="Job result" description={execution.id} />
    {result.error ? <p role="alert">Result refresh failed. Showing the last successful read. {jobError(result.error)}</p> : null}
    <div className="job-status" aria-label="Independent job statuses">
      <Badge tone={execution.process.outcome === 'succeeded' ? 'success' : ['build_failed', 'preparation_failed', 'spawn_failed', 'timed_out'].includes(execution.process.outcome ?? '') ? 'danger' : 'neutral'}>Process: {processLabel(execution)}</Badge>
      <Badge tone={execution.transport === 'offline' ? 'warning' : 'neutral'}>Transport: {execution.transport}</Badge>
      <Badge tone={execution.publication === 'failed' ? 'danger' : 'neutral'}>Artifacts: {execution.publication}</Badge>
    </div>
    {execution.schemaVersion === 2 && <JobVerificationResult execution={execution}
      artifacts={artifacts.data ?? []} artifactsUnavailable={artifacts.isError} />}
    {execution.launchIssue === 'build_disabled' && <Alert title="Builds disabled before launch" tone="warning">
      This Job kept its selected computer and did not start. An agent can retry after builds are enabled on that computer.
    </Alert>}
    {execution.transport !== 'connected' && <Alert title="Computer connection lost" tone="warning">
      {execution.process.phase === 'terminal'
        ? 'Connection unavailable. The recorded process outcome is shown above. Live computer observations are unavailable.'
        : 'Connection unavailable. The process may still be running. Reconnect to read persisted observations.'}
    </Alert>}
    <dl className="job-facts"><dt>Exit / signal</dt><dd>{execution.process.exitCode ?? 'Not observed'} / {execution.process.signal ?? 'None observed'}</dd>
      <dt>Started / finished</dt><dd>{execution.startedAt ?? 'Not observed'} / {execution.finishedAt ?? 'Not observed'}</dd>
      <dt>Elapsed</dt><dd>{execution.startedAt ? `${Math.max(0, Date.parse(execution.finishedAt ?? execution.updatedAt) - Date.parse(execution.startedAt))} ms${execution.finishedAt ? '' : ' through last result update'}` : execution.process.phase === 'queued' || execution.process.phase === 'preparing' ? `Not started yet (${execution.process.phase})` : 'Start time not recorded'}</dd>
      {execution.resultIssue && <><dt>Result issue</dt><dd>{execution.resultIssue}</dd></>}
      {execution.workflow && <><dt>Parent Run / node</dt><dd><a href={`/workspaces/${encodeURIComponent(workspaceId)}?workflowId=${encodeURIComponent(execution.workflow.workflowId)}&selectedRunId=${encodeURIComponent(execution.workflow.runId)}`}>{execution.workflow.runId}</a> / {execution.workflow.nodeId} / {execution.workflow.nodeExecutionId}</dd></>}
      {execution.initiatingAgent && <><dt>Initiating Run / Agent / execution</dt><dd>
        <a href={`/workspaces/${encodeURIComponent(workspaceId)}?workflowId=${encodeURIComponent(execution.initiatingAgent.workflowId)}&selectedRunId=${encodeURIComponent(execution.initiatingAgent.runId)}`}>{execution.initiatingAgent.runId}</a>
        {' / '}{execution.initiatingAgent.agentId}{' / '}{execution.initiatingAgent.executionId}
      </dd></>}
    </dl>
    <JobLogs key={`${execution.id}:${execution.attemptId}`} workspaceId={workspaceId} executionId={execution.id} attemptId={execution.attemptId} enabled={Boolean(result.data)} />
    <section aria-label="Job artifacts"><h2>Artifacts</h2>{Boolean(artifacts.error) && <Alert title={artifacts.data ? "Artifacts refresh failed" : "Artifacts unavailable"} tone="warning">{jobError(artifacts.error)}</Alert>}
      {execution.acceptedSpec.outputs.map(output => {
        const artifact = artifacts.data?.find(item => item.path === output.path)
        return <Card key={output.path}><CardBody><strong className="job-wrap">{output.path}</strong>
          <p>{outputStatus(execution, output, artifact, artifacts)}</p>
          {artifact && <dl className="job-facts"><dt>File / revision</dt><dd>{artifact.fileId} / {artifact.revisionId}</dd><dt>Digest / size</dt><dd>{artifact.sha256} / {artifact.byteSize} bytes</dd></dl>}
          {artifact && <ArtifactDownload workspaceId={workspaceId} artifact={artifact} />}
        </CardBody></Card>
      })}
      {!execution.acceptedSpec.outputs.length && <p>No outputs requested.</p>}
    </section>
    <Card><CardBody><details><summary>Accepted specification and technical facts</summary>
      <dl className="job-facts"><dt>Definition at acceptance</dt><dd>{execution.acceptedSpec.definitionId} · revision {execution.acceptedSpec.definitionRevision} · version {execution.acceptedSpec.definitionVersionId}</dd>
        <dt>Accepted specification</dt><dd>{execution.acceptedSpec.specDigest}</dd><dt>Phase</dt><dd>{execution.process.phase}</dd><dt>Process stopped</dt><dd>{execution.process.processStopped ? 'Confirmed' : 'Unconfirmed'}</dd>
        <dt>Transport last seen</dt><dd>{execution.lastSeenAt ?? 'Not observed'}</dd><dt>Accepted at</dt><dd>{execution.createdAt}</dd><dt>Last result update</dt><dd>{execution.updatedAt}</dd><dt>Cancel requested</dt><dd>{execution.cancelRequestedAt ?? 'No request'}</dd></dl>
      <JobSpecFacts spec={execution.acceptedSpec} /></details></CardBody></Card>
  </div>
}
