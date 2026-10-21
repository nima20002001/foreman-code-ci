import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CloudCi } from '../../src/modules/ci-host/cloud.js'
import { CircleCiProvider, type CloudRun } from '../../src/modules/ci-host/cloudProviders.js'
import type { HostCiPorts } from '../../src/modules/ci-host/runner.js'
import type { GitWorktreePorts } from '../../src/modules/sources/gitWorktree.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

export async function cloudCiLookupFixture(state: 'starting' | 'running',
  reconciliation?: CloudRun['reconciliation']) {
  const root = await privateFixtureDirectory('ci-cloud-lookup-')
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, 'clone/.git'), { recursive: true })
  let now = Date.now()
  const control = { error: '', cancelError: '', operation: state === 'starting' ? 'run' : 'job',
    reads: 0, canceled: [] as string[], outcome: '' }
  const run: CloudRun = { runId, repository: 'fixture/site', mirror: 'fixture/site-ci', commit: 'a'.repeat(40),
    suite: 'integration', providerRunId: 'pipeline-1', state, startedAt: new Date(now).toISOString(),
    finishedAt: null, exitCode: null, message: null, workflowStarted: state === 'running',
    ...(reconciliation ? { reconciliation } : {}) }
  await writeFile(join(directory, 'meta.json'), JSON.stringify(run))
  await writeFile(join(directory, 'log'), '')
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 8 * 2 ** 30, now: () => new Date(now),
    run: async (file, args) => {
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
      if (file !== 'circleci') throw new Error('Unexpected provider command')
      if (args[1] === 'cancel') {
        control.canceled.push(args[2]!)
        return control.cancelError ? { code: 1, stdout: '', stderr: control.cancelError } : ok()
      }
      if (args[1] === 'get' && args[0] === control.operation) {
        control.reads++
        if (control.error) return { code: 1, stdout: '', stderr: control.error }
      }
      if (args[0] === 'run') return ok(JSON.stringify(control.outcome
        ? { phase: 'ended', current_outcome: control.outcome, workflows: [] }
        : { phase: 'started', workflows: [{ jobs: [{ id: 'job-1' }] }] }))
      if (args[0] === 'job') return ok(JSON.stringify({ phase: 'started', executions: [] }))
      return ok()
    } }
  const git: GitWorktreePorts = { cloneDirectory: () => join(root, 'clone'),
    git: async () => ({ code: 0, stdout: '', stderr: '' }) }
  const reopen = () => new CloudCi('fixture-main', new CircleCiProvider(ports), async () => run.mirror,
    root, ports, git, { home: root, user: 'fixture', host: 'fixture-computer' })
  const cloud = reopen()
  return { run, cloud, reopen, control, advance: (ms: number) => { now += ms },
    close: async () => {
      await cloud.waitForMirrorCleanup(run.repository, run.mirror)
      await rm(root, { recursive: true, force: true })
    } }
}
