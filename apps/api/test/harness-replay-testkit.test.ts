import { expect, it } from 'vitest'
import { ReplayGate, StrictProtocolReplay } from './support/harnessReplay.js'

it('strictly validates outbound frames, ordering and complete consumption', async () => {
  const replay = new StrictProtocolReplay({ schemaVersion: 1, provider: 'fixture', protocolRevision: 'v1', redacted: true,
    steps: [{ operation: 'submit', input: { turn: 'A' }, result: { accepted: true } },
      { operation: 'read', input: { turn: 'A' }, result: { state: 'completed' } }] })
  await expect(replay.call('submit', { turn: 'B' })).rejects.toThrow('Replay input')
  expect(await replay.call('submit', { turn: 'A' })).toEqual({ accepted: true })
  expect(() => replay.finish()).toThrow('unused')
  await expect(replay.call('submit', { turn: 'A' })).rejects.toThrow('Replay operation')
  expect(await replay.call('read', { turn: 'A' })).toEqual({ state: 'completed' })
  replay.finish()
  await expect(replay.call('unexpected', {})).rejects.toThrow('Unexpected outbound')
})

it('gates acknowledgement and late completion independently without sleeps', async () => {
  const acknowledgement = new ReplayGate<string>()
  const completion = new ReplayGate<string>()
  const observed: string[] = []
  const admitted = acknowledgement.promise.then((id) => { observed.push(id) })
  const finished = completion.promise.then((id) => { observed.push(id) })
  acknowledgement.release('ack-A')
  await admitted
  expect(observed).toEqual(['ack-A'])
  completion.release('complete-A')
  await finished
  expect(observed).toEqual(['ack-A', 'complete-A'])
  expect(() => completion.release('duplicate')).toThrow('already settled')
})
