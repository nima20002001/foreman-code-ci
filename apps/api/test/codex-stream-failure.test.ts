import { describe, expect, it } from 'vitest'
import { f, manager, source, useCodexFixture } from './codex-app-server.test-support.js'
import { collect, emit, state, until } from './fixtures/codex-test-helpers.js'
import { isTransientExecutionResult } from '../src/modules/runs/executionRetryPolicy.js'

describe('Codex failed turn retry classification', () => {
  useCodexFixture({ requestTimeoutMs: 5_000 })

  it.each([
    ['stream disconnected', { responseStreamDisconnected: { httpStatusCode: null } }, true],
    ['connection failed', { httpConnectionFailed: { httpStatusCode: null } }, true],
    ['internal server error', 'internalServerError', true],
    ['context limit', 'contextWindowExceeded', false],
    ['unauthorized connection', { httpConnectionFailed: { httpStatusCode: 401 } }, false],
  ])('classifies %s from its native cause', async (_label, codexErrorInfo, retryable) => {
    const session = await manager.createSession(source)
    const events = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'stream-failure' }))
    const turn = await until(async () => (await state(f.directory, session.nativeSessionId)).turns.at(-1))
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: {
      ...turn, status: 'failed', completedAt: 2,
      error: { message: 'Native turn failed', codexErrorInfo, additionalDetails: null },
    } } })
    await events
    const result = (await manager.history(session)).terminalResult
    expect(result).toMatchObject({ outcome: 'failed', error: { message: 'Native turn failed', retryable } })
    expect(isTransientExecutionResult(result)).toBe(retryable)
  })
})
