import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each(['github', 'circleci'] as const)('retains %s ownership and refs until every canceled attempt stops', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  if (provider === 'github') f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  await f.cloud.handle(read)
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  f.advance(5 * 60_000)
  expect(await f.cloud.handle({ operation: 'cancel', runId }))
    .toMatchObject({ run: { state: 'running', finishedAt: null } })
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}`)).toBeTruthy()
  f.advance(75_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  if (provider === 'github') Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  else f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(4_001)
  const reopened = f.reopen()
  expect(await reopened.handle(read)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
  await reopened.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/ci/${f.commit}`)).toBe('')
  expect(provider === 'github' ? f.github.canceled : f.circle.canceled)
    .toEqual(provider === 'github' ? ['91'] : ['run-1'])
})

it('retains ownership when terminal status cannot be read after cancellation', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  await f.cloud.handle({ operation: 'cancel', runId })
  f.circle.lookupError = 'permission denied'
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  for (let poll = 0; poll < 3; poll++) {
    f.advance(75_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  }
})

it('waits for a late GitHub duplicate to stop and remembers it when discovery no longer lists it', async () => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  await f.cloud.handle(read)
  await f.cloud.handle({ operation: 'cancel', runId })
  f.github.listed.push({ databaseId: 92, displayTitle: `ci ${runId}` })
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  let duplicateStopped = false
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'gh' && args[0] === 'api' && args.some(arg => arg.includes('/runs/92/jobs')) && !duplicateStopped) {
      return { code: 0, stderr: '', stdout: 'HTTP/2.0 200 OK\r\n\r\n'
        + JSON.stringify({ jobs: [{ id: 92, status: 'in_progress', steps: [] }] }) }
    }
    return original(file, args, options)
  })
  f.advance(75_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  f.github.listed.pop()
  f.advance(4_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  duplicateStopped = true
  f.advance(4_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.github.canceled).toEqual(['91', '92'])
})
