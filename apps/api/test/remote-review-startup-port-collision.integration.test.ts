import { createServer } from 'node:net'
import { expect, it, vi } from 'vitest'
import { DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'

vi.mock('node:net', async importOriginal => {
  const net = await importOriginal<typeof import('node:net')>()
  return { ...net, createServer: vi.fn(net.createServer) }
})

it.each([['API', 0], ['device', 1]] as const)(
  'starts production Main when a competing listener takes its selected %s port', async (_listener, selectedPort) => {
    const net = await vi.importActual<typeof import('node:net')>('node:net')
    const competing = net.createServer()
    let occupiedPort = 0
    let allocation = 0
    vi.mocked(createServer).mockImplementation((...args) => {
      if (allocation++ !== selectedPort) return net.createServer(...args)
      const probe = net.createServer()
      const close = probe.close.bind(probe)
      probe.close = callback => {
        const address = probe.address()
        if (!address || typeof address === 'string') throw new Error('Expected a bound loopback probe.')
        occupiedPort = address.port
        close(error => {
          if (error) {
            callback?.(error)
            return
          }
          competing.once('error', error => callback?.(error))
          competing.listen(occupiedPort, '127.0.0.1', () => callback?.())
        })
        return probe
      }
      return probe
    })
    let fixture: Awaited<ReturnType<typeof remoteReviewProduction>> | undefined
    try {
      fixture = await remoteReviewProduction({ workflow: 'single', parallelSetup: true })
      expect(occupiedPort).toBeGreaterThan(0)
      expect(competing.listening).toBe(true)
      expect(Number(new URL(fixture.origin()).port)).not.toBe(occupiedPort)
      const setup = DeviceSetupOptionsSchema.parse(await fixture.value('device_setup_options_get', {}))
      expect(setup.available).toBe(true)
      expect(Number(new URL(setup.endpoint!).port)).not.toBe(occupiedPort)
    } finally {
      vi.mocked(createServer).mockImplementation(net.createServer)
      try {
        await fixture?.close()
      } finally {
        if (competing.listening) {
          await new Promise<void>((resolve, reject) => competing.close(error => error ? reject(error) : resolve()))
        }
      }
    }
  }, 240_000,
)
