import { describe, expect, it } from 'vitest'

import {
  firstOccurrence,
  makeJoinRepeatFixture,
  repeatExitOutput,
  resolutionFor,
} from './helpers/eng04RepeatFixtures.js'
import {
  assertRepeatBodyComplete,
  decideRepeatAdmission,
} from '../src/modules/runs/repeatResolution.js'
import { inactiveRepeatResolution } from '../src/modules/runs/repeatNode.js'

describe('NIM-2648 ENG04-D occurrence-local joins and selected branches', () => {
  it('waits for the unequal-depth selected predecessors and ignores the explicitly unselected branch', () => {
    const fixture = makeJoinRepeatFixture()
    const current = firstOccurrence(fixture).occurrence
    const resolutions = new Map()

    const start = resolutionFor(fixture, current, 'start')
    resolutions.set('start', start)
    expect(start.value.selectedRelationshipIds.sort()).toEqual(['start-choose', 'start-fast'])

    const fast = resolutionFor(fixture, current, 'fast')
    resolutions.set('fast', fast)
    const choice = resolutionFor(fixture, current, 'choose', { routing: { outcome: 'deep' }, data: { rawDecisionId: 'choice-deep-1' } })
    resolutions.set('choose', choice)
    expect(choice.value.selectedRelationshipIds).toEqual(['choose-deep1'])
    expect(choice.value.unselectedRelationshipIds).toEqual(['choose-unused'])

    const unusedAdmission = decideRepeatAdmission(fixture.version, { nodeId: 'unused', occurrence: current.identity }, resolutions)
    expect(unusedAdmission.kind).toBe('skipped')
    const unused = inactiveRepeatResolution(fixture.version, { nodeId: 'unused', occurrence: current.identity }, 'skipped', '2026-09-25T02:21:00.000Z')
    resolutions.set('unused', unused)

    expect(decideRepeatAdmission(fixture.version, { nodeId: 'join', occurrence: current.identity }, resolutions).kind).toBe('waiting')
    resolutions.set('deep1', resolutionFor(fixture, current, 'deep1'))
    expect(decideRepeatAdmission(fixture.version, { nodeId: 'join', occurrence: current.identity }, resolutions).kind).toBe('waiting')
    resolutions.set('deep2', resolutionFor(fixture, current, 'deep2'))

    const join = decideRepeatAdmission(fixture.version, { nodeId: 'join', occurrence: current.identity }, resolutions)
    expect(join.kind).toBe('run')
    if (join.kind !== 'run') throw new Error('join should be selected')
    expect(join.selected.map((item) => item.id).sort()).toEqual(['deep2-join', 'fast-join'])
  })

  it('does not allow prior-occurrence resolutions to satisfy a later occurrence join', () => {
    const fixture = makeJoinRepeatFixture(2)
    const first = firstOccurrence(fixture).occurrence
    const old = new Map([
      ['start', resolutionFor(fixture, first, 'start')],
      ['fast', resolutionFor(fixture, first, 'fast')],
      ['choose', resolutionFor(fixture, first, 'choose', { routing: { outcome: 'deep' }, data: {} })],
      ['deep1', resolutionFor(fixture, first, 'deep1')],
      ['deep2', resolutionFor(fixture, first, 'deep2')],
      ['unused', inactiveRepeatResolution(fixture.version, { nodeId: 'unused', occurrence: first.identity }, 'skipped', '2026-09-25T02:21:00.000Z')],
    ])
    const laterIdentity = { ...first.identity, occurrenceId: 'occurrence-later-exact', occurrenceIndex: 2 }
    expect(() => decideRepeatAdmission(fixture.version, { nodeId: 'join', occurrence: laterIdentity }, old)).toThrow()
  })

  it('requires every selected or skipped body member in the same occurrence before the repeat exit is complete', () => {
    const fixture = makeJoinRepeatFixture(1)
    const occurrence = firstOccurrence(fixture).occurrence
    const map = new Map([
      ['start', resolutionFor(fixture, occurrence, 'start')],
      ['fast', resolutionFor(fixture, occurrence, 'fast')],
      ['choose', resolutionFor(fixture, occurrence, 'choose', { routing: { outcome: 'deep' }, data: {} })],
      ['deep1', resolutionFor(fixture, occurrence, 'deep1')],
      ['deep2', resolutionFor(fixture, occurrence, 'deep2')],
      ['unused', inactiveRepeatResolution(fixture.version, { nodeId: 'unused', occurrence: occurrence.identity }, 'skipped', '2026-09-25T02:21:00.000Z')],
      ['join', resolutionFor(fixture, occurrence, 'join')],
    ])
    expect(() => assertRepeatBodyComplete(fixture.version, occurrence.identity, map)).toThrow()
    map.set('review', resolutionFor(fixture, occurrence, 'review', repeatExitOutput(1, 'pass')))
    expect(() => assertRepeatBodyComplete(fixture.version, occurrence.identity, map)).not.toThrow()
  })
})
