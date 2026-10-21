import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { MemoryCardWorkSelection } from '@foreman-code/contracts'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

let db: Awaited<ReturnType<typeof agent3Database>>
beforeAll(async () => {
  if (!postgresEnabled) return
  db = await agent3Database()
  await withTransaction(db.pool, async tx => {
    await tx.query('create table memory_test_owner(id text primary key,record jsonb not null)')
    await tx.query('create table memory_test_facts(id text primary key,record jsonb not null)')
  })
}, 60000)
afterAll(async () => { await db?.close() })

async function fixture() {
  const owner = await new PostgresAccessService(db.pool).issue({ name: 'Memory reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workspaces:read', 'workspaces:update',
      'workflows:read', 'workflows:update'], scope: {} }] })
  const f = memoryFixture(db.pool, owner.principal)
  const boardId = (await f.snapshot()).board.id
  const selections: MemoryCardWorkSelection[] = []
  for (let index = 0; index < 24; index++) {
    const work = await f.prepareWork('accepted')
    selections.push({ kind: 'current', work: work.work })
  }
  const created = await f.service.mutate(owner.principal, { kind: 'card_create', boardId,
    card: { title: randomUUID(), body: '', status: 'todo', completionKind: null, reason: null, assignee: null, linkedNodes: [] },
    workSelections: selections })
  return { ...f, boardId, cardId: created.card!.id }
}

it.runIf(postgresEnabled)('bounds card work detail and makes every retained binding available through independent pages', async () => {
  const f = await fixture()
  const first = await f.service.read(f.principal, { boardId: f.boardId, view: 'card', cardId: f.cardId, limit: 5 })
  expect(first).toMatchObject({ bindings: expect.any(Array), bindingPage: { hasMore: true, nextCursor: expect.any(String) } })
  const detail = first as { bindings: Array<{ id: string }>; bindingPage: { nextCursor: string | null; hasMore: boolean } }
  expect(detail.bindings).toHaveLength(5)
  const ids = detail.bindings.map(binding => binding.id)
  let cursor = detail.bindingPage.nextCursor
  while (cursor) {
    const result = await f.service.read(f.principal, JSON.parse(JSON.stringify({ boardId: f.boardId,
      view: 'bindings', cardId: f.cardId, cursor, limit: 5 })))
    const page = result as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(page.items.length).toBeLessThanOrEqual(5)
    ids.push(...page.items.map(binding => binding.id))
    cursor = page.nextCursor
  }
  expect(ids).toHaveLength(24)
  expect(new Set(ids).size).toBe(24)
})

it.runIf(postgresEnabled)('reads card detail from a snapshot without waiting for an unrelated board writer', async () => {
  const f = await fixture()
  const locked = deferred()
  const release = deferred()
  const writer = f.transaction(async tx => {
    await tx.query('select id from memory_boards where id=$1 for update', [f.boardId])
    locked.resolve()
    await release.promise
  })
  try {
    await locked.promise
    const detail = await f.service.read(f.principal, { boardId: f.boardId, view: 'card', cardId: f.cardId, limit: 5 })
    expect(detail).toMatchObject({ card: { id: f.cardId } })
  } finally { release.resolve(); await writer }
})
