import { useQuery } from '@tanstack/react-query'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import { JobVerificationPassSchema, JobVerificationReportReadSchema,
  type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { Alert, Badge } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { downloadJobArtifact } from './client'
import { jobError, jobReadRetry } from './model'

export function JobVerificationResult({ execution, artifacts, artifactsUnavailable }: {
  execution: JobExecutionRecord; artifacts: JobArtifact[]; artifactsUnavailable: boolean
}) {
  const spec = execution.acceptedSpec
  const declaration = 'verification' in spec
    ? spec.outputs.find(output => output.kind === 'suite-summary' && output.required) : undefined
  const summary = artifacts.find(artifact => artifact.path === declaration?.path)
  const expected = 'verification' in spec ? {
    commit: spec.source.commit, manifestDigest: spec.source.manifestDigest,
    definitionVersionId: spec.definitionVersionId, suite: spec.verification.suite,
    executionId: execution.id, attemptId: execution.attemptId, target: spec.target,
    profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters,
  } : undefined
  const query = useQuery({
    queryKey: ['jobs', execution.workspaceId, execution.id, execution.attemptId, 'verification-summary', summary?.revisionId],
    enabled: Boolean(expected && summary?.state === 'available' && !artifactsUnavailable),
    queryFn: async ({ signal }) => {
      if (!summary || !declaration || summary.byteSize > declaration.maxBytes) {
        throw new ApiError({ code: 'JOB_SELECTION_MISMATCH',
          message: 'The verification summary exceeds its saved report limit.' }, 409)
      }
      const bytes = await downloadJobArtifact(execution.workspaceId, summary, signal)
      const report = JobVerificationReportReadSchema.safeParse({ report: JSON.parse(await bytes.text()), expected })
      if (!report.success) throw new ApiError({ code: 'JOB_SELECTION_MISMATCH',
        message: 'The verification summary does not match this accepted source and attempt.' }, 409)
      return report.data.report
    },
    retry: jobReadRetry, gcTime: 0, placeholderData: () => undefined,
  })
  if (!expected) return null
  if (artifactsUnavailable || query.isError) return <Alert title="Verification report unavailable" tone="warning">
    {query.isError ? jobError(query.error) : 'Artifact history unavailable or permission lost.'}
  </Alert>
  if (!query.data || summary?.state !== 'available') {
    let message = 'Waiting for the verification summary. Process exit alone does not confirm a suite pass.'
    if (execution.publication === 'failed') {
      message = execution.resultIssue
        ? `Verification summary unavailable. Publication failed: ${execution.resultIssue.replaceAll('_', ' ')}.`
        : 'Verification summary unavailable. Publication failed.'
    }
    if (summary?.state === 'expired') message = 'The verification summary has expired.'
    if (summary?.state === 'tombstoned') message = 'The verification summary is unavailable.'
    if (execution.publication === 'complete' && !summary) message = 'The required verification summary is missing.'
    return <section aria-label="Verification result"><h2>Verification result</h2><p role="status">{message}</p></section>
  }
  const report = query.data
  const requiredOutputsVerified = execution.schemaVersion === 2 && execution.acceptedSpec.outputs.filter(output => output.required).every(output => {
    const artifact = artifacts.find(item => item.path === output.path)
    return artifact?.state === 'available' && artifact.mediaType === output.mediaType
      && artifact.byteSize <= output.maxBytes
  })
  const passed = JobVerificationPassSchema.safeParse({ report, expected, process: execution.process,
    publication: execution.publication, requiredOutputsVerified }).success
  let label: string = report.outcome.replaceAll('_', ' ')
  if (report.outcome === 'passed') label = passed ? 'passed' : 'pass not confirmed'
  return <section aria-label="Verification result">
    <h2>Verification result</h2>
    <Badge tone={passed ? 'success' : 'warning'}>Verification: {label}</Badge>
    <dl className="job-facts">
      <dt>Suite</dt><dd>{report.suite}</dd>
      <dt>Source commit</dt><dd>{report.commit}</dd>
      <dt>Tests</dt><dd>{report.totals.passed} passed · {report.totals.failed} failed · {report.totals.skipped} skipped · {report.totals.total} total</dd>
      <dt>First-pass failures</dt><dd>{report.firstPassFailed}</dd>
      <dt>Required portions</dt><dd>{report.completedPortions} of {report.expectedPortions} · {report.completeness}</dd>
      <dt>Disallowed skips</dt><dd>{report.disallowedSkipped}</dd>
    </dl>
  </section>
}
