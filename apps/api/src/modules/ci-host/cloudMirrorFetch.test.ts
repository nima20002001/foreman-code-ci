import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it('fetches the mirror once for back-to-back publications, also a minute apart, and publishes each tree', async () => {
  const f = await fixture()
  const git = vi.spyOn(f.git, 'git')
  const commits: string[] = []
  for (const name of ['one', 'two', 'three']) {
    await f.write(`${name}.txt`, `${name}\n`); f.run('add', '.'); f.run('commit', '-qm', name)
    commits.push(f.run('rev-parse', 'HEAD')); f.push(`HEAD:refs/heads/${name}`)
  }
  const start = (commit: string) => f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit, suite: 'lint', scope: 'full' })
  const mirrorFetches = () => git.mock.calls.filter(([args]) => args[0] === 'fetch'
    && args.includes('+main:refs/remotes/origin/main')).length

  await start(commits[0]!)
  await start(commits[1]!)
  expect(mirrorFetches()).toBe(1)
  f.advance(61_000)
  await start(commits[2]!)
  expect(mirrorFetches()).toBe(1)

  expect(f.dispatched).toHaveLength(3)
  for (const commit of commits) {
    expect(f.mirrorGit('rev-parse', `refs/heads/ci/${commit}^{tree}`)).toBe(f.run('rev-parse', `${commit}^{tree}`))
  }
})
