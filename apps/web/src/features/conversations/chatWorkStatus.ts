import type { ActivitySnapshotV1 } from '@foreman-code/contracts'

/** Parent availability and independent unfinished work are separate facts. */
export function chatBackgroundWork(snapshot: ActivitySnapshotV1 | undefined) {
  const observation = snapshot?.observation
  if (observation?.status === 'unavailable') {
    return { evidence: 'unknown' as const, label: 'Activity observation pending',
      message: `${observation.lastError} ${observation.consecutiveFailures} consecutive failed reads. Outcomes are unconfirmed.` }
  }
  const work = snapshot?.active.filter((entry) => entry.ref.kind === 'tool' || entry.ref.kind === 'subagent') ?? []
  if (!work.length && !snapshot?.hasMoreActiveWork) return undefined
  const unknown = work.some((entry) => entry.evidence !== 'confirmed') || !work.length
  return { evidence: unknown ? 'unknown' as const : 'running' as const,
    label: unknown ? 'Unfinished work unconfirmed' : 'Background work continues',
    message: `${unknown ? 'Some tools or subagents have no confirmed outcome.' : 'Tools or subagents are still unfinished.'}${snapshot?.hasMoreActiveWork ? ' More unfinished items exist than are shown.' : ''}` }
}
