import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentNodeRef, MemoryCard, MemoryCardWorkSelection } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { MemoryBoardService } from '../src/modules/memory-boards/service.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'
import type { BoardSnapshot } from '../src/modules/memory-boards/types.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Memory board digest selection', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let fixture: ReturnType<typeof memoryFixture>
  let service: MemoryBoardService
  let boardId: string
  let clock: number
  const principal: ManagementPrincipal = {
    id: 'digest-operator', name: 'Digest Operator', audience: 'operator',
    grants: [{ actions: ['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update'], scope: {} }],
    expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null,
  }

  beforeAll(async () => {
    database = await agent3Database()
    await withTransaction(database.pool, async tx => {
      await tx.query('create table memory_test_owner(id text primary key,record jsonb not null)')
      await tx.query('create table memory_test_facts(id text primary key,record jsonb not null)')
    })
  }, 60000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    fixture = memoryFixture(database.pool, principal)
    clock = Date.parse('2026-10-21T00:00:00.000Z')
    service = new MemoryBoardService({
      authority: fixture.authority, transaction: fixture.transaction, readTransaction: fixture.transaction,
      listen: async () => () => undefined, now: () => new Date(clock),
    })
    boardId = (await fixture.snapshot()).board.id
  })

  async function create(title: string, fields: Partial<MemoryCard> = {}, targetBoard = boardId): Promise<MemoryCard> {
    clock += 1000
    const result = await service.mutate(principal, { kind: 'card_create', boardId: targetBoard,
      card: { title, body: '', status: 'todo', completionKind: null, reason: null,
        assignee: null, linkedNodes: [], ...fields } })
    return result.card!
  }
  async function patch(card: MemoryCard, fields: Partial<MemoryCard>, workSelections?: MemoryCardWorkSelection[]) {
    clock += 1000
    return service.mutate(principal, { kind: 'card_update', boardId: card.boardId, cardId: card.id, patch: fields,
      ...(workSelections ? { workSelections } : {}) })
  }
  async function master() {
    return fixture.prepareWork('running', { ...fixture.agent, workflowNodeId: 'master', productRole: 'master' })
  }

  it('prioritizes linked and assigned cards across scopes, then workflow blockers, then recent work', async () => {
    const task = await master()
    const workspace = await service.read(principal, {
      scope: { kind: 'workspace', workspaceId: fixture.workspaceId },
    }) as BoardSnapshot
    const linked = await create('Linked', { assignee: task.value.node, linkedNodes: [task.value.node] })
    const assigned = await create('Assigned', { assignee: task.value.node })
    const workspaceLinked = await create('Workspace linked', { linkedNodes: [task.value.node] }, workspace.board.id)
    const blocker = await create('Blocked', { status: 'blocked', reason: 'Needs a decision' })
    const newerBlocker = await create('Newer blocker', { status: 'blocked', reason: 'Needs input' })
    const recent = await create('Recent')
    const newest = await create('Newest')
    await create('Unrelated workspace task', {}, workspace.board.id)
    await create('Finished linked task', { linkedNodes: [task.value.node], status: 'done', completionKind: 'completed' })

    const digest = await service.readDigest({ subject: task.subject })
    expect(digest.cardIds).toEqual([workspaceLinked.id, assigned.id, linked.id,
      newerBlocker.id, blocker.id, newest.id, recent.id])
    expect(digest.omittedCount).toBe(1)
  })

  it('fills the twenty-card budget in priority order without duplicate candidates crowding out recent work', async () => {
    const task = await master()
    const older = await create('Assigned blocker', { assignee: task.value.node, linkedNodes: [task.value.node],
      status: 'blocked', reason: 'Relevant blocker' })
    const newer = await create('Linked task', { linkedNodes: [task.value.node] })
    const blockers: MemoryCard[] = []
    const recent: MemoryCard[] = []
    for (let index = 0; index < 8; index += 1) {
      blockers.push(await create(`Blocker ${index}`, { status: 'blocked', reason: 'Needs input' }))
    }
    for (let index = 0; index < 30; index += 1) recent.push(await create(`Recent ${index}`))

    const digest = await service.readDigest({ subject: task.subject })
    expect(digest.cardIds).toEqual([newer.id, older.id, ...blockers.reverse().map(card => card.id),
      ...recent.reverse().slice(0, 10).map(card => card.id)])
    expect(new Set(digest.cardIds).size).toBe(20)
    expect(digest.omittedCount).toBe(20)
  })

  it('preserves exact Worker identity and deduplicates cards linked to multiple Orchestrator branch nodes', async () => {
    const worker = await fixture.prepareWork()
    const orchestrator = await fixture.prepareWork('running', {
      ...fixture.agent, workflowNodeId: 'branch', agentId: randomUUID(), productRole: 'orchestrator',
    })
    const replacement: AgentNodeRef = { ...worker.value.node, agentId: randomUUID() }
    const own = await create('Worker assignment', { assignee: worker.value.node })
    const linked = await create('Worker link', { assignee: replacement, linkedNodes: [worker.value.node] })
    const otherAgent = await create('Replacement assignment', { assignee: replacement })
    const branch = await create('Shared branch task', { assignee: orchestrator.value.node,
      linkedNodes: [worker.value.node, replacement, orchestrator.value.node] })
    await create('Unrelated blocker', { status: 'blocked', reason: 'Outside the branch' })

    expect((await service.readDigest({ subject: worker.subject })).cardIds).toEqual([branch.id, linked.id, own.id])
    expect((await service.readDigest({ subject: orchestrator.subject })).cardIds)
      .toEqual([branch.id, otherAgent.id, linked.id, own.id])
  })

  it('keeps digest membership current through edits, reopening, transaction rollback and engine completion', async () => {
    const worker = await fixture.prepareWork()
    const other = await fixture.prepareWork('running', {
      ...fixture.agent, workflowNodeId: 'other', agentId: randomUUID(),
    })
    const card = await create('Changing assignment', { assignee: worker.value.node })
    const digest = (subject: typeof worker.subject) => service.readDigest({ subject })
    expect((await digest(worker.subject)).cardIds).toEqual([card.id])
    expect((await digest(other.subject)).cardIds).toEqual([])

    await patch(card, { assignee: other.value.node })
    expect((await digest(worker.subject)).cardIds).toEqual([])
    expect((await digest(other.subject)).cardIds).toEqual([card.id])
    await patch(card, { linkedNodes: [worker.value.node] })
    expect((await digest(worker.subject)).cardIds).toEqual([card.id])
    await patch(card, { status: 'done', completionKind: 'completed' })
    expect((await digest(worker.subject)).cardIds).toEqual([])
    expect((await digest(other.subject)).cardIds).toEqual([])
    await patch(card, { status: 'todo', completionKind: null, reason: 'Another review' })

    await expect(fixture.transaction(tx => service.applyResultLocked(tx, {
      subject: worker.subject, execution: worker.execution, work: worker.work, sourceEventKey: randomUUID(),
      result: { kind: 'changes', operations: [
        { kind: 'card_update', boardId, cardId: card.id, patch: { assignee: worker.value.node, linkedNodes: [] } },
        { kind: 'note_update', boardId, noteId: randomUUID(), patch: { text: 'Missing note' } },
      ] },
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await digest(worker.subject)).cardIds).toEqual([card.id])
    expect((await digest(other.subject)).cardIds).toEqual([card.id])

    await patch(card, { title: card.title }, [{ kind: 'current', work: worker.work }])
    await fixture.publish(fixture.fact(worker, 'accepted'))
    expect((await digest(worker.subject)).cardIds).toEqual([])
    expect((await digest(other.subject)).cardIds).toEqual([])
  })
})
