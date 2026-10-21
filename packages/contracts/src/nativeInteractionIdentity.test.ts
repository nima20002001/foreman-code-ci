import { expect, it } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, PendingNativeInteractionSchema } from './index.js'

it('accepts Codex session elicitations without a turn and retains turn requirements for other methods', () => {
  const pending = { session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session' },
    turn: { nativeRequestId: 'request' }, nativeRequestType: 'mcpServer/elicitation/request',
    request: { threadId: 'session', turnId: null }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
  expect(PendingNativeInteractionSchema.parse(pending).turn).toEqual({ nativeRequestId: 'request' })
  expect(PendingNativeInteractionSchema.safeParse({ ...pending, turn: {} }).success).toBe(false)
  expect(PendingNativeInteractionSchema.safeParse({ ...pending,
    nativeRequestType: 'item/tool/requestUserInput' }).success).toBe(false)
  expect(PendingNativeInteractionSchema.safeParse({ ...pending,
    session: { ...pending.session, harness: 'opencode' } }).success).toBe(false)
})
