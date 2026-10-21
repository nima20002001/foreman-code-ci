import { afterEach, expect, it, vi } from 'vitest'
import type { CiRunRecord } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { deferred } from '../../../test/helpers/deferred.js'
import { dispatchFleet, queuedTicket } from './dispatchFleet.testSupport.js'
import type { HostCiComputer } from './service.js'

vi.mock('@foreman-code/contracts/canonical-json', async importOriginal => {
  const actual = await importOriginal<typeof import('@foreman-code/contracts/canonical-json')>()
  return { ...actual, canonicalJson: vi.fn(actual.canonicalJson) }
})

afterEach(() => { vi.restoreAllMocks() })

const slots = Array.from({ length: 5 }, (_, slot): HostCiComputer => ({ key: `cloud:github:${slot}`,
  label: `GitHub ${slot + 1}`, priority: 0, hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot } }))

const mirrorPayloadSerializations = () => vi.mocked(canonicalJson).mock.calls
  .filter(([value]) => typeof value === 'object' && value !== null && 'mirror' in value && 'durations' in value).length

it('prepares each ticket mirror snapshot once per pass however many cloud slots are free', async () => {
  const publication = deferred()
  const publishMirror = vi.fn(async () => publication.promise)
  const records: CiRunRecord[] = [queuedTicket({ commit: 'a'.repeat(40) }), queuedTicket({ commit: 'b'.repeat(40) })]
  const f = dispatchFleet(slots, records, { publishMirror })
  try {
    await f.service.dispatch()
    await f.service.drain()
    expect(publishMirror).toHaveBeenCalledTimes(2)
    vi.mocked(canonicalJson).mockClear()
    await f.service.dispatch()
    expect(f.started).toEqual([])
    expect(mirrorPayloadSerializations()).toBeLessThanOrEqual(records.length)
  } finally {
    publication.resolve()
    await f.service.close()
  }
})
