import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'
import { BrowserAuthority } from '../src/modules/collaboration/browserAuthority.js'
import { createBrowserProfileRepository } from '../src/modules/browser-profiles/repository.js'
import { CurrentWorkflowAuthoring } from '../src/modules/workflows/currentAuthoring.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

it('refreshes conversation browser pins only when a turn accepts a later saved version', async () => {
  const f = await conversationDeliveryFixture()
  try {
    const writer = await f.access.issue({ name: 'Browser settings writer', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
    const authoring = new CurrentWorkflowAuthoring(f.database.pool, new PostgresCommandCoordinator(f.database.pool))
    const saveProfile = async (profileId: string) => {
      const current = await authoring.read(writer.principal, f.scope)
      const saved = await authoring.save(writer.principal, 'mcp', { ...f.scope, commandId: randomUUID(),
        executionSemanticsVersion: 3, expectedRevision: current.revision,
        expectedWorkflowVersionId: current.version.id,
        expectedAgentConfigurationVersionIds: current.version.agentConfigurationVersionIds,
        graph: { ...current.version.definition, nodes: current.version.definition.nodes.map(node => ({
          ...node, browser: { enabled: true, profileId },
        })) },
      })
      return saved.value.version
    }
    const first = await saveProfile('first-profile')
    const state = await f.agent.ensureConversation(f.owner, { workspaceId: f.scope.workspaceId, ...f.query })
    const conversationId = state.conversation!.id
    const send = async (requestId: string) => {
      await f.agent.send(f.owner, f.scope.workspaceId, { requestId, content: 'Use the saved browser',
        intent: 'next_turn', context: f.query, expectedConversationId: conversationId })
      await vi.waitFor(async () => expect((await f.agentRepository.turn(conversationId, requestId))?.delivery).toBe('completed'))
    }
    await send('first-browser-turn')
    const authority = new BrowserAuthority(f.database.pool, () => 'computer',
      () => createBrowserProfileRepository(f.database.pool), async () => true)
    const subject = (await authority.conversation(conversationId)).context.subject
    expect(await authority.details(subject)).toMatchObject({ active: true, workflowVersionId: first.id,
      browser: { enabled: true, profileId: 'first-profile' } })
    await expect(authority.assertCurrent(subject, { profileId: 'first-profile' })).resolves.toBeUndefined()
    const second = await saveProfile('second-profile')
    expect(second.id).not.toBe(first.id)
    expect(await authority.details(subject)).toMatchObject({ active: true, workflowVersionId: first.id,
      browser: { profileId: 'first-profile' } })
    await expect(authority.assertCurrent(subject, { profileId: 'first-profile' })).resolves.toBeUndefined()
    await send('second-browser-turn')
    expect((await authority.conversation(conversationId)).context.subject).toEqual(subject)
    expect(await authority.details(subject)).toMatchObject({ active: true, workflowVersionId: second.id,
      browser: { enabled: true, profileId: 'second-profile' } })
    await expect(authority.resolve(subject)).resolves.toMatchObject({ browser: { profileId: 'second-profile' } })
    await expect(authority.assertCurrent(subject, { profileId: 'first-profile' }))
      .rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
    await expect(authority.assertCurrent(subject, { profileId: 'second-profile' })).resolves.toBeUndefined()
    await expect(authority.assertCurrent(subject)).resolves.toBeUndefined()
  } finally { await f.close() }
})
