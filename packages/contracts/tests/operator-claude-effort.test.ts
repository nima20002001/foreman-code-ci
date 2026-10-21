import { expect, it } from 'vitest'
import { applyOperatorChatSettings, operatorChatSettings } from '../src/index.js'
import type { ClaudeHarnessConfiguration } from '../src/claude.js'

const base: ClaudeHarnessConfiguration = { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium',
  authMode: 'subscription', configDirectory: '/unit/profile', permissionMode: 'default', sandbox: 'read-only',
  tools: ['Read'], permissionRules: [], instructions: 'Keep the saved policy.', mcpServers: {} }

it('clears inherited effort when explicit Claude controls select a model without effort support', () => {
  const result = applyOperatorChatSettings(base, { harness: 'claude', model: 'claude-haiku-4-5-20251001', showThinking: false })
  const expected = { ...base, model: 'claude-haiku-4-5-20251001' }
  delete expected.effort
  expect(result).toEqual(expected)
  expect(result).not.toHaveProperty('effort')
  expect(base.effort).toBe('medium')
})

it('honors an explicit native-default effort selection on the same Claude model', () => {
  const result = applyOperatorChatSettings(base, { harness: 'claude', model: base.model, showThinking: false })
  expect(result).not.toHaveProperty('effort')
})

it('round-trips accepted Claude settings without inventing or dropping a recorded effort', () => {
  expect(applyOperatorChatSettings(base, operatorChatSettings(base))).toEqual(base)
  const withoutEffort = { ...base }
  delete withoutEffort.effort
  expect(applyOperatorChatSettings(withoutEffort, operatorChatSettings(withoutEffort))).toEqual(withoutEffort)
})
