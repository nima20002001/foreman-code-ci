import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'

/** Records the mirror publications' fetches of the mirror's main and their pushes of it. */
function observe(f: Awaited<ReturnType<typeof fixture>>) {
  const calls = { mainFetches: 0, mainPushes: 0 }
  const git = f.git.git
  f.git.git = (args, options) => {
    if (args[0] === 'fetch' && args.some(arg => arg.startsWith('+main:'))) calls.mainFetches++
    if (args[0] === 'push' && args.some(arg => arg.endsWith(':refs/heads/main'))) calls.mainPushes++
    return git(args, options)
  }
  return calls
}

const start = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown>) => f.cloud.handle({
  operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
  suite: 'lint', scope: 'full', ...extra })

it('reuses one mirror snapshot for unsplit starts of a commit whose learned durations changed in between', async () => {
  const f = await fixture()
  const calls = observe(f)
  await start(f, { durations: { 'apps/api/test/a.integration.test.ts': 400 } })
  await start(f, { durations: { 'apps/api/test/a.integration.test.ts': 410 } })
  await start(f, {})
  expect(calls.mainPushes).toBe(1)
})

it('publishes a split start on a snapshot carrying exactly its own learned durations', async () => {
  const f = await fixture()
  const calls = observe(f)
  await start(f, { durations: { 'apps/api/test/a.integration.test.ts': 400 } })
  await start(f, { suite: 'unit', part: 'unit-api', partition: { index: 0, count: 2 },
    durations: { 'apps/api/test/a.integration.test.ts': 410 } })
  expect(calls.mainPushes).toBe(2)
  const learned = JSON.parse(f.mirrorGit('show', 'main:scripts/ci-learned-durations.json')) as Record<string, number>
  expect(learned['apps/api/test/a.integration.test.ts']).toBe(410)
})

it('starts the next publication from the snapshot it pushed instead of fetching the mirror main back', async () => {
  const f = await fixture()
  const calls = observe(f)
  await start(f, {})
  await f.write('apps/api/test/a.integration.test.ts', '// next\n')
  f.run('commit', '-qam', 'next')
  f.push('main')
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
    commit: f.run('rev-parse', 'HEAD'), suite: 'lint', scope: 'full' })
  expect(calls.mainPushes).toBe(2)
  expect(calls.mainFetches).toBe(1)
  // The second snapshot builds on the first one, as it would after a fetch.
  expect(f.mirrorGit('rev-list', '--count', 'main')).toBe('3')
})
