import { expect, it } from 'vitest'
import { parseSessionCommand, sessionTaskContent } from './sessionCommands.js'
it('recognizes only registered command tokens at the command position', () => {
  for (const text of ['Use /plan tomorrow', '/plan/file.md', '"/compact"', '`/plan`', '/custom-skill']) {
    expect(parseSessionCommand(text).kind).toBe('message')
  }
  expect(parseSessionCommand('/compact extra')).toMatchObject({ kind: 'invalid' })
  expect(parseSessionCommand('/plan off extra')).toMatchObject({ kind: 'invalid' })
})
it('distinguishes bare mode changes from one actual Plan task', () => {
  expect(parseSessionCommand('/plan')).toEqual({ kind: 'mode', mode: 'plan' })
  expect(parseSessionCommand('/plan off')).toEqual({ kind: 'mode', mode: 'regular' })
  expect(sessionTaskContent('/plan Inspect the repository', 'plan')).toBe('Inspect the repository')
})
