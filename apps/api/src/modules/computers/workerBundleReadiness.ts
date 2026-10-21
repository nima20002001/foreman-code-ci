import { isDeepStrictEqual } from 'node:util'
import type { WorkerBundleIdentity, WorkerBundleReadiness, WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'
import { DomainError } from '../errors.js'
import { readWorkerBundleIdentity } from './workerArtifacts.js'

export function workerBundleReadiness(expected: WorkerBundleIdentity | null, worker: WorkerUpdateStatus | undefined,
  publicationError: string | null = null): WorkerBundleReadiness {
  const running = worker ? { version: worker.currentVersion, target: worker.target ?? null,
    manifestSha256: worker.manifestSha256 ?? null, contentSha256: worker.contentSha256 ?? null } : null
  const result: WorkerBundleReadiness = { ready: false, code: null, expected, running,
    updatePhase: worker?.state ?? null, publicationError }
  if (publicationError || !expected) return { ...result, code: 'WORKER_BUNDLE_UNPUBLISHED' }
  const matches = !!expected.target && !!running && isDeepStrictEqual(expected.target, running.target)
    && (running.contentSha256 !== null ? expected.contentSha256 === running.contentSha256
      : expected.manifestSha256 !== null && expected.manifestSha256 === running.manifestSha256)
  const phase = worker?.state
  const mustWait = phase === 'draining' || phase === 'installing' || phase === 'restarting'
    || !matches && (phase === 'pending' || phase === 'downloading')
  if (mustWait) return { ...result, code: 'WORKER_UPDATING' }
  if (!matches) return { ...result, code: 'WORKER_VERSION_SKEW' }
  return { ...result, ready: true }
}

export async function readWorkerBundleReadiness(options: { directory: string; version: string },
  worker: WorkerUpdateStatus | undefined): Promise<WorkerBundleReadiness> {
  try {
    return workerBundleReadiness(await readWorkerBundleIdentity(options, worker?.target), worker)
  } catch (error) {
    const publicationError = error instanceof DomainError && typeof error.details?.publicationError === 'string'
      ? error.details.publicationError : 'The published Worker bundle could not be verified.'
    return workerBundleReadiness(null, worker, publicationError)
  }
}

export function requireWorkerBundleReady(readiness: WorkerBundleReadiness): void {
  if (readiness.ready) return
  throw new DomainError(readiness.code!, workerBundleErrorMessage(readiness), 409, { ...readiness })
}

export function workerBundleErrorMessage(readiness: WorkerBundleReadiness): string {
  const identity = (value: WorkerBundleIdentity | null) => value
    ? `${value.version} (manifest ${value.manifestSha256 ?? 'unknown'}, content ${value.contentSha256 ?? 'unknown'})`
    : 'unavailable'
  return `${readiness.code}: Expected ${identity(readiness.expected)}, running ${identity(readiness.running)}; `
    + `update phase ${readiness.updatePhase ?? 'unknown'}. ${readiness.publicationError ?? ''}`
}
