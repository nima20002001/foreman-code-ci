import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import { prepareCiRuntime } from './ciRuntimePrepare.js'
import { retainedCiJobImages } from './ciRuntimeImages.js'
import { currentCiRuntimePaths, lastCiRuntimeRefresh, retireCiRuntimeConfigurations,
  scheduleCiRuntimeRefresh } from './ciRuntimeRefresh.js'
import { CiRuntimeWorker } from './ciRuntimeWorker.js'
import { retainMainJobSourceClosures } from './mainJobJournal.js'
import type { JobSql } from './repository.js'

/** The command that refreshes Main's protected runtime while Main is stopped: this same Node runtime and loader
 * flags (an environment file, a TypeScript loader) with the Main refresh entry beside this module. */
function mainRefreshCommand(): string[] {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return [process.execPath, ...process.execArgv,
    fileURLToPath(new URL(`../../cli/refreshMainJobRuntime.${extension}`, import.meta.url))]
}

/** Main as its own build computer: the same one-at-a-time CI runtime preparation a paired Worker runs, with
 * Main's installed runtime root as both its protected state and installer workspace. Its refresh restarts Main,
 * and the persisted preparation resumes afterwards. */
export function createMainCiRuntime(input: {
  runtimeRoot: string
  journal(): Promise<RemoteOperationJournal>
  signal: AbortSignal
  sql: JobSql
}): CiRuntimeWorker {
  const workDirectory = join(input.runtimeRoot, 'ci-runtime-refresh')
  return new CiRuntimeWorker(input.runtimeRoot, {
    git: systemGitWorktreePorts(process.env),
    managedRuntimeRoot: async () => input.runtimeRoot,
    prepare: async options => {
      const journal = await input.journal()
      await retainMainJobSourceClosures(input.sql, journal)
      const used = [...options.keepImages ?? [],
        ...await retainedCiJobImages(journal),
        ...(await journal.pendingQualifications()).map(receipt => receipt.candidate.fingerprint.imageDigest)]
      const configurations = await retireCiRuntimeConfigurations(input.runtimeRoot, used)
      return prepareCiRuntime({ ...options, stateDirectory: input.runtimeRoot, keepImages: [...used, ...configurations.images],
        keepPaths: [...options.keepPaths ?? [], ...configurations.paths] })
    },
    // Stopping Main ends its local Jobs and qualifications; their recovery runs when Main starts again.
    refresh: options => scheduleCiRuntimeRefresh({ ...options, workDirectory, cli: mainRefreshCommand(),
      drain: async () => {} }),
    lastRefresh: stateDirectory => lastCiRuntimeRefresh(stateDirectory, workDirectory),
    currentRuntimePaths: currentCiRuntimePaths,
    now: () => new Date(),
  }, input.signal)
}
