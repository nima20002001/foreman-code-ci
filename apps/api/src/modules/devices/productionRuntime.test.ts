import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { ProductionDeviceRuntime } from './productionRuntime.js'

afterEach(() => { vi.useRealTimers() })

it('initializes the device endpoint after a transient persisted identity read timeout', async () => {
  vi.useFakeTimers()
  const mainId = randomUUID()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity = {
    mainId,
    publicKey,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
  }
  const query = vi.fn()
    .mockRejectedValueOnce(new Error('Query read timeout'))
    .mockResolvedValueOnce({ rows: [{ id: mainId }] })
    .mockResolvedValue({ rows: [{ record: identity }] })
  const runtime = new ProductionDeviceRuntime({ query } as unknown as pg.Pool)
  const initialized = runtime.initialize(mainId).catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await initialized).toBeUndefined()
  expect(() => runtime.endpointForDomains()).not.toThrow()
  await runtime.drain()
})

it('cancels device identity initialization when shutdown closes admission', async () => {
  vi.useFakeTimers()
  const query = vi.fn().mockRejectedValue(new Error('Query read timeout'))
  const runtime = new ProductionDeviceRuntime({ query } as unknown as pg.Pool)
  const initialized = runtime.initialize(randomUUID()).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  runtime.stopAdmission()
  await runtime.drain()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await initialized).toBeInstanceOf(Error)
  expect(query).toHaveBeenCalledOnce()
  expect(() => runtime.endpointForDomains()).toThrow()
})
