import { expect, it, vi } from 'vitest'
import { RETIRED_OPENCODE_MESSAGE, type OperatorConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresOperatorRepository } from '../operators/postgres.js'
import { OperatorChatService } from './operatorChat.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'

const configuration: OperatorConfigurationVersion = {
  id: 'saved-configuration', operatorId: 'application-operator', version: 1,
  contentHash: `sha256:${'a'.repeat(64)}`, createdAt: '2026-10-01T00:00:00.000Z',
  harness: { harness: 'opencode', model: 'saved/model', variant: 'max', nativeAgent: 'build',
    thinking: true, autoApprove: false },
}
const owner: ManagementPrincipal = {
  id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read'], scope: {} }],
}

function fixture() {
  const read = vi.fn(async () => configuration)
  const allocate = vi.fn(() => { throw new Error('A retired configuration allocated a native manager') })
  const setup = vi.fn()
  const prepare = vi.fn()
  const service = new OperatorChatService({ configurationForInspection: read } as unknown as PostgresOperatorConversationRepository,
    { inspectionConfiguration: read } as unknown as PostgresOperatorRepository, allocate, '/saved', {
      current: async () => owner, assertConfiguration() {}, setup, prepare, release: async () => {},
    })
  return { service, read, allocate, setup, prepare }
}

it.each([{}, { configurationVersionId: configuration.id }])(
  'rejects retired Operator setup before allocating or inspecting native work: %j', async input => {
    const f = fixture()
    const original = structuredClone(configuration)
    await expect(f.service.setup(owner, input)).rejects.toMatchObject({
      code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE,
    })
    expect(configuration).toEqual(original)
    expect(f.allocate).not.toHaveBeenCalled()
    expect(f.setup).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
  },
)

it('denies setup without harness read access before looking up saved configuration', async () => {
  const f = fixture()
  await expect(f.service.setup({ ...owner, grants: [] }, { configurationVersionId: configuration.id }))
    .rejects.toMatchObject({ status: 403 })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.allocate).not.toHaveBeenCalled()
})
