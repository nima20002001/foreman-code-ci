import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { MaintenanceTask, WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

const signal = () => AbortSignal.timeout(2000)

async function scheduled(maintenance: ComputerMaintenance) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await maintenance.status(signal())
    if (status.tasks[0]?.workerTargetVersion) return status
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Worker update was not scheduled.')
}

describe('Worker update maintenance lifecycle', () => {
  it.each([false, true, undefined])('passes retry classification to the updater (%s)', async retry => {
    const computer = fakeComputer()
    const attempts: unknown[] = []
    const maintenance = new ComputerMaintenance({ ...computer.ports, workerUpdate: {
      status: async () => ({ currentVersion: '1.0.0', targetVersion: null, state: 'current', lastError: null }),
      start: async options => { attempts.push(options); return 'Worker is current.' },
    } })
    await maintenance.start({ kind: 'update-worker', ...(retry === undefined ? {} : { retry }) })
    await maintenance.drain()
    expect(attempts).toEqual([{ retry: retry ?? true }])
  })

  it.each(['current', 'rolled-back'] as const)('recovers the first %s result after a later release without an intermediate poll',
    async firstState => {
      const computer = fakeComputer()
      const outcomes = new Map<string, WorkerUpdateStatus>()
      let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: null, state: 'current', lastError: null }
      let attempts = 0
      const ports = { ...computer.ports, workerUpdate: { status: async () => worker,
        outcome: async (task: MaintenanceTask) => outcomes.get(task.workerTargetVersion ?? '') ?? null,
        start: async () => {
          worker = { ...worker, targetVersion: ++attempts === 1 ? '1.1.0' : '1.2.0', state: 'restarting' }
          return `Worker ${worker.targetVersion} restart is scheduled.`
        } } }
      const first = new ComputerMaintenance(ports)
      const firstTask = await first.start({ kind: 'update-worker' })
      await new Promise(resolve => setTimeout(resolve, 5))
      worker = { currentVersion: firstState === 'current' ? '1.1.0' : '1.0.0', targetVersion: '1.1.0',
        state: firstState, lastError: firstState === 'current' ? null : 'worker_update_startup_timeout' }
      outcomes.set('1.1.0', worker)
      const replacement = new ComputerMaintenance(ports)
      const secondTask = await replacement.start({ kind: 'update-worker' })
      await new Promise(resolve => setTimeout(resolve, 5))
      worker = { currentVersion: '1.2.0', targetVersion: '1.2.0', state: 'current', lastError: null }
      outcomes.set('1.2.0', worker)
      const status = await replacement.status(signal())
      expect(status.tasks.find(task => task.id === firstTask.id)).toMatchObject({
        state: firstState === 'current' ? 'succeeded' : 'failed',
      })
      expect(status.tasks.find(task => task.id === secondTask.id)).toMatchObject({ state: 'succeeded' })
    })

  it('waits through restart and reports success only after matching-version ready readback', async () => {
    const computer = fakeComputer()
    let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: '1.1.0',
      state: 'current', lastError: null }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ports = { ...computer.ports, workerUpdate: { status: async () => worker,
      start: async () => {
        await gate
        worker = { ...worker, state: 'restarting' }
        return 'Worker 1.1.0 restart is scheduled.'
      } } }
    const maintenance = new ComputerMaintenance(ports)
    const commandId = randomUUID()
    const task = await maintenance.start({ kind: 'update-worker' }, commandId)
    expect((await maintenance.status(signal())).tasks[0]?.state).toBe('running')
    release()
    expect((await scheduled(maintenance)).tasks[0]).toMatchObject({ state: 'running', workerTargetVersion: '1.1.0' })
    const restarted = new ComputerMaintenance(ports)
    expect((await restarted.status(signal())).tasks[0]).toMatchObject({ id: task.id, state: 'running' })
    expect(await restarted.start({ kind: 'update-worker' }, commandId)).toMatchObject({ id: task.id, state: 'running' })
    worker = { currentVersion: '1.1.0', targetVersion: '1.1.0', state: 'current', lastError: null }
    expect((await restarted.status(signal())).tasks[0]).toMatchObject({ id: task.id, state: 'succeeded' })
    expect(await restarted.start({ kind: 'update-worker' }, commandId)).toMatchObject({ id: task.id, state: 'succeeded' })
  })

  it('persists a failed maintenance result after the supervisor restores the previous version', async () => {
    const computer = fakeComputer()
    let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: '1.1.0',
      state: 'restarting', lastError: null }
    const ports = { ...computer.ports, workerUpdate: { status: async () => worker,
      start: async () => 'Worker 1.1.0 restart is scheduled.' } }
    const maintenance = new ComputerMaintenance(ports)
    await maintenance.start({ kind: 'update-worker' })
    await scheduled(maintenance)
    worker = { ...worker, state: 'rolled-back', lastError: 'worker_update_startup_timeout' }
    const restarted = new ComputerMaintenance(ports)
    const status = await restarted.status(signal())
    expect(status.worker).toEqual(worker)
    expect(status.tasks[0]).toMatchObject({ state: 'failed', summary: 'worker_update_startup_timeout' })
  })

  it('excludes its own update task from maintenance draining and reports supervisor launch rejection', async () => {
    const computer = fakeComputer()
    let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: null, state: 'current', lastError: null }
    const maintenance: ComputerMaintenance = new ComputerMaintenance({ ...computer.ports, workerUpdate: { status: async () => worker,
      start: async () => {
        await maintenance.drainForWorkerUpdate()
        worker = { ...worker, targetVersion: '1.1.0', state: 'failed', lastError: 'supervisor refused restart' }
        throw new Error(worker.lastError!)
      } } })
    await maintenance.start({ kind: 'update-worker' })
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await maintenance.status(signal())
      if (status.tasks[0]?.state === 'failed') {
        expect(status.tasks[0].summary).toBe('supervisor refused restart')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error('Worker update waited on its own maintenance task.')
  })
})
