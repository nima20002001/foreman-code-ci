import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { server } from '../../../mocks/server'
import { selectedRunChatApi, selectedRunChatPath } from './selectedRunChatClient'
import { envelope, execution, historicalState, selectedRoute } from './sch10.testSupport'

describe('historical chat read boundary', () => {
  it('requests the exact historical execution and rejects a neighboring Run', async () => {
    let url = ''
    server.use(http.get(selectedRoute, ({ request }) => { url = request.url; return HttpResponse.json(envelope(historicalState('run-a'))) }))
    const result = await selectedRunChatApi.read(execution('run-a'))
    expect(result.kind).toBe('selected')
    expect(new URL(url).searchParams.get('executionId')).toBe('execution-run-a')
    expect(new URL(url).pathname).toBe(selectedRunChatPath(execution('run-a')))
    server.use(http.get(selectedRoute, () => HttpResponse.json(envelope(historicalState('run-b')))))
    await expect(selectedRunChatApi.read(execution('run-a'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a response whose conversation belongs to another execution before exposing it', async () => {
    const response = envelope(historicalState('run-a'))
    if (response.kind !== 'selected' || !response.state.conversation || response.state.conversation.origin.kind !== 'run_execution') throw new Error('fixture')
    response.state.conversation.origin.executionId = 'different-execution'
    expect(ReadSelectedRunChatResponseSchema.safeParse(response).success).toBe(false)
    server.use(http.get(selectedRoute, () => HttpResponse.json(response)))
    await expect(selectedRunChatApi.read(execution('run-a'))).rejects.toThrow()
  })
})
