import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

function blockPush(git: Awaited<ReturnType<typeof fixture>>['git']) {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const original = git.git.bind(git)
  vi.spyOn(git, 'git').mockImplementation(async (args, options) => {
    if (args[0] === 'push' && args.includes('--force')) await blocked
    return original(args, options)
  })
  return release
}

async function promptly<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Mirror publication blocked the start response')), 1000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

it.each(['github', 'circleci'] as const)('records pending publication and answers reads before the %s mirror push finishes', async provider => {
  const f = await fixture({}, { provider })
  const release = blockPush(f.git)
  const runId = randomUUID()
  const start = f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full', deferMirror: true })
  try {
    expect(await promptly(start)).toMatchObject({ run: { mirrorPublication: { state: 'pending' } } })
    expect(await promptly(f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })))
      .toMatchObject({ run: { mirrorPublication: { state: 'pending' } } })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    release()
    await expect.poll(async () => (await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })), { timeout: 5000 })
      .toMatchObject({ run: { mirrorPublication: { state: 'ready', snapshotCommit: expect.any(String),
        timings: { pushMs: expect.any(Number), totalMs: expect.any(Number) } } } })
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
  } finally {
    release()
    await start
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  }
})

it('cancels pending publication promptly and never triggers its workflow after the push', async () => {
  const f = await fixture()
  const release = blockPush(f.git)
  const runId = randomUUID()
  const start = f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full', deferMirror: true })
  try {
    await promptly(start)
    expect(await promptly(f.cloud.handle({ operation: 'cancel', runId }))).toMatchObject({ run: {
      state: 'starting', mirrorPublication: { state: 'pending' },
      message: 'Cancellation requested; waiting for the provider to stop.',
    } })
    release()
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'canceled' } })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
  } finally {
    release()
    await start
  }
})

it('reuses the previous public snapshot after reopening without exporting private history', async () => {
  const f = await fixture()
  const start = (commit: string) => f.reopen().handle({ operation: 'start', runId: randomUUID(),
    workspaceId: 'ci-workspace', repository: 'octo/site', commit, suite: 'lint', scope: 'full' })
  await start(f.commit)
  const first = f.mirrorGit('rev-parse', 'main')
  await f.write('README.md', 'Changed snapshot\n')
  f.run('add', '.')
  f.run('commit', '-qm', 'private history must stay private')
  const second = f.run('rev-parse', 'HEAD')
  f.push('main')
  const response = await start(second)
  expect(response).toMatchObject({ run: { mirrorPublication: { state: 'ready', reusedSnapshot: first } } })
  expect(f.mirrorGit('rev-parse', 'main^')).toBe(first)
  expect(f.mirrorGit('log', '--all', '--format=%s')).not.toContain('private history')
  expect(() => f.mirrorGit('cat-file', '-e', second)).toThrow()
  expect(f.mirrorGit('show', 'main:README.md')).toBe('Changed snapshot')
})

it('records privacy rejection without publishing or dispatching', async () => {
  const f = await fixture({ 'README.md': 'owner-desktop must remain private\n' })
  const runId = randomUUID()
  const head = f.mirrorGit('rev-parse', 'main')
  expect(await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', deferMirror: true }))
    .toMatchObject({ run: { mirrorPublication: { state: 'pending' } } })
  await expect.poll(async () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }), { timeout: 5000 })
    .toMatchObject({ run: { state: 'failed', mirrorPublication: { state: 'failed' },
      message: expect.stringContaining('Not published to the public CI mirror') } })
  expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  expect(f.dispatched).toHaveLength(0)
})

it('retains cloud ownership when the dispatch reply is lost after publication succeeds', async () => {
  const f = await fixture()
  const original = f.ports.run.bind(f.ports)
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    const result = await original(file, args, options)
    if (file === 'gh' && args[0] === 'workflow' && args[1] === 'run') throw new Error('Dispatch reply lost')
    return result
  })
  const runId = randomUUID()
  expect(await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full', deferMirror: true }))
    .toMatchObject({ run: { mirrorPublication: { state: 'pending' } } })
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'starting', mirrorPublication: { state: 'ready' } } })
  expect(f.dispatched).toHaveLength(1)
})
