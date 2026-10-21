import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { cloudService } from './cloudService.testSupport.js'
import { readCloudRun } from './cloudJournal.js'

afterEach(() => vi.restoreAllMocks())

it.each(['snapshot', 'execution ref'] as const)(
  'records a failed CircleCI %s publication as unsent, releases cleanup, and queues a fresh attempt', async publication => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    const ref = `ci/${f.commit}-${runId}`
    const original = f.git.git
    let unavailable = true
    f.git.git = async (args, options) => {
      const selected = publication === 'snapshot' ? args.includes('--force')
        : args.some(value => value.endsWith(`:refs/heads/${ref}`))
      if (unavailable && args[0] === 'push' && selected) {
        return { code: 1, stdout: '',
          stderr: ` ! [remote rejected] snapshot -> ${ref} (missing necessary objects)\nerror: failed to push some refs` }
      }
      return original(args, options)
    }
    const start = { operation: 'start', runId, workspaceId: 'ci-workspace', repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full', deferMirror: true } as const
    const pending = await f.cloud.handle(start)
    if (pending.operation !== 'start') throw new Error('Expected a start reply')
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    expect(f.circle.triggered).toEqual([])
    expect(await readCloudRun(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json'))).toMatchObject({
      dispatch: { attempts: 0, notSent: true, uncertain: false }, providerRunId: null,
    })
    const originalRun = f.ports.run
    const commands = vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
      if (file === 'circleci' && (args[0] === 'api' || args[0] === 'run' && args[1] !== 'trigger')) {
        throw new Error('Unsent publication failures need no provider discovery or cancellation')
      }
      return originalRun(file, args, options)
    })
    const cloud = f.reopen()
    expect(await cloud.handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'failed' } })
    const main = cloudService(cloud, pending.run, f.commit, { suite: 'lint' })
    try {
      await main.service.dispatch()
      const queued = await main.read()
      expect(queued.run).toMatchObject({ state: 'queued', computer: null,
        setupRetry: { runId: expect.any(String), reason: expect.stringContaining('missing necessary objects') } })
      expect(queued.run.setupRetry!.runId).not.toBe(runId)
      unavailable = false
      commands.mockRestore()
      expect(await f.reopen().handle({ ...start, runId: queued.run.setupRetry!.runId, deferMirror: false }))
        .toMatchObject({ run: { state: 'running' } })
      expect(f.circle.triggered).toHaveLength(1)
    } finally {
      await main.service.close()
    }
  },
)
