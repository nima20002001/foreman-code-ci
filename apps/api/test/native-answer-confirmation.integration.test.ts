import { describe, expect, it } from 'vitest'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import type { AcceptedChatResponseControl, ChatResponseAcknowledgment } from '@foreman-code/contracts/interaction-activity'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { readActivityCommands } from '../src/modules/conversations/activityCommands.js'
import { NativeConversationControlCommands } from '../src/modules/conversations/nativeControlCommands.js'
import { responseValueDigest } from '../src/modules/interactions/delivery.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('persisted native answer confirmation', () => {
  it.each(['after_response', 'during_response'] as const)('confirms consumption %s without sending again', async timing => {
    const db = await agent3Database()
    try {
      const access = new PostgresAccessService(db.pool)
      const { principal } = await access.issue({ name: 'Answer owner', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000),
        grants: [{ actions: ['operator_chat:read', 'operator_chat:respond'], scope: {} }] })
      const state = OperatorConversationStateSchema.parse({ conversation: { id: 'chat', agentId: 'operator',
        scope: 'application', operatorConfigurationVersionId: 'configuration' }, messages: [],
        revision: 1, turnState: 'idle', activeRequestId: null })
      const control: AcceptedChatResponseControl = {
        schemaVersion: 1, kind: 'respond', conversationId: 'chat', modelRequestId: 'question-turn',
        scope: { kind: 'operator_chat', conversationId: 'chat' },
        native: { harness: 'codex', providerVersion: '0.154.0', sessionId: 'session', turnId: 'turn',
          requestId: 'question', requestType: 'item/tool/requestUserInput' },
        choice: { optionId: 'answer', semantic: 'approve_once', response: { fruit: { answers: ['Pear'] } } },
      }
      const acknowledgment: ChatResponseAcknowledgment = {
        source: 'provider_history', harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session',
        nativeRequestId: 'question', nativeRequestType: 'item/tool/requestUserInput', optionId: 'answer',
        semantic: 'approve_once', responseDigest: responseValueDigest(control.choice.response),
      }
      const commands = new NativeConversationControlCommands(db.pool, {
        operation: 'operator_chat_control', prefix: 'OPERATOR_CHAT', label: 'Operator chat',
        parse: value => OperatorConversationStateSchema.parse(value),
      })
      let sends = 0
      const confirm = (proofs: ChatResponseAcknowledgment[]) => commands.reconcileResponses('chat', 'question-turn',
        control.scope, { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session' },
        { kind: 'turn', nativeTurnId: 'turn' }, proofs, state)
      const payload = { nativeRequestId: 'question', optionId: 'answer', response: control.choice.response }
      await commands.execute(principal, 'mcp', 'chat', 'answer-control', payload, async markDispatch => {
        markDispatch()
        sends += 1
        if (timing === 'during_response') await confirm([acknowledgment])
        return state
      }, async () => state, control)
      if (timing === 'after_response') {
        expect((await readActivityCommands(db.pool, 'chat', control.scope, '1')).summaries[0])
          .toMatchObject({ answerRecorded: true, providerAcknowledged: false })
        await confirm([])
        await confirm([{ ...acknowledgment, responseDigest: responseValueDigest({}) }])
        expect((await readActivityCommands(db.pool, 'chat', control.scope, '1')).summaries[0]!.providerAcknowledged)
          .toBe(false)
        await confirm([acknowledgment])
      }
      expect((await readActivityCommands(db.pool, 'chat', control.scope, '1')).summaries[0])
        .toMatchObject({ delivery: 'delivered', providerAcknowledged: true })
      const restarted = new NativeConversationControlCommands(db.pool, {
        operation: 'operator_chat_control', prefix: 'OPERATOR_CHAT', label: 'Operator chat',
        parse: value => OperatorConversationStateSchema.parse(value),
      })
      await restarted.execute(principal, 'http', 'chat', 'answer-control', payload, async () => {
        sends += 1
        return state
      }, async () => state)
      expect(sends).toBe(1)
      const audit = (await db.pool.query(`select source,outcome,details from management_audit
        where principal_id=$1 and details->>'commandId'='answer-control'`, [principal.id])).rows
      expect(audit).toContainEqual(expect.objectContaining({ source: 'mcp', outcome: 'succeeded',
        details: expect.objectContaining({ phase: 'reconciled' }) }))
    } finally {
      await db.close()
    }
  })
})
