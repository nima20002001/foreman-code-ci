import { isAutoJobSpecRecord, type JobDefinitionSpecRecord, type JobAcceptedSpecRecord } from '@foreman-code/contracts/job-verification'
import { jobQueueHasExecution, type JobPlacementIntent, type JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { CodeBlock } from '../../shared/ui/nocturne'
import { jobNetworkLabel, queueLabel } from './model'

export function JobQueueFacts({ ticket }: { ticket: JobQueueTicket }) {
  const awaitingAssignment = ticket.placement.kind === 'auto' && ['waiting', 'blocked'].includes(ticket.state)
  const accepted = jobQueueHasExecution(ticket)
  let computer = ticket.reservationId ? 'Computer reserved; concrete facts appear in the accepted execution' : 'Not assigned'
  if (accepted) computer = 'See original execution for the accepted computer'
  if (awaitingAssignment) computer = 'Waiting for an eligible computer'
  if (ticket.placement.kind === 'explicit') {
    const { target } = ticket.placement
    computer = target.labelAtAcceptance ?? (target.hostRef.kind === 'device' ? target.hostRef.deviceId : 'Main computer')
  }
  if (ticket.selectedComputer) {
    const { target } = ticket.selectedComputer
    computer = target.labelAtAcceptance ?? (target.hostRef.kind === 'device' ? target.hostRef.deviceId : 'Main computer')
  }
  return <dl className="job-facts">
    <dt>Job</dt><dd>{ticket.definition.name}</dd>
    {'verification' in ticket.definition.spec && <>
      <dt>Verification suite</dt><dd>{ticket.definition.spec.verification.suite}</dd>
    </>}
    <dt>Request</dt><dd>{ticket.id}</dd>
    <dt>Queue status</dt><dd>{queueLabel(ticket)}</dd>
    {ticket.placement.kind === 'prefer' && <>
      <dt>Preferred computer</dt><dd>{ticket.placement.hostRef.kind === 'device'
        ? ticket.placement.hostRef.deviceId : `Main computer (${ticket.placement.hostRef.mainId})`}</dd>
      <dt>Fallback policy</dt><dd>Then try eligible computers in build priority order.</dd>
    </>}
    <dt>{accepted ? 'Accepted computer' : 'Computer assignment'}</dt><dd>{computer}</dd>
    {ticket.selectedComputer && <>
      <dt>Reserved root</dt><dd>{ticket.selectedComputer.target.destination.canonicalProjectRoot}</dd>
      <dt>Root binding</dt><dd>{ticket.selectedComputer.rootId} · revision {ticket.selectedComputer.bindingRevision}</dd>
      <dt>Runtime profile</dt><dd>{ticket.selectedComputer.profileId} · revision {ticket.selectedComputer.profileRevision}</dd>
    </>}
    {ticket.cleanupStatus && ticket.cleanupStatus !== 'none' && <>
      <dt>Cleanup</dt><dd>{ticket.cleanupStatus === 'pending'
        ? 'Pending; computer capacity remains reserved' : 'Complete; computer capacity released'}</dd>
    </>}
    <dt>Enqueued</dt><dd>{ticket.enqueuedAt}</dd>
    <dt>Queue deadline</dt><dd>{ticket.deadlineAt}</dd>
    <dt>Waiting reasons</dt><dd>{ticket.waitingReasons.map(reason => reason.replaceAll('_', ' ')).join(' · ') || 'None'}</dd>
    <dt>Compatible computers</dt><dd>{ticket.compatibleTargetCount}</dd>
    <dt>Workspace queue position</dt><dd>{ticket.queuePosition ?? 'No longer waiting'}</dd>
    <dt>Estimated start</dt><dd>Unknown</dd>
    {ticket.reservationId && <><dt>Reservation</dt><dd>{ticket.reservationId}</dd></>}
  </dl>
}

export function JobSpecFacts({ spec, placementOverride }: {
  spec: JobDefinitionSpecRecord | JobAcceptedSpecRecord
  placementOverride?: JobPlacementIntent
}) {
  const policy = spec.policy
  let target = isAutoJobSpecRecord(spec) ? undefined : spec.target
  if (placementOverride) {
    target = placementOverride.kind === 'explicit' ? placementOverride.target : undefined
  }
  return <div className="job-spec">
    <h3>Exact command</h3><CodeBlock code={JSON.stringify(spec.argv)} language="json" />
    <dl className="job-facts">
      <dt>Computer</dt><dd>{target ? target.labelAtAcceptance ?? (target.hostRef.kind === 'device' ? target.hostRef.deviceId : 'Main computer') : 'Auto · highest-priority eligible computer'}</dd>
      <dt>Validated root</dt><dd>{target?.destination.canonicalProjectRoot ?? 'Resolved at Start'}</dd>
      <dt>Working directory</dt><dd>{spec.relativeCwd ?? '(materialized repository root)'}</dd>
      <dt>Source commit</dt><dd>{spec.source.commit}</dd>
      <dt>Network</dt><dd>{jobNetworkLabel(policy.network)}</dd>
      <dt>Execution timeout</dt><dd>{policy.executionTimeoutMs} ms</dd>
      <dt>Inputs</dt><dd>{spec.inputs.length === 0 ? 'None' : spec.inputs.map(input => `${input.path} / ${input.fileId} / ${input.revisionId} / ${input.sha256} / ${input.byteSize} bytes`).join('\n')}</dd>
      <dt>Outputs</dt><dd>{spec.outputs.length === 0 ? 'None' : spec.outputs.map(output => `${output.path} (${output.required ? 'required' : 'optional'})`).join('\n')}</dd>
      {'verification' in spec && <>
        <dt>Verification suite</dt><dd>{spec.verification.suite}</dd>
        <dt>Test workers</dt><dd>{spec.verification.parameters.unitWorkers}</dd>
        <dt>Reserved resources</dt><dd>{spec.verification.resources.limits.cpuLimit} CPU · {Math.round(spec.verification.resources.limits.memoryBytes / 1048576)} MiB memory · {spec.verification.resources.limits.diskBytes} bytes storage</dd>
      </>}
    </dl>
    {'computerSelection' in spec && spec.computerSelection && <p>Computer selection: {spec.computerSelection.mode === 'auto'
      ? `Auto chose an eligible computer at priority ${spec.computerSelection.buildPriority}` : 'Saved fixed computer'}.
      Build settings revision {spec.computerSelection.settingsRevision}.</p>}
    <details><summary>Identities, limits and digests</summary>
      <dl className="job-facts">
        <dt>Host identity</dt><dd>{target ? JSON.stringify(target.hostRef) : 'Resolved at Start'}</dd>
        <dt>Root identity</dt><dd>{target?.destination.directoryIdentityHash ?? 'Resolved at Start'}</dd>
        <dt>Root binding revision</dt><dd>{target ? `${target.destination.rootPolicyRevision} / location ${target.destination.locationRevision}` : 'Resolved at Start'}</dd>
        <dt>Source snapshot</dt><dd>{spec.source.snapshotId} · {spec.source.manifestDigest}</dd>
        <dt>Materialization</dt><dd>{'definitionVersionId' in spec ? spec.source.materializationId : 'Pending preparation'} · {'definitionVersionId' in spec ? spec.source.materializationDigest : 'Pending preparation'}</dd>
        <dt>Isolation policy</dt><dd>{'isolationPolicyId' in policy ? `${policy.isolationPolicyId} · revision ${policy.isolationPolicyRevision}` : 'Compatible qualified runtime resolved at Start'}</dd>
        <dt>Image / toolchain</dt><dd>{policy.imageDigest} / {policy.toolchainDigest}</dd>
        <dt>Timeouts</dt><dd>Queue {policy.queueTimeoutMs} ms · preparation {policy.preparationTimeoutMs} ms · execution {policy.executionTimeoutMs} ms</dd>
        <dt>Log bounds</dt><dd>{policy.maxLogBytes} bytes · overflow {policy.logOverflow} · retention {policy.retentionSeconds} s</dd>
      </dl>
    </details>
  </div>
}
