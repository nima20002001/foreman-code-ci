import { expect, it, vi } from 'vitest'
import { providerAccountsClient } from '../../features/provider-accounts/providerAccountsClient'
import { apiClient } from './client'

it('creates an Operator conversation without a caller-supplied command ID', async () => {
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue(undefined)

  await apiClient.createOperatorConversation({ title: 'A conversation' })

  expect(request).toHaveBeenCalledWith('/api/operator/conversations', expect.anything(), {
    method: 'POST',
    body: { title: 'A conversation', commandId: expect.any(String) },
  })
})

it('accepts an API-key request without a caller-supplied command ID', async () => {
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue(undefined)
  const apiKey = 'test-provider-key-for-request'

  await providerAccountsClient.apiKey('account-1', { expectedRevision: 0, apiKey })

  expect(request).toHaveBeenCalledWith('/api/provider-accounts/account-1/api-key', expect.anything(), {
    method: 'POST',
    body: { expectedRevision: 0, apiKey, commandId: expect.any(String) },
  })
})
