import { CiRunRecordSchema, type CiGetInput } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { ciRunReadback } from './ciRunReadback.js'
import { deferred } from './deferred.js'

it('waits for collection after a missing integration script fails before comparing persisted readback', async () => {
  let persisted = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'integration', part: null,
    partition: null, scope: 'full', files: [], repository: 'example/project', commit: 'a'.repeat(40),
    state: 'failed', collection: 'pending', computer: null, step: null, exitCode: null,
    message: 'The repository has no "integration" script for the integration suite.',
    queuedAt: '2026-10-14T00:00:00.000Z', startedAt: '2026-10-14T00:00:01.000Z',
    finishedAt: '2026-10-14T00:00:02.000Z', initiator: { principalId: 'operator', executionId: null },
  })
  const waiting = deferred()
  const collected = deferred()
  const read = async (input: CiGetInput) => {
    if (input.waitUntil === 'group-terminal') {
      waiting.resolve()
      await collected.promise
      return { run: structuredClone(persisted), wait: {
        until: 'group-terminal', status: 'settled', tickets: 1, settledTickets: 1,
      } }
    }
    return { run: structuredClone(persisted) }
  }
  const readback = ciRunReadback(read, persisted.id, 'failed')
  try {
    // Release collection when the caller starts waiting, or after an early read exposes the race.
    await Promise.race([waiting.promise, readback])
    persisted = { ...persisted, collection: 'unsupported' }
    collected.resolve()
    expect((await readback).run).toEqual(persisted)
  } finally {
    collected.resolve()
    await readback
  }
})
