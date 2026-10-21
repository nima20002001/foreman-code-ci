import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { CiHostRequest } from '@foreman-code/contracts'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import type { HostCiComputer } from './service.js'

const computer: HostCiComputer = { key: 'device:builder', label: 'Builder', priority: 50,
  hostRef: { kind: 'device', mainId: 'main', deviceId: 'worker' } }
const run = { runId: '11111111-1111-4111-8111-111111111111', state: 'running' as const, step: 'unit', exitCode: null,
  startedAt: '2026-10-14T00:00:00.000Z', finishedAt: null, logBytes: 0, message: null }

it('passes background observation priority to the device while leaving requested log reads foreground', async () => {
  const request = vi.fn(async () => ({ payload: { operation: 'read', run, text: '', nextOffset: 0 } }))
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'main', () => ({ capabilities: () => [], request }),
    { handle: async () => { throw new Error('Unexpected local request') } }, [], undefined,
    new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
  const read = { operation: 'read' as const, runId: run.runId, afterOffset: 0, maxBytes: 10 }
  await endpoint.request(computer, read, { priority: 'background' })
  expect(request).toHaveBeenLastCalledWith('worker', 'ci-host-v1', read,
    { timeoutMs: 120_000, priority: 'background' })
  await endpoint.request(computer, read)
  expect(request).toHaveBeenLastCalledWith('worker', 'ci-host-v1', read,
    { timeoutMs: 120_000, priority: 'foreground' })
})

it('keeps the status prerequisite of a requested CI start in the foreground', async () => {
  const request = vi.fn(async (_device: string, _namespace: string, input: CiHostRequest) => ({
    payload: input.operation === 'status'
      ? { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30,
        runs: [], startProtocolVersion: 3 }
      : { operation: 'start', run },
  }))
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'main', () => ({ capabilities: () => [], request }),
    { handle: async () => { throw new Error('Unexpected local request') } }, [], undefined,
    new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
  vi.spyOn(endpoint, 'computers').mockResolvedValue([computer])
  const start = { operation: 'start' as const, runId: run.runId, repository: 'example/project', commit: 'a'.repeat(40),
    suite: 'unit' as const, scope: 'affected' as const, files: ['apps/api/src/example.test.ts'] }
  await endpoint.request(computer, start)
  expect(request).toHaveBeenNthCalledWith(1, 'worker', 'ci-host-v1',
    { operation: 'status', buildAllowancePercent: 100 },
    { timeoutMs: 120_000, priority: 'foreground' })
  expect(request).toHaveBeenNthCalledWith(2, 'worker', 'ci-host-v1', expect.objectContaining(start),
    { timeoutMs: 120_000, priority: 'foreground' })
})
