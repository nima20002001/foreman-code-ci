import { persistentFixtureRoot } from '../../../../test/helpers/fixtureStorage.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationChannel.js'
import { JobOutputCollectionError } from '../../jobs/executorOutputs.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import { createWorkerJobOutputCollector } from './workerJobOutputs.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('ends expired output collection while leaving a lost connection retryable', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'job-output-expiry-'))
  roots.push(root)
  await writeFile(join(root, 'result.json'), '{}', { mode: 0o600 })
  const execution = jobExecution()
  execution.acceptedSpec.target.hostRef = { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() }
  execution.acceptedSpec.target.destination.canonicalProjectRoot = root
  execution.acceptedSpec.outputs = [{ path: 'result.json', mediaType: 'application/json', required: true }]
  const request = vi.fn().mockRejectedValue(new DeviceApplicationError('job-output-expired'))
  const journal = { jobOutputCommand: vi.fn(async () => randomUUID()) } as unknown as RemoteOperationJournal
  const collect = createWorkerJobOutputCollector({ request }, { current: vi.fn(), retryable: vi.fn() }, journal)
  await expect(collect(execution)).rejects.toBeInstanceOf(JobOutputCollectionError)
  const disconnected = new DeviceApplicationError('transport')
  request.mockRejectedValue(disconnected)
  await expect(collect(execution)).rejects.toBe(disconnected)
})
