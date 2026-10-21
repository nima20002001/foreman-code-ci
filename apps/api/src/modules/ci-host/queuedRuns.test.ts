import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { readCiGateReservation } from './queuedRuns.js'

function gate(id: string, groupId: string, state: CiRunRecord['state'] = 'queued') {
  return CiRunRecordSchema.parse({
    id, groupId, workspaceId: 'workspace', suite: 'integration', part: null, scope: 'full',
    files: [], partition: null, repository: 'fixture/project', commit: 'a'.repeat(40),
    state, computer: null, step: null, exitCode: null, message: null, gate: true,
    plannedHostKey: 'fixture-executor', queuedAt: '2026-10-15T00:00:00.000Z',
    startedAt: null, finishedAt: null, initiator: { principalId: 'operator', executionId: null },
  })
}

it('checks failures only for live gate groups without hydrating historical failed records', async () => {
  const doomed = gate('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
  const ready = gate('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444')
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [doomed, ready].map(record => ({ record, created_at: new Date(record.queuedAt) })) })
    .mockResolvedValueOnce({ rows: [{ group_id: doomed.groupId }] })
  const result = await readCiGateReservation({ query } as unknown as pg.Pool)
  expect(result.gate).toEqual(ready)
  expect([...result.reservedHosts]).toEqual(['fixture-executor'])
  expect(query.mock.calls[1]?.[1]).toEqual([[doomed.groupId, ready.groupId]])
})

it('does not query failed gate history when no live gates remain', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  expect(await readCiGateReservation({ query } as unknown as pg.Pool))
    .toEqual({ gate: undefined, reservedHosts: new Set() })
  expect(query).toHaveBeenCalledTimes(1)
})

it.each(['running', 'starting', 'passed'] as const)(
  'keeps an admitted gate with a %s part ahead of an earlier-prepared gate', async state => {
    const preparing = deferred()
    const release = deferred()
    const earlier = gate('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    const owner = gate('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', state)
    owner.queuedAt = '2026-10-15T00:00:01.000Z'
    const sibling = { ...owner, id: '55555555-5555-4555-8555-555555555555', state: 'queued' as const }
    const rows = [{ record: owner, created_at: new Date('2026-10-15T00:00:02.000Z') },
      { record: sibling, created_at: new Date('2026-10-15T00:00:02.000Z') }]
    const admission = (async () => {
      preparing.resolve()
      await release.promise
      rows.unshift({ record: earlier, created_at: new Date('2026-10-15T00:00:03.000Z') })
    })()
    const query = vi.fn().mockImplementationOnce(async () => ({ rows })).mockResolvedValueOnce({ rows: [] })
    const pool = { query } as unknown as pg.Pool
    await preparing.promise
    release.resolve()
    await admission
    const reserved = await readCiGateReservation(pool)
    expect(reserved.gate?.groupId).toBe(owner.groupId)
    expect(reserved.gate?.state).not.toBe('passed')
    expect([...reserved.reservedHosts]).toEqual(['fixture-executor'])
  })

it('selects the next queued gate by persisted admission order rather than preparation time', async () => {
  const earlier = gate('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
  const admitted = gate('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444')
  admitted.queuedAt = '2026-10-15T00:00:01.000Z'
  const query = vi.fn().mockResolvedValueOnce({ rows: [
    { record: earlier, created_at: new Date('2026-10-15T00:00:03.000Z') },
    { record: admitted, created_at: new Date('2026-10-15T00:00:02.000Z') },
  ] }).mockResolvedValueOnce({ rows: [] })
  expect((await readCiGateReservation({ query } as unknown as pg.Pool)).gate).toEqual(admitted)
})
