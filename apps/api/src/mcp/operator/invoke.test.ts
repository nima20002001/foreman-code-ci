import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../modules/errors.js'
import { operatorTool } from './catalog.js'
import { invokeOperatorTool } from './invoke.js'
import type { OperatorRequestContext } from './types.js'

function context() {
  const recordDenied = vi.fn().mockResolvedValue(undefined)
  return { recordDenied, request: {
    principal: { id: 'reader' }, services: { commands: { recordDenied } },
  } as unknown as OperatorRequestContext }
}

describe('Operator database read deadlines', () => {
  it.each(['run_get', 'run_events_list', 'run_activities_get_v1'] as const)(
    'returns a retryable error for %s without private database text', async name => {
      const { request } = context()
      const result = await invokeOperatorTool(request, name, async () => {
        throw Object.assign(new Error('private statement and stored payload'), { code: '57014' })
      }, operatorTool(name)!.requires[0][0])
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ error: {
        code: 'DATABASE_READ_TIMEOUT', message: 'The database read exceeded its deadline. Retry the request.',
        details: { retryable: true, reason: 'query_canceled', sqlState: '57014' },
      } }) }])
    },
  )

  it('classifies a mutation deadline without replaying the mutation', async () => {
    const { request } = context()
    const work = vi.fn(async () => {
      throw Object.assign(new Error('private statement'), { code: '57014' })
    })
    const result = await invokeOperatorTool(request, 'run_start', work, operatorTool('run_start')!.requires[0][0])
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ error: {
      code: 'DATABASE_READ_TIMEOUT', message: 'The database read exceeded its deadline. Retry the request.',
      details: { retryable: true, reason: 'query_canceled', sqlState: '57014' },
    } }) }])
    expect(work).toHaveBeenCalledOnce()
  })

  it('preserves and audits access denial', async () => {
    const { request, recordDenied } = context()
    const result = await invokeOperatorTool(request, 'run_get', async () => {
      throw new DomainError('ACCESS_DENIED', 'The Run is outside this caller’s scope.', 403)
    }, operatorTool('run_get')!.requires[0][0])
    expect(recordDenied).toHaveBeenCalledWith('reader', 'mcp', 'run_get', 'mcp:run_get')
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ error: {
      code: 'ACCESS_DENIED', message: 'The Run is outside this caller’s scope.',
    } }) }])
  })
})
