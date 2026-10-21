import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const metaReads = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
    if (String(path).endsWith('meta.json')) metaReads.push(String(path))
    return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFile }
})
const { pruneMirrorBranches } = await import('./mirrorBranches.js')

it('retains the same reserved refs in a large mirror and protects reservations added during deletion', async () => {
  const sha = 'a'.repeat(40)
  const branches = Array.from({ length: 4_000 }, (_, index) => `ci/snapshot-${index}`)
  const reserved = new Set(branches.filter((_, index) => index % 2 === 0))
  const commands: string[][] = []
  const result = await pruneMirrorBranches({ mirror: 'example/project-ci', roots: [],
    keep: () => [...reserved], git: async args => {
      commands.push(args)
      if (args[0] === 'ls-remote') return [...branches, 'ci-default/shared', 'feature/keep']
        .map(branch => `${sha}\trefs/heads/${branch}`).join('\n')
      if (commands.length === 2) reserved.add('ci/snapshot-3999')
      return ''
    } })
  expect(result.retained).toEqual(branches.filter(branch => reserved.has(branch)))
  expect(result.removed).toEqual([...branches.filter(branch => !reserved.has(branch)), 'ci-default/shared'])
  for (const args of commands.filter(args => args[0] === 'push')) {
    expect(args).toContain('--atomic')
    const deleted = args.filter(arg => arg.startsWith(':refs/heads/'))
    expect(deleted.length).toBeLessThanOrEqual(50)
    for (const ref of deleted) expect(args).toContain(`--force-with-lease=${ref.slice(1)}:${sha}`)
  }
})

it('reuses unchanged finished ticket metadata across sweeps and still protects a ticket that becomes active', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-mirror-'))
  const sha = 'b'.repeat(40)
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  const meta = (state: string) => JSON.stringify({ runId, startedAt: '2026-10-13T00:00:00Z', mirror: 'example/project-ci',
    commit: sha, state, mirrorBranch: `ci/${sha}` })
  const sweep = () => pruneMirrorBranches({ mirror: 'example/project-ci', roots: [root], git: async args =>
    args[0] === 'ls-remote' ? `${sha}\trefs/heads/ci/${sha}` : '' })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'meta.json'), meta('failed'))
    await sweep()
    metaReads.length = 0
    await sweep()
    expect(metaReads).toEqual([])
    await writeFile(join(directory, 'meta.json'), meta('queued'))
    expect((await sweep()).retained).toEqual([`ci/${sha}`])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
