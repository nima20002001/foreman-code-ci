import { expect, it } from 'vitest'
import { compactIdentity } from './compactIdentity'

it('keeps short identities readable and extends matching prefixes without changing the identity', () => {
  expect(compactIdentity('codex-default', ['codex-default'])).toBe('codex-default')
  const a = '12345678-a'.padEnd(36, 'a'), b = '12345678-b'.padEnd(36, 'b')
  expect(compactIdentity(a, [a, b])).toBe('12345678-a…')
  expect(compactIdentity(b, [a, b])).toBe('12345678-b…')
  expect(compactIdentity(a, [a, a])).toBe('12345678…')
})
