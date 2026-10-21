import { migratedDatabase } from './helpers/migratedDatabase.js'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from '@foreman-code/contracts'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'

it('pins the full cross-harness Operator configuration and preserves it on exact retries', async () => {
  const database = await migratedDatabase()
  const { pool } = database
  try {
    const principal = (await new PostgresAccessService(pool).issue({ name: 'owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })).principal
    const operators = new PostgresOperatorRepository(pool)
    const repository = new PostgresOperatorConversationRepository(pool)
    const initial = await operators.ensure()
    const conversation = await repository.create(initial.operator.id, initial.configuration, principal.id)
    const intended = { harness: 'claude' as const, model: 'review-model', effort: 'high' as const,
      authMode: 'subscription' as const, configDirectory: '/fixture/profile',
      permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
      tools: ['Read', 'Bash'], permissionRules: [{ effect: 'deny' as const, tool: 'Bash' }],
      instructions: 'Inspect without writes', mcpServers: {} }
    const defaults = new PostgresFoundationSettingsRepository(pool)
    const saved = await defaults.getAgentDefaults()
    const updated = await defaults.updateAgentDefaults({ ...saved.value, operator: { ...saved.value.operator, harness: intended } }, saved.revision)
    await operators.update(intended, (await operators.ensure()).configuration.id)
    const input = { requestId: randomUUID(), content: 'Inspect without writes', settings: operatorChatSettings(intended),
      configurationVersionId: initial.configuration.id, defaultsRevision: updated.revision }
    const harness = await repository.harnessForMessage(initial.configuration, input)
    const accepted = await repository.beginTurn(conversation.id, input, principal.id, harness, initial.configuration.id)
    const pin = accepted.state.conversation.operatorConfigurationVersionId!
    expect((await repository.configuration(pin))?.harness).toEqual(intended)
    expect(await repository.acceptedConfiguration(conversation.id, input.requestId)).toMatchObject({ id: pin, harness: intended })
    await repository.finish(conversation.id, input.requestId, { outcome: 'failed', error: { code: 'PRE_WRITE', message: 'not submitted', retryable: true } }, undefined, true)
    const current = await operators.ensure()
    await operators.update({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'changed-after-acceptance' }, current.configuration.id)
    const retry = await repository.beginTurn(conversation.id, input, principal.id)
    expect(retry.state.conversation.operatorConfigurationVersionId).toBe(pin)
    expect((await repository.configuration(pin))?.harness).toEqual(intended)
    await expect(repository.beginTurn(conversation.id, { ...input, content: 'changed' }, principal.id)).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect((await pool.query('select request_id from operator_conversation_turns')).rowCount).toBe(1)
    const reopened = new PostgresOperatorConversationRepository(pool)
    expect(await reopened.acceptedConfiguration(conversation.id, input.requestId))
      .toMatchObject({ id: pin, harness: intended })
  } finally { await database.close() }
}, 30_000)
