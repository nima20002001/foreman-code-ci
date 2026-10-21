import type pg from 'pg'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { readProductVersion } from '../../infrastructure/productVersion.js'
import { createWorkerArtifactExtension, readWorkerManifestSha256s, readWorkerContentSha256s,
  readWorkerReleasePublication } from './workerArtifacts.js'

interface ProductionWorkerArtifactOptions {
  environment: NodeJS.ProcessEnv
  releaseDirectory: string
  pool?: pg.Pool
}

export function workerArtifactLocation(options: ProductionWorkerArtifactOptions) {
  return {
    directory: readProductEnvironment(options.environment, 'WORKER_ARTIFACT_DIRECTORY')
      ?? join(options.releaseDirectory, 'worker-artifacts'),
    version: readProductVersion(options.releaseDirectory),
  }
}

export function readProductionWorkerManifestSha256s(options: ProductionWorkerArtifactOptions) {
  return readWorkerManifestSha256s(workerArtifactLocation(options))
}

export function readProductionWorkerContentSha256s(options: ProductionWorkerArtifactOptions) {
  return readWorkerContentSha256s(workerArtifactLocation(options))
}

export function readProductionWorkerReleasePublication(options: ProductionWorkerArtifactOptions) {
  return readWorkerReleasePublication(workerArtifactLocation(options))
}

export function createProductionWorkerArtifactExtension(options: ProductionWorkerArtifactOptions) {
  return createWorkerArtifactExtension({
    ...workerArtifactLocation(options),
    ciSmoke: async () => {
      try {
        return JSON.parse(await readFile(join(options.releaseDirectory, 'ci-smoke.json'), 'utf8')) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    buildEnabled: async binding => {
      if (!options.pool) return false
      const result = await options.pool.query(`select 1 from build_computer_preferences
        where build_enabled and target#>>'{hostRef,mainId}'=$1
          and target#>>'{hostRef,deviceId}'=$2 and target->>'applicationInstallationId'=$3
          and (target->>'keyRevision')::int=$4 and (target->>'authorizationRevision')::int=$5`,
      [binding.mainId, binding.deviceId, binding.workerInstallationId, binding.keyRevision, binding.authorizationRevision])
      return result.rows.length > 0
    },
  })
}
