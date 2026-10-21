import { afterEach } from 'vitest'
import { approvalDatabase } from './wave25ApprovalDatabase.js'
import { graphParity } from './wave25R1GraphParity.js'

export function reviewHeartbeatFixtures() {
  const closes: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (closes.length) await closes.pop()!()
  })

  async function fixture(registerCleanup?: (close: () => Promise<void>) => void) {
    const url = new URL(process.env.TEST_DATABASE_URL ?? '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.pathname.toLowerCase().includes('test')) {
      throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
    }
    const f = await approvalDatabase()
    if (registerCleanup) registerCleanup(f.close)
    else closes.push(f.close)
    return f
  }

  async function graph(f: Awaited<ReturnType<typeof fixture>>) {
    return (await graphParity(f.pool, f.scope)).compare()
  }

  return { fixture, graph }
}
