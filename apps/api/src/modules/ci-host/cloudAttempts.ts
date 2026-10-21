import type { CloudRun } from './cloudProviders.js'

/** Accepted CircleCI pipelines remain owned until the provider confirms termination. */
export function unresolvedCloudAttemptIds(run: Pick<CloudRun,
  'circleAccountId' | 'providerRunId' | 'dispatchHistory'> & { state: string }): string[] {
  if (run.circleAccountId === undefined) return []
  const active = run.state === 'starting' || run.state === 'running'
  return [...new Set(run.dispatchHistory?.flatMap(attempt =>
    attempt.providerRunId && !attempt.terminated && (!active || attempt.providerRunId !== run.providerRunId)
      ? [attempt.providerRunId] : []))]
}
