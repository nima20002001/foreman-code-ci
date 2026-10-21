import { expect, it, vi } from 'vitest'
import type { MaintenanceTask, WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer, mcpRequest } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

it('fails a Worker update task whose restart never reports back after 60 minutes, and keeps that result', async () => {
  const computer = fakeComputer()
  let now = Date.parse('2026-10-15T08:00:00.000Z')
  let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: null, state: 'current', lastError: null }
  const ports = { ...computer.ports, now: () => new Date(now), workerUpdate: { status: async () => worker,
    start: async () => {
      worker = { ...worker, targetVersion: '1.1.0', state: 'restarting' }
      return 'Worker 1.1.0 restart is scheduled.'
    } } }
  const maintenance = new ComputerMaintenance(ports)
  const task = await maintenance.start({ kind: 'update-worker' })
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await maintenance.status(AbortSignal.timeout(2000))).tasks[0]?.workerTargetVersion) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }

  now += 59 * 60_000
  expect((await maintenance.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'running' })
  now += 2 * 60_000
  const failed = (await maintenance.status(AbortSignal.timeout(2000))).tasks[0]
  expect(failed).toMatchObject({ id: task.id, state: 'failed', finishedAt: new Date(now).toISOString() })
  expect(failed?.summary).toMatch(/^MAINTENANCE_TASK_DEADLINE_EXCEEDED: phase worker-restart, age 61 min, over the 60 min limit\./u)
  expect(failed?.summary).toContain('not confirmed stopped')

  // A late Worker report does not turn the expired task into a success.
  worker = { currentVersion: '1.1.0', targetVersion: '1.1.0', state: 'current', lastError: null }
  expect((await maintenance.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'failed' })
  // The saved task list keeps the failure for a restarted process.
  const restarted = new ComputerMaintenance(ports)
  expect((await restarted.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'failed' })
})

it('keeps expired physical work tracked, skips its expired queue, and serializes a later request', async () => {
  const computer = fakeComputer()
  let now = Date.parse('2026-10-15T08:00:00.000Z')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const additions: string[] = []
  const maintenance = new ComputerMaintenance({ ...computer.ports, now: () => new Date(now),
    run: async (binary, args, options) => {
      if (args[0] === 'mcp' && args[1] === 'add') {
        additions.push(args[2]!)
        if (args[2] === 'first') {
          entered()
          await gate
        }
      }
      return computer.ports.run(binary, args, options)
    } })
  const first = await maintenance.start(mcpRequest(['first']))
  await started
  const queued = await maintenance.start(mcpRequest(['expired']))
  now += 61 * 60_000
  const expired = await maintenance.status(AbortSignal.timeout(2000))
  expect(expired.tasks.filter(task => [first.id, queued.id].includes(task.id)).map(task => task.state))
    .toEqual(['failed', 'failed'])
  let drained = false
  let updateDrained = false
  const drain = maintenance.drain().then(() => { drained = true })
  const updateDrain = maintenance.drainForWorkerUpdate().then(() => { updateDrained = true })
  const later = await maintenance.start(mcpRequest(['later']))
  await new Promise(resolve => setTimeout(resolve, 10))
  const beforeRelease = { drained, updateDrained, additions: [...additions] }
  release()
  await Promise.all([drain, updateDrain, maintenance.drain()])
  expect(beforeRelease).toEqual({ drained: false, updateDrained: false, additions: ['first'] })
  expect(additions).toEqual(['first', 'later'])
  const status = await maintenance.status(AbortSignal.timeout(2000))
  expect(status.tasks.find(task => task.id === queued.id)).toMatchObject({ state: 'failed' })
  expect(status.tasks.find(task => task.id === later.id)).toMatchObject({ state: 'succeeded' })
})

it('uses retained update completion times before expiring tasks on a delayed status read', async () => {
  const computer = fakeComputer()
  let now = Date.parse('2026-10-15T08:00:00.000Z')
  const startedAt = now
  let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: '1.1.0', state: 'restarting', lastError: null }
  let finishedAt: number | undefined
  const outcome = vi.fn(async (_task: MaintenanceTask, deadlineAt: string) => finishedAt !== undefined
    && finishedAt <= Date.parse(deadlineAt) ? worker : null)
  const ports = { ...computer.ports, now: () => new Date(now), workerUpdate: {
    status: async () => worker, outcome, start: async () => 'Worker restart is scheduled.' } }
  const maintenance = new ComputerMaintenance(ports)
  const task = await maintenance.start({ kind: 'update-worker' })
  await maintenance.drain()
  worker = { ...worker, currentVersion: '1.1.0', state: 'current' }
  finishedAt = startedAt + 20 * 60_000
  now += 70 * 60_000
  const restarted = new ComputerMaintenance(ports)
  expect((await restarted.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'succeeded' })
  expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }),
    new Date(startedAt + 60 * 60_000).toISOString())

  worker = { ...worker, targetVersion: '1.2.0', state: 'restarting' }
  const late = await restarted.start({ kind: 'update-worker' })
  await restarted.drain()
  finishedAt = now + 61 * 60_000
  now += 70 * 60_000
  worker = { ...worker, currentVersion: '1.2.0', state: 'current' }
  expect((await restarted.status(AbortSignal.timeout(2000))).tasks.find(task => task.id === late.id))
    .toMatchObject({ state: 'failed', summary: expect.stringContaining('MAINTENANCE_TASK_DEADLINE_EXCEEDED') })
})
