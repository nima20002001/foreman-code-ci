import { operatorChatSettings, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { registerOperatorChatFixture, type OperatorChatFixture, claudeConfiguration, waitFor } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL

let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let owner: OperatorChatFixture['owner']
let operators: OperatorChatFixture['operators']
let repository: OperatorChatFixture['repository']
let manager: OperatorChatFixture['manager']
let chat: OperatorChatFixture['chat']

registerOperatorChatFixture(fixture => {
  ({ pool, access, owner, operators, repository, manager, chat } = fixture)
}, () => chat)

describe.skipIf(!connectionString)('Operator chat persistence and native binding with stubbed authority', () => {
  it('accepts next-message settings atomically, resumes the same harness, and binds retries to those settings', async () => {
    const conversation = await chat.create(owner)
    const first = { requestId: 'settings-first', content: 'First message', settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex) }
    await chat.send(conversation.id, first, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const before = await repository.active(conversation.id)
    const originalHarness = (await repository.configuration(before!.operator_configuration_version_id))!.harness
    const settings = { ...first.settings, harness: 'codex' as const, model: 'gpt-5.4', reasoningEffort: 'high' as const, serviceTier: 'priority' as const, showThinking: true }
    const next = { requestId: 'settings-second', content: 'Second message', settings }
    await chat.send(conversation.id, next, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const state = await chat.get(conversation.id, owner)
    expect(state.settings).toEqual(settings)
    const after = await repository.active(conversation.id)
    expect(after?.native_session_id).toBe(before?.native_session_id)
    expect(after?.operator_configuration_version_id).not.toBe(before?.operator_configuration_version_id)
    expect(manager.attachments).toBeGreaterThan(0)
    const configured = await repository.configuration(after!.operator_configuration_version_id)
    expect(configured?.harness).toMatchObject({ ...originalHarness, model: 'gpt-5.4', reasoningEffort: 'high', serviceTier: 'priority' })
    expect((await chat.send(conversation.id, next, owner)).replayed).toBe(true)
    await expect(chat.send(conversation.id, { ...next, settings: { ...settings, reasoningEffort: 'low' } }, owner)).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('does not change settings or interrupt a running turn', async () => {
    const conversation = await chat.create(owner)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'busy', content: 'Work' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    const before = await repository.active(conversation.id)
    await expect(chat.send(conversation.id, { requestId: 'blocked-settings', content: 'Next',
      settings: { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), model: 'other-model' } }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    expect((await repository.active(conversation.id))?.operator_configuration_version_id).toBe(before?.operator_configuration_version_id)
    expect(manager.disposals).toBe(0)
    manager.finish(nativeCorrelation(conversation.id, 'busy'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  })

  it('pins existing conversations while defaults advance the shared Operator configuration', async () => {
    const before = await chat.create(owner, 'Before defaults change')
    const settings = new PostgresFoundationSettingsRepository(pool)
    const service = new FoundationSettingsManagementService(
      settings,
      new PostgresCommandCoordinator(pool),
      { qualifyConfiguration: async () => ({} as never) },
      operators,
    )
    const current = await settings.getAgentDefaults()
    await service.updateAgentDefaults(owner, 'http', {
      commandId: 'change-operator-harness', expectedRevision: current.revision,
      value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: claudeConfiguration } },
    })
    const after = await chat.create(owner, 'After defaults change')
    expect(after.operatorConfigurationVersionId).not.toBe(before.operatorConfigurationVersionId)
    expect((await repository.configuration(before.operatorConfigurationVersionId!))?.harness.harness).toBe('codex')
    expect((await repository.configuration(after.operatorConfigurationVersionId!))?.harness.harness).toBe('claude')
  })

  it('keeps empty history native-free; replay and later sends reuse one durable session with a one-slot pool', async () => {
    const conversation = await chat.create(owner)
    expect(manager.sessions).toBe(0)
    const input = { requestId: 'request-one', content: 'hello' }
    expect((await chat.send(conversation.id, input, owner)).replayed).toBe(false)
    expect((await chat.send(conversation.id, input, owner)).replayed).toBe(true)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    await chat.send(conversation.id, { requestId: 'request-two', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).messages.length === 4)
    expect(manager.sessions).toBe(1); expect(manager.attachments).toBe(1); expect(manager.turns).toBe(2)
    expect(manager.closes).toBe(0)
    expect(manager.disposals).toBe(2) // Disposal owns session closure and avoids racing the lifecycle lock.
    const state = await chat.get(conversation.id, owner)
    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(new Set(state.messages.map((message) => message.id)).size).toBe(4)
    expect(state.conversation.title).toBe('hello')
    expect(Date.parse(state.conversation.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(conversation.createdAt!))
  })

  it('rejects changed payload reuse rather than silently replaying old content', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'same-key', content: 'original', context: { route: '/a' } }, owner)
    await expect(chat.send(conversation.id, { requestId: 'same-key', content: 'changed', context: { route: '/a' } }, owner))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    await expect(chat.send(conversation.id, { requestId: 'same-key', content: 'original', context: { route: '/b' } }, owner))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('keeps cancel(false) fenced and makes a failed cancel retryable; a stale cancel cannot clear a new request', async () => {
    manager.autoFinish = false; manager.cancelAcknowledged = false
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'slow-turn', content: 'wait' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await chat.cancel(conversation.id, 'slow-turn', owner)
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('slow-turn')
    const cancellationReceipt = async () => (await pool.query(`select command_id,target_key,input_hash,result from management_command_receipts
      where principal_id=$1 and operation='operator_chat_control' and target_key=$2 order by command_id`, [owner.id, conversation.id])).rows
    const originalCancellation = await cancellationReceipt()
    expect(originalCancellation).toHaveLength(1)
    await expect(chat.send(conversation.id, { requestId: 'next-turn', content: 'continue' }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    manager.cancelAcknowledged = true
    await chat.cancel(conversation.id, 'slow-turn', owner)
    expect(await cancellationReceipt()).toEqual(originalCancellation)
    // This bare service fixture has no lifecycle worker. Replaying the original
    // control must not resend; drive its real persisted recovery until native
    // terminal history settles the still-fenced cancellation.
    await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
    await chat.send(conversation.id, { requestId: 'next-turn', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await chat.cancel(conversation.id, 'slow-turn', owner)
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('next-turn')
    await chat.cancel(conversation.id, 'next-turn', owner)
    expect(manager.sessions).toBe(1)
  })

  it('surfaces missing persisted native sessions without replacement and preserves known terminal errors', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'first', content: 'hello' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    manager.failAttach = true
    await chat.send(conversation.id, { requestId: 'missing', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'error')
    expect((await chat.get(conversation.id, owner)).error).toContain('SESSION_UNAVAILABLE')
    expect(manager.sessions).toBe(1); expect(manager.turns).toBe(1)
    manager.failAttach = false; manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'missing', content: 'continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    manager.finish(nativeCorrelation(conversation.id, 'missing'), {
      outcome: 'failed', error: { code: 'QUOTA', message: 'quota exhausted', retryable: false },
    })
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'error')
    const state = await chat.get(conversation.id, owner)
    expect(state.error).toBe('quota exhausted')
    expect(state.activeRequestId).toBeNull()
    expect(state.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  })

  it('does not accept ephemeral Codex configuration or expose another principal’s history', async () => {
    const current = await operators.ensure()
    const harness = DEFAULT_HARNESS_DEFAULTS.codex
    await operators.update({ ...harness, advanced: { ...harness.advanced!, sessionPersistence: 'ephemeral' } }, current.operator.currentConfigurationVersionId)
    const conversation = await chat.create(owner)
    await expect(chat.send(conversation.id, { requestId: 'ephemeral', content: 'hello' }, owner)).rejects.toThrow()
    expect((await chat.get(conversation.id, owner)).messages).toHaveLength(0)
    const other = (await access.issue({ name: 'other', audience: 'operator', grants: owner.grants, expiresAt: new Date(owner.expiresAt) })).principal
    await expect(chat.get(conversation.id, other)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    expect(await chat.list(other)).toEqual([])
    const reader = { ...owner, grants: [{ actions: ['capabilities:read' as const], scope: {} }] }
    await expect(chat.send(conversation.id, { requestId: 'read-only', content: 'hello' }, reader)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
})
