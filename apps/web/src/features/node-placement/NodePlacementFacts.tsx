import { NodePlacementReadbackSchema } from '@foreman-code/contracts/node-placement'
import type { z } from 'zod'
import './nodePlacement.css'

export type NodePlacementReadback = z.infer<typeof NodePlacementReadbackSchema>
export type NodePlacementFactsProps = {
  runId: string
  nodeId: string
  readback?: NodePlacementReadback
}

/** Render only immutable, authorized readback for this exact selected node.
 * Current labels/defaults/connectivity deliberately cannot enter this component. */
export function NodePlacementFacts({ runId, nodeId, readback }: NodePlacementFactsProps) {
  const parsed = NodePlacementReadbackSchema.safeParse(readback)
  if (!parsed.success || parsed.data.evidence === 'legacy_missing') return <p>Computer evidence unavailable. Current computer settings are not substituted.</p>
  const { placement, observations } = parsed.data
  if (placement.runId !== runId || placement.nodeId !== nodeId) return <p>Computer evidence unavailable for this exact Run node.</p>
  const host = placement.hostRef
  const identity = host.kind === 'device' ? host.deviceId : host.mainId
  const label = placement.labelAtAcceptance ?? identity
  const preparations = (parsed.data.nativePlacements ?? []).filter(native =>
    native.runId === runId && native.nodeId === nodeId && native.acceptedBindingHash === placement.bindingHash)
  const matching = observations.filter((observation) => observation.bindingHash === placement.bindingHash
    && host.kind === 'device' && observation.connection.mainId === host.mainId && observation.connection.deviceId === host.deviceId
    && observation.connection.workerInstallationId === placement.registration?.workerInstallationId
    && observation.connection.keyRevision === placement.registration?.keyRevision
    && observation.connection.authorizationRevision === placement.registration?.authorizationRevision)
  const startedAttempts = new Set<string>()
  const attempts = new Map<string, typeof matching[number]>()
  for (const observation of matching) {
    const key = JSON.stringify([observation.executionId, observation.attemptId, observation.operationId])
    if (observation.phase === 'running' || (observation.native?.processId && observation.native.processStartedAt)) startedAttempts.add(key)
    const previous = attempts.get(key)
    if (!previous || BigInt(observation.sequence) > BigInt(previous.sequence)) attempts.set(key, observation)
  }
  return <section className="node-placement-facts" aria-label="Immutable node computer evidence">
    <dl>
      <dt>Accepted on</dt><dd>{label}</dd>
      <dt>Computer identity at acceptance</dt><dd><code>{identity}</code></dd>
      <dt>Accepted execution root</dt><dd>{placement.destination.canonicalProjectRoot}</dd>
      <dt>Accepted working directory</dt><dd>{placement.destination.canonicalCwd}</dd>
      <dt>Accepted location revision</dt><dd>{placement.destination.locationRevision}</dd>
      <dt>Accepted source snapshot</dt><dd><code>{placement.source.revisionId}</code></dd>
      <dt>Accepted binding</dt><dd><code>{placement.bindingHash}</code></dd>
      {placement.payload.kind === 'agent' ? <>
        <dt>Accepted configuration</dt><dd>{placement.payload.agentConfigurationVersionId}</dd>
        <dt>Accepted harness instance</dt><dd>{placement.payload.instanceId} · revision {placement.payload.instanceRevision}</dd>
        <dt>Accepted harness installation</dt><dd>{placement.payload.harnessInstallationId}</dd>
        {placement.payload.worktree && <>
          <dt>Accepted repository</dt><dd>{placement.payload.worktree.repository}</dd>
          <dt>Accepted Agent branch prefix</dt><dd>{placement.payload.worktree.branch}</dd>
        </>}
      </> : null}
    </dl>
    {preparations.map(native => <section key={native.executionId} aria-label="Prepared Agent worktree">
      <dl><dt>Execution</dt><dd>{native.executionId}</dd><dt>Attempt</dt><dd>{native.attemptId}</dd>
        <dt>Prepared working directory</dt><dd>{native.workingTree.canonicalCwd}</dd>
        {native.materialization.receipt.worktree && <>
          <dt>Allocated Agent branch</dt><dd>{native.materialization.receipt.worktree.branch}</dd>
          <dt>Approved base commit</dt><dd><code>{native.materialization.receipt.worktree.commit}</code></dd>
        </>}
      </dl>
      <p>Worktree preparation is recorded. Process execution is shown separately below.</p>
    </section>)}
    {!attempts.size ? <p>{host.kind === 'main'
      ? 'Main-local execution observations are unavailable in this readback. Accepted placement does not confirm execution.'
      : 'Awaiting worker acknowledgment. Execution has not been observed.'}</p> : null}
    {[...attempts.values()].map((observation) => <div key={JSON.stringify([observation.executionId, observation.attemptId, observation.operationId])}>
      <p>{observation.phase === 'accepted' ? 'Worker acknowledged acceptance; execution has not been observed.'
        : startedAttempts.has(JSON.stringify([observation.executionId, observation.attemptId, observation.operationId])) ? `Execution observed on ${label} · ${observation.phase}`
        : `Worker ${observation.phase} observation on ${label}; process start is not confirmed.`}</p>
      <dl><dt>Execution</dt><dd>{observation.executionId}</dd><dt>Attempt</dt><dd>{observation.attemptId}</dd>
        <dt>Operation</dt><dd>{observation.operationId}</dd>
        {observation.native?.processId ? <><dt>Observed process</dt><dd>{observation.native.processId}{observation.native.processStartedAt ? ` · ${observation.native.processStartedAt}` : ''}</dd></> : null}</dl>
    </div>)}
  </section>
}
