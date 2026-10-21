import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as string[])
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: ((file: string, ...rest: unknown[]) => {
    spawned.push(file)
    return (actual.spawn as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof actual.spawn }
})
const metaReads = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
    if (String(path).endsWith('meta.json')) metaReads.push(String(path))
    return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFile }
})
const { HostCiRunner } = await import('./runner.js')

it('reads settled runs on a status poll without starting a lock process per run', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-settled-'))
  const ids = Array.from({ length: 5 }, () => randomUUID())
  try {
    for (const runId of ids) {
      const directory = join(root, 'runs', runId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'example/project',
        commit: 'a'.repeat(40), suite: 'lint', state: 'passed', startedAt: '2026-10-13T00:00:00Z',
        finishedAt: '2026-10-13T00:01:00Z', exitCode: 0, message: null, cleaned: true }))
      await writeFile(join(directory, 'log'), '')
    }
    const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: () => 16 * 2 ** 30, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    spawned.length = 0
    const status = await runner.handle({ operation: 'status' })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs.map(run => [run.runId, run.state]).sort()).toEqual(ids.map(id => [id, 'passed']).sort())
    expect(spawned.filter(file => file.endsWith('flock'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reuses unchanged settled run metadata across status polls and rereads it after a change', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-settled-'))
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  const meta = (message: string | null) => JSON.stringify({ runId, repository: 'example/project',
    commit: 'a'.repeat(40), suite: 'lint', state: 'failed', startedAt: '2026-10-13T00:00:00Z',
    finishedAt: '2026-10-13T00:01:00Z', exitCode: 1, message, cleaned: true })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'meta.json'), meta(null))
    await writeFile(join(directory, 'log'), 'Lint output')
    const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: () => 16 * 2 ** 30, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    await runner.handle({ operation: 'status' })
    metaReads.length = 0
    await runner.handle({ operation: 'status' })
    expect(metaReads).toEqual([])
    await writeFile(join(directory, 'log'), 'é中🙂tail')
    await expect(runner.handle({ operation: 'read', runId, afterOffset: 9, maxBytes: 4 }))
      .resolves.toMatchObject({ text: 'tail', run: { logBytes: 13 }, nextOffset: 13 })
    expect(metaReads).toEqual([])
    await writeFile(join(directory, 'meta.json'), meta('Lint failed in a later report.'))
    const status = await runner.handle({ operation: 'status' })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs[0]?.message).toBe('Lint failed in a later report.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
