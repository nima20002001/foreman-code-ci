import type { WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'
import { workerBundleReadiness } from '../../src/modules/computers/workerBundleReadiness.js'

export function workerBundleReadinessFixture() {
  const target = { os: 'linux', osRelease: 'stable', arch: 'x64', libc: 'glibc', node: 'v22' }
  const expected = { version: '1.1.0', target, manifestSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64) }
  const worker: WorkerUpdateStatus = { currentVersion: expected.version, target,
    manifestSha256: expected.manifestSha256, contentSha256: expected.contentSha256,
    targetVersion: null, state: 'current', lastError: null }
  return { worker, expected, read: () => workerBundleReadiness(expected, worker) }
}
