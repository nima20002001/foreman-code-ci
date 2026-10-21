import type { CiRunRecord } from '@foreman-code/contracts'
import { executorSpeedFactor, type ExecutorSpeeds } from './executorSpeed.js'
import type { HostCiComputer } from './serviceTypes.js'

/** Reserve 25% of GitHub's configured 60-minute job and CircleCI Free's one-hour maximum for variance.
 * CircleCI plan limits: https://circleci.com/docs/reference/configuration-reference/#jobs */
export const CLOUD_GATE_JOB_BUDGET_MS = 45 * 60_000

/** Integration estimates already include their planned executor's factor; replace it with the target's. */
export function expectedCloudGateDurationMs(run: CiRunRecord, computer: HostCiComputer, speeds: ExecutorSpeeds): number {
  const duration = run.expectedDurationMs ?? 0
  if (run.suite !== 'integration') return duration
  return duration / (run.speedFactor ?? 1) * executorSpeedFactor(computer, speeds)
}
