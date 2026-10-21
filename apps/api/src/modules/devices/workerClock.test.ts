import { describe, expect, it } from 'vitest'
import { MainClock, workerClockReason } from './workerClock.js'

describe('Worker clock trust', () => {
  it.each([-120001, 120001])('rejects a %s ms clock offset with a readable reason', offset => {
    expect(workerClockReason(1000000 + offset, 1000000)).toContain('more than 2 minutes')
  })
  it.each([-120000, 0, 120000])('trusts a %s ms clock offset at the allowed boundary', offset => {
    expect(workerClockReason(1000000 + offset, 1000000)).toBeNull()
  })
  it('does not trust a connection with no Worker clock observation', () => {
    expect(workerClockReason(null, 1000000)).toContain('has not been observed')
  })
  it('compares qualification expiry against Main time through Worker wall-clock rollback', () => {
    let elapsed = 10
    const clock = new MainClock(() => elapsed)
    expect(() => clock.now()).toThrow('has not been observed')
    clock.observe(1000000)
    elapsed += 30000
    expect(clock.now()).toBe(1030000)
    expect(clock.now() >= 1020000).toBe(true)
    clock.observe(900000)
    elapsed += 1000
    expect(clock.now()).toBe(901000)
  })
})
