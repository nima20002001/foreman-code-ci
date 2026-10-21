import { expect, it } from 'vitest'
import { ciGroupState } from '../src/modules/ci-host/parts.js'

it('reports a CI group passed only when its jobs have passed', () => {
  expect(ciGroupState([{ state: 'passed' }])).toBe('passed')
  expect(ciGroupState([{ state: 'passed' }, { state: 'failed' }])).toBe('failed')
  expect(ciGroupState([{ state: 'passed' }, { state: 'queued' }])).toBe('queued')
})
