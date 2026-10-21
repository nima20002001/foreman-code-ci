import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CiRuntimeWorker } from '../../src/modules/jobs/ciRuntimeWorker.js'
import { closeCiRuntimeCommand, runCiRuntimeCommand } from '../../src/modules/jobs/ciRuntimeCommands.js'

interface Input {
  directory: string
  installer: string
  podman: string
  image: string
  seedIdentity: string
  stage: 'build' | 'seed-copy'
  environment: NodeJS.ProcessEnv
  request: { operation: 'prepare'; operationId: string; repository: string; commit: string;
    keepImages: string[]; review: { reviewedByPrincipalId: string; decisionDigest: string } }
}

const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as Input
const lifetime = new AbortController()
const podman = (argv: string[], signal = lifetime.signal) =>
  runCiRuntimeCommand(input.podman, ['--remote=false', ...argv], { env: input.environment, signal })
const worker = new CiRuntimeWorker(input.directory, {
  git: { cloneDirectory: () => input.directory, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
  managedRuntimeRoot: async () => input.directory,
  currentRuntimePaths: async () => [], lastRefresh: async () => null, now: () => new Date(),
  refresh: async () => { throw new Error('Fault fixture does not refresh installed runtimes.') },
  async prepare({ signal, log }) {
    log?.(input.stage)
    if (input.stage === 'build') {
      await podman(['build', '--pull=never', '--network=none', '--layers=false', '--force-rm',
        '--volume', `${join(input.directory, 'fault-output')}:/faults:rw`,
        '-t', `localhost/fault-build:${input.request.operationId}`,
        join(input.directory, 'build-context')], signal)
    } else {
      const installerDigest = createHash('sha256').update(input.installer).digest('hex')
      await podman(['create', '--name', input.seedIdentity,
        '--label', `io.foreman-code.installation=${installerDigest}`,
        '--label', 'io.foreman-code.ci-preparation=seed', input.image, 'true'], signal)
      try {
        const child = spawn(input.podman,
          ['--remote=false', 'cp', `${input.seedIdentity}:/usr/local/bin/node`, '-'],
          { env: input.environment, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stderr!.resume()
        const output = child.stdout!
        let marked = false
        output.on('data', () => {
          if (marked || signal?.aborted) return
          marked = true
          output.pause()
          void writeFile(join(input.directory, 'seed-copy-started'), String(child.pid), { mode: 0o600 })
        })
        child.once('exit', () => output.resume())
        await closeCiRuntimeCommand(child, 'seed copy', signal)
      } finally {
        await podman(['rm', '--force', '--ignore', input.seedIdentity], AbortSignal.timeout(30_000))
      }
    }
    throw new Error('The fault barrier unexpectedly completed.')
  },
}, lifetime.signal)

let closing = false
process.on('SIGTERM', () => {
  if (closing) return
  closing = true
  lifetime.abort(new Error('Preparation service stopped'))
  void worker.close().then(async () => {
    await writeFile(join(input.directory, 'shutdown-state.json'),
      JSON.stringify(await worker.handle({ operation: 'status' })), { mode: 0o600 })
    process.exit(0)
  }, error => {
    console.error(error)
    process.exit(1)
  })
})
await worker.handle(input.request)
