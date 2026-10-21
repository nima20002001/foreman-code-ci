import { expect, it } from 'vitest'
import { commandInputHash } from './commandIdentityNode.js'

it('preserves the existing command identity bytes and property-order normalization', () => {
  expect(commandInputHash({ b: 2, a: 1 })).toBe('sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  expect(commandInputHash({ a: 1, b: 2 })).toBe(commandInputHash({ b: 2, a: 1 }));
  expect(commandInputHash([1, 2])).not.toBe(commandInputHash([2, 1]));
})
