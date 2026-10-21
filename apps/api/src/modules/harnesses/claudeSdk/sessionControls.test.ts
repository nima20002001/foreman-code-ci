import { expect, it } from 'vitest'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { claudeSessionEnvironment, claudeContextSnapshot, claudeContextProfiles } from './sessionControls.js'

it('compiles Off locally without disabling manual compaction and removes overrides on Default', () => {
  const source = { DISABLE_COMPACT: '1', DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k', PATH: '/bin' }
  const off = claudeSessionEnvironment(source, SessionPreferencesSchema.parse({ autoCompact: 'off', autoCompactTokens: 500000 }))
  expect(off).toEqual({ PATH: '/bin', DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' })
  expect(claudeSessionEnvironment(off, SessionPreferencesSchema.parse({}))).toEqual({ PATH: '/bin' })
  expect(source.DISABLE_COMPACT).toBe('1')
})
it('counts distinct input/cache fields once and leaves unknown capacity unknown', () => {
  const context = claudeContextSnapshot({ type: 'assistant', session_id: 'session', message: { usage: {
    input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 500,
  } } }, 'session', 'model', 3)
  expect(context).toMatchObject({ usedTokens: 560, capacityTokens: null, lifetimeTokens: null })
})

it('offers context profiles only for the selected model in the native account catalog', () => {
  const models = [{ value: 'sonnet', resolvedModel: 'claude-sonnet' },
    { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet' }, { value: 'opus[1m]', resolvedModel: 'claude-opus' }]
  expect(claudeContextProfiles(models, 'claude-sonnet', 200000)).toEqual([
    { id: 'sonnet', label: '200,000 tokens', capacity: 200000 },
    { id: 'sonnet[1m]', label: '1,000,000 tokens', capacity: 1000000 },
  ])
  expect(claudeContextProfiles([], 'unknown', null)).toEqual([])
})
