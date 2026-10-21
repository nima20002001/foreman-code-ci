import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunInspectionService } from '../src/modules/runs/inspection.js'
import { toolFailure } from '../src/mcp/shared/results.js'
import { databaseReadFailure } from '../src/modules/errors.js'

const reads = vi.hoisted(() => ({ current: vi.fn() }))
vi.mock('../src/modules/runs/currentRead.js', () => ({ withCurrentRunRead: reads.current }))

const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
  grants: [{ actions: ['runs:read'], scope: { runIds: ['run'] } }],
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }

beforeEach(() => reads.current.mockReset())

describe('Run inspection database failures', () => {
  it.each([
    { error: new Error('Query read timeout'), reason: 'query_read_timeout' },
    { error: Object.assign(new Error('private canceled SQL'), { code: '57014' }), reason: 'query_canceled' },
  ])('preserves the inspection contract for a shared-reader $reason', async ({ error, reason }) => {
    reads.current.mockRejectedValueOnce(databaseReadFailure(error))
    await expect(new RunInspectionService({} as pg.Pool).record(principal, {
      workspaceId: 'workspace', runId: 'run',
    })).rejects.toMatchObject({ code: 'RUN_INSPECTION_UNAVAILABLE', status: 503,
      cause: error, details: { retryable: true, reason } })
  })

  it.each([
    { error: new Error('Query read timeout'), reason: 'query_read_timeout', sqlState: undefined },
    { error: Object.assign(new Error('private canceled SQL and input'), { code: '57014' }), reason: 'query_canceled', sqlState: '57014' },
    { error: Object.assign(new Error('private locked relation'), { code: '55P03' }), reason: 'lock_timeout', sqlState: '55P03' },
    { error: Object.assign(new Error('private transaction dependency'), { code: '40P01' }), reason: 'deadlock', sqlState: '40P01' },
    { error: Object.assign(new Error('private connection URL'), { code: 'ECONNRESET' }), reason: 'connection_unavailable', sqlState: undefined },
  ])('reports $reason through the public service and MCP envelope', async ({ error, reason, sqlState }) => {
    reads.current.mockRejectedValueOnce(error)
    const service = new RunInspectionService({} as pg.Pool)
    const failure = await service.record(principal, { workspaceId: 'workspace', runId: 'run' }).catch(value => value as Error)
    expect(failure).toMatchObject({ code: 'RUN_INSPECTION_UNAVAILABLE', status: 503, cause: error,
      details: { retryable: true, reason, ...(sqlState ? { sqlState } : {}) } })
    const result = toolFailure(failure)
    expect(result.isError).toBe(true)
    expect(result).not.toHaveProperty('structuredContent')
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (!content || content.type !== 'text') throw new Error('Missing MCP error text')
    expect(JSON.parse(content.text)).toEqual({ error: { code: 'RUN_INSPECTION_UNAVAILABLE',
      message: reason === 'query_read_timeout' ? 'The Run inspection query exceeded its database read deadline.'
        : 'The Run inspection store is unavailable.', details: { retryable: true, reason, ...(sqlState ? { sqlState } : {}) } } })
    expect(content.text).not.toContain('private')
    expect(content.text).not.toContain('stack')
  })
})
