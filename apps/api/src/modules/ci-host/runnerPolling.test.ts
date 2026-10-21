import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'

it('batches all active units once per status poll and keeps their resource usage in capacity', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-poll-'))
  const calls: string[][] = []
  const ports: HostCiPorts = { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30, run: async (file, args) => {
      if (file === 'systemctl') calls.push([...args])
      const units = args.filter(arg => arg.endsWith('.service'))
      const stdout = args.includes('show')
        ? units.map(unit => `Id=${unit}\nLoadState=loaded\nActiveState=active\n`).join('\n')
        : file === 'systemctl' ? 'active\n' : ''
      return { code: 0, stdout, stderr: '' }
    } }
  const ids = Array.from({ length: 3 }, () => randomUUID())
  try {
    for (const runId of ids) {
      const directory = join(root, 'runs', runId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'example/project',
        commit: 'a'.repeat(40), suite: 'lint', state: 'running', startedAt: '2026-10-13T00:00:00Z',
        finishedAt: null, exitCode: null, message: null, cleaned: false,
        resources: { cpuCount: 2, memoryBytes: 2 * 2 ** 30 } }))
      await writeFile(join(directory, 'log'), '')
    }
    const runner = new HostCiRunner(root, ports)
    const status = await runner.handle({ operation: 'status' })
    expect(status).toMatchObject({ operation: 'status', ready: true, slotsUsed: 3 })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs.map(run => run.runId).sort()).toEqual(ids.sort())
    expect(status.runs.every(run => run.state === 'running')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.arrayContaining(ids.map(id => `foreman-ci-${id}.service`)))
    await runner.handle({ operation: 'status' })
    expect(calls).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { state: 'active', load: 'loaded', code: 0, expected: 'running' },
  { state: 'activating', load: 'loaded', code: 0, expected: 'running' },
  { state: 'reloading', load: 'loaded', code: 0, expected: 'running' },
  { state: 'deactivating', load: 'loaded', code: 0, expected: 'running' },
  { state: 'inactive', load: 'loaded', code: 0, expected: 'lost' },
  { state: 'failed', load: 'loaded', code: 0, expected: 'lost' },
  { state: 'inactive', load: 'not-found', code: 0, expected: 'lost' },
  { state: 'inactive', load: 'not-found', code: 1, expected: 'running' },
  { state: '', load: '', code: 0, expected: 'running' },
])('maps batched $load/$state (command exit $code) without confusing units', async scenario => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-batch-state-'))
  const ids = [randomUUID(), randomUUID()]
  let unitStateReads = 0
  const ports: HostCiPorts = {
    now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
    run: async (file, args) => {
      if (file !== 'systemctl') return { code: 0, stdout: '', stderr: '' }
      unitStateReads++
      // Return records out of request order and include an unrelated unit.
      const stdout = [
        `Id=unrelated.service\nLoadState=loaded\nActiveState=inactive`,
        `Id=custom.service\nLoadState=loaded\nActiveState=active`,
        `Id=foreman-ci-${ids[0]}.service\nLoadState=${scenario.load}\nActiveState=${scenario.state}`,
      ].join('\n\n')
      expect(args).toContain('show')
      return { code: scenario.code, stdout, stderr: '' }
    },
  }
  try {
    for (const [index, runId] of ids.entries()) {
      const directory = join(root, 'runs', runId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'example/project',
        commit: 'a'.repeat(40), suite: 'lint', state: 'running', startedAt: '2026-10-13T00:00:00Z',
        finishedAt: null, exitCode: null, message: null, cleaned: false,
        ...(index === 1 ? { serviceUnit: 'custom.service' } : {}) }))
      await writeFile(join(directory, 'log'), '')
    }
    const runner = new HostCiRunner(root, ports)
    const reply = await runner.handle({ operation: 'status' })
    if (reply.operation !== 'status') throw new Error('Expected CI status')
    expect(reply.runs.find(run => run.runId === ids[0])?.state).toBe(scenario.expected)
    expect(reply.runs.find(run => run.runId === ids[1])?.state).toBe('running')
    expect(unitStateReads).toBe(1)
    await runner.beginDrain()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rechecks a unit when launch metadata changes during the batched query', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-launch-query-'))
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  const meta = { runId, repository: 'example/project', commit: 'a'.repeat(40), suite: 'lint',
    state: 'starting', startedAt: '2026-10-13T00:00:00Z', finishedAt: null,
    exitCode: null, message: null, cleaned: false }
  let unitStateReads = 0
  const runner = new HostCiRunner(root, {
    now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
    run: async file => {
      if (file !== 'systemctl') return { code: 0, stdout: '', stderr: '' }
      unitStateReads++
      if (unitStateReads === 1) await writeFile(join(directory, 'meta.json'), JSON.stringify({ ...meta, state: 'running' }))
      const state = unitStateReads === 1 ? 'inactive' : 'active'
      return { code: 0, stdout: `Id=foreman-ci-${runId}.service\nLoadState=loaded\nActiveState=${state}\n`, stderr: '' }
    },
  })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'meta.json'), JSON.stringify(meta))
    await writeFile(join(directory, 'log'), '')
    const reply = await runner.handle({ operation: 'status' })
    expect(reply).toMatchObject({ runs: [{ runId, state: 'running' }], slotsUsed: 1 })
    expect(unitStateReads).toBe(2)
    await runner.beginDrain()
  } finally { await rm(root, { recursive: true, force: true }) }
})
