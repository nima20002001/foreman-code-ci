import { describe, expect, it } from 'vitest'
import { burstRead } from './burstRead.js'

describe('burstRead', () => {
  it('serves callers that start together with one read', async () => {
    let reads = 0
    const read = burstRead(async () => ++reads)
    expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1])
    expect(reads).toBe(1)
  })

  it('reads again for a caller that starts after the read was sent', async () => {
    let state = 'live'
    const reads: string[] = []
    let sent!: () => void
    const wasSent = new Promise<void>(resolve => { sent = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const read = burstRead(async () => {
      const number = reads.push(state); sent(); await held
      return number
    })
    const first = read()
    await wasSent
    state = 'revoked'
    const second = read()
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(reads).toEqual(['live', 'revoked'])
  })

  it('gives every sharing caller the failure of the shared read', async () => {
    const read = burstRead<number>(async () => { throw new Error('revoked') })
    const results = await Promise.allSettled([read(), read()])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    await expect(read()).rejects.toThrow('revoked')
  })
})
