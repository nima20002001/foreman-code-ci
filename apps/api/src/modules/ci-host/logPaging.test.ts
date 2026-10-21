import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'
import { CloudCi } from './cloud.js'
import type { CloudProvider } from './cloudProviders.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(kind: 'host' | 'cloud', text: string) {
  const root = await privateFixtureDirectory('ci-log-pages-')
  roots.push(root)
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'fixture/site',
    mirror: 'fixture/mirror', providerRunId: 'provider-run', commit: 'a'.repeat(40), suite: 'lint',
    startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z',
    state: 'passed', exitCode: 0, message: null, cleaned: true, partition: null }))
  await writeFile(join(directory, 'log'), text)
  const ports: HostCiPorts = { cpus: 8, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async () => { throw new Error('A completed log read must not launch or query a service') } }
  const git: GitWorktreePorts = {
    cloneDirectory: () => join(root, 'clone'),
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
  }
  const runner = kind === 'host' ? new HostCiRunner(root, ports, {})
    : new CloudCi('fixture-main', { id: 'github', label: 'Cloud' } as CloudProvider, async () => null, root, ports, git)
  const read = async (afterOffset: number, maxBytes: number) => {
    const reply = await runner.handle({ operation: 'read', runId, afterOffset, maxBytes })
    if (reply.operation !== 'read') throw new Error('Expected a log page')
    return reply
  }
  return { read }
}

it.each(['host', 'cloud'] as const)('%s log pages reconstruct accented, CJK and emoji text', async kind => {
  const text = 'aé中🙂zé🙂中\n'
  const f = await fixture(kind, text)
  let offset = 0
  let result = ''
  for (let page = 0; offset < Buffer.byteLength(text) && page < 20; page++) {
    const reply = await f.read(offset, 4)
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(4)
    expect(reply.text).not.toContain('\uFFFD')
    expect(reply.nextOffset).toBeGreaterThan(offset)
    offset = reply.nextOffset
    result += reply.text
  }
  expect(result).toBe(text)
  expect(offset).toBe(Buffer.byteLength(text))
})

it.each(['host', 'cloud'] as const)('%s advances an offset inside a character to the next complete character', async kind => {
  const f = await fixture(kind, 'é中🙂tail')
  expect(await f.read(1, 20)).toMatchObject({ text: '中🙂tail', nextOffset: 13 })
  expect(await f.read(3, 20)).toMatchObject({ text: '🙂tail', nextOffset: 13 })
  expect(await f.read(7, 6)).toMatchObject({ text: 'tail', nextOffset: 13 })
  expect(await f.read(5, 1)).toMatchObject({ text: '', nextOffset: 5 })
})
