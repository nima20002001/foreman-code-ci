import { expect, it } from 'vitest'
import { pendingOperatorSetupTarget } from './operatorSetupTarget'
import type { SendOperatorMessageRequest } from '@foreman-code/contracts'

it.each(['codex', 'claude'] as const)('checks the original %s pending command, never the other shared harness', (harness) => {
  const settings = harness === 'codex' ? { harness, model: 'saved', reasoningEffort: 'medium', serviceTier: 'standard', showThinking: false }
    : { harness, model: 'saved', effort: 'max', showThinking: false }
  const command = { requestId: 'original-id', content: 'original prompt', configurationVersionId: 'accepted-version', settings } as SendOperatorMessageRequest
  const before = structuredClone(command)
  const query = pendingOperatorSetupTarget('conversation', command)
  expect(query).toEqual({ conversationId: 'conversation', requestId: 'original-id', harness, configurationVersionId: 'accepted-version' })
  expect(query).not.toHaveProperty('expectedDefaultsRevision')
  expect(command).toEqual(before)
})

it('checks the frozen destination defaults of an unaccepted Claude harness change without changing its source pin', () => {
  const command: SendOperatorMessageRequest = { requestId: 'pending-hello', content: 'Say hello once.',
    configurationVersionId: 'source-codex-config', defaultsRevision: 5,
    settings: { harness: 'claude', model: 'opus5-5', effort: 'medium', showThinking: false } }
  const before = structuredClone(command)
  expect(pendingOperatorSetupTarget('owned-conversation', command)).toEqual({ conversationId: 'owned-conversation', requestId: 'pending-hello',
    harness: 'claude', configurationVersionId: 'source-codex-config', expectedDefaultsRevision: 5 })
  expect(command).toEqual(before)
})
