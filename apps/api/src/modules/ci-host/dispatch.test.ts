import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { ciMessages, releaseCiDispatch, saveQueuedCiRun } from './dispatch.js'

it.each([{}, { providerMessage: null, messageHistory: [] }])(
  'preserves optional message fields when the provider has no new message: %j',
  metadata => {
    const run = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId: randomUUID(), groupId: randomUUID(),
      suite: 'lint', commit: 'a'.repeat(40), repository: 'example/project',
      partition: null, state: 'running', computer: null, step: 'lint',
      exitCode: null, message: null, queuedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null,
      initiator: { principalId: randomUUID(), executionId: null },
      ...metadata,
    })

    expect({ ...run, ...ciMessages(run, null) }).toEqual(run)
  },
)

it('leaves an unchanged queued ticket alone when saving or requeueing it again', async () => {
  const run = CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: 'workspace', groupId: randomUUID(),
    suite: 'build', repository: 'example/project', commit: 'a'.repeat(40), partition: null,
    state: 'queued', computer: null, step: null, exitCode: null,
    message: 'Waiting for an eligible computer', queuedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, initiator: { principalId: 'operator', executionId: null },
  })
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const pool = { query } as unknown as pg.Pool

  await expect(saveQueuedCiRun(pool, run, structuredClone(run))).resolves.toBe(false)
  await expect(releaseCiDispatch(pool, run, {
    key: 'fixture:builder', label: 'Build executor', priority: 0,
    hostRef: { kind: 'main', mainId: 'fixture-main' },
  }, run.message!)).resolves.toBe(false)
  expect(query).not.toHaveBeenCalled()
})
