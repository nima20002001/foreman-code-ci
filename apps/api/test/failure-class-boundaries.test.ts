import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { toolFailure } from '../src/mcp/shared/results.js'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { DomainError } from '../src/modules/errors.js'
import { isTransientRefreshFailure } from '../src/modules/leases/ownerLeases.js'
import { isTransientExecutionError } from '../src/modules/runs/executionRetryPolicy.js'
import { relayFailureReply } from '../src/modules/runs/remote/workerMcpEndpoint.js'
import { managedMcpChannelFixture } from './helpers/managedMcpChannel.js'

const socketLost = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

/** What the requesting peer receives when the serving peer's handler throws `thrown`. */
async function acrossDeviceChannel(thrown: unknown): Promise<DeviceApplicationError> {
  const channel = managedMcpChannelFixture({
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(),
    connectionEpoch: randomUUID(), connectionGeneration: 1,
  }, {
    namespace: 'execution-v1', version: 1, role: 'server', maxJsonBytes: 4096, maxBinaryBytes: 0,
    handle: async () => { throw thrown },
  })
  try {
    const received = await channel.main.request('execution-v1', { method: 'physical-readout' }).catch((error: unknown) => error)
    expect(received).toBeInstanceOf(DeviceApplicationError)
    return received as DeviceApplicationError
  } finally {
    await channel.close()
  }
}

describe('failure class across the device channel', () => {
  it('keeps a transient failure with a code outside the device table transient under a redacted code', async () => {
    const received = await acrossDeviceChannel(
      new DomainError('WORKER_MCP_LEASE_UNAVAILABLE', 'The MCP lease is renewing.', 503, { retryable: true }))
    expect(received).toMatchObject({ code: 'unavailable', class: 'transient', retryable: true })
    expect(isTransientExecutionError(received)).toBe(true)
  })

  it('keeps an explicitly permanent failure permanent although its cause is a socket loss', async () => {
    const refused = await acrossDeviceChannel(
      Object.assign(new Error('Refused.', { cause: socketLost() }), { code: 'PROVIDER_REFUSED', retryable: false }))
    expect(refused).toMatchObject({ class: 'permanent', retryable: false })
    expect(isTransientExecutionError(refused)).toBe(false)
  })

  it('keeps a cancellation a cancellation', async () => {
    expect(await acrossDeviceChannel(new DeviceApplicationError('cancelled')))
      .toMatchObject({ code: 'cancelled', class: 'cancelled', retryable: false })
  })
})

describe('failure class in replies', () => {
  const apps: ReturnType<typeof buildApp>[] = []
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

  it('tells an MCP caller that an internal socket loss is transient without exposing it', () => {
    const reply = toolFailure(new Error('private detail', { cause: socketLost() }))
    expect(JSON.parse((reply.content[0] as { text: string }).text)).toEqual({ error: {
      code: 'INTERNAL_ERROR', message: 'The Operator service could not complete the request.', class: 'transient',
    } })
  })

  it('tells an HTTP caller that an internal socket loss is transient', async () => {
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } } })
    apps.push(app)
    app.get('/api/failure-class-probe', async () => { throw socketLost() })
    const response = await app.inject({ method: 'GET', url: '/api/failure-class-probe' })
    expect(response.statusCode).toBe(500)
    expect(response.json().error).toMatchObject({ code: 'INTERNAL_ERROR', class: 'transient' })
  })

  it('answers a relayed tool call that hit a socket loss as retryable', () => {
    const reply = relayFailureReply({ jsonrpc: '2.0', id: 7, method: 'tools/call' }, socketLost())
    expect(reply?.error.data).toMatchObject({ kind: 'relay_unavailable', retryable: true })
  })
})

describe('failure class through cause chains', () => {
  it('does not retry a credential renewal that states it is permanent', () => {
    expect(isTransientRefreshFailure(Object.assign(socketLost(), { retryable: false }))).toBe(false)
    expect(isTransientRefreshFailure(socketLost())).toBe(true)
  })

  it('keeps a coded domain refusal permanent when its preserved cause is an uncoded error', () => {
    const refusal = new DomainError('DIRECTORY_EXISTS', 'A folder with this name already exists.', 409, undefined,
      { cause: new Error('EEXIST: file already exists') })
    expect(isTransientExecutionError(refusal)).toBe(false)
    expect(isTransientExecutionError(new Error('Native process exited unexpectedly'))).toBe(true)
  })
})
