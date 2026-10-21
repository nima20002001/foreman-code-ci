import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryCard, MemoryNote } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { memoryBoardsMigration } from '../src/infrastructure/memoryBoardsMigration.js'
import type { BoardSnapshot, ChangesPage, Page } from '../src/modules/memory-boards/types.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'

describe.skipIf(!postgresEnabled)('Memory boards public persistence and engine ports',()=>{
  let database:Awaited<ReturnType<typeof agent3Database>>,f:ReturnType<typeof memoryFixture>,boardId:string
  const principal:ManagementPrincipal={id:'memory-test-operator',name:'Memory Operator',audience:'operator',
    grants:[{actions:['workspaces:read','workspaces:update','workflows:read','workflows:update'],scope:{}}],
    expiresAt:'9999-12-31T23:59:59.999Z',revokedAt:null}
  beforeAll(async()=>{
    database=await agent3Database()
    await withTransaction(database.pool,async tx=>{
      const present=await tx.query("select to_regclass('memory_boards') as name")
      if(!present.rows[0]?.name)await tx.query(memoryBoardsMigration.sql)
      await tx.query('create table memory_test_owner(id text primary key,record jsonb not null)')
      await tx.query('create table memory_test_facts(id text primary key,record jsonb not null)')
    })
  },60000)
  afterAll(async()=>{await database?.close()})
  beforeEach(async()=>{f=memoryFixture(database.pool,principal);boardId=(await f.snapshot()).board.id})

  it('shares one database listener across boards and service instances until the last subscriber closes', async () => {
    const workspace = await f.service.read(principal, { scope: { kind: 'workspace', workspaceId: f.workspaceId } }) as BoardSnapshot
    const checkedOut = () => database.pool.totalCount - database.pool.idleCount
    const baseline = checkedOut()
    const notices = { first: 0, second: 0, workspace: 0, disconnected: 0 }
    const disconnected = () => { notices.disconnected += 1 }
    const stops = await Promise.all([
      f.service.listen(boardId, () => { notices.first += 1 }, disconnected),
      f.restart().listen(boardId, () => { notices.second += 1 }, disconnected),
      f.service.listen(workspace.board.id, () => { notices.workspace += 1 }, disconnected),
    ])
    try {
      expect(checkedOut() - baseline).toBe(1)
      await f.create(boardId, 'Shared notification')
      await expect.poll(() => notices).toEqual({ first: 1, second: 1, workspace: 0, disconnected: 0 })
      await f.service.mutate(principal, { kind: 'note_create', boardId: workspace.board.id, text: 'Workspace note' })
      await expect.poll(() => notices).toEqual({ first: 1, second: 1, workspace: 1, disconnected: 0 })
      stops[0]!()
      await f.create(boardId, 'Remaining subscriber')
      await expect.poll(() => notices).toEqual({ first: 1, second: 2, workspace: 1, disconnected: 0 })
      expect(checkedOut() - baseline).toBe(1)
    } finally {
      for (const stop of stops) stop()
    }
    await expect.poll(checkedOut).toBe(baseline)
    const stop = await f.restart().listen(boardId, () => { notices.second += 1 }, disconnected)
    try {
      expect(checkedOut() - baseline).toBe(1)
      await f.create(boardId, 'Reopened subscription')
      await expect.poll(() => notices).toEqual({ first: 1, second: 3, workspace: 1, disconnected: 0 })
    } finally { stop() }
    await expect.poll(checkedOut).toBe(baseline)
  })

  it.each(['blocked', 'failed', 'canceled'] as const)('commits %s settlement with a bounded card reason and full binding evidence', async phase => {
    const task = await f.prepareWork()
    f.setSubject(task.subject)
    const saved = await f.service.mutate(f.worker, { kind: 'card_create', boardId,
      card: { title: 'Long failure', body: '', status: 'todo', completionKind: null, reason: null, assignee: null, linkedNodes: [] } })
    const prefix = 'x'.repeat(999)
    const reason = `${prefix}💥${'Failure detail. '.repeat(100)}`
    const fact = f.fact(task, phase, { reason })
    const receipt = await f.publish(fact)
    const detail = await f.card(boardId, saved.card!.id)
    expect(detail.card).toMatchObject({ status: 'blocked', reason: prefix })
    expect(detail.bindings).toMatchObject([{ state: phase, reason }])
    expect(await f.committedFact(fact.sourceEventKey)).toEqual(fact)
    expect(await f.publish(fact)).toEqual({ ...receipt, replayed: true })
    expect((await f.card(boardId, saved.card!.id)).card).toEqual(detail.card)
  })

  it('deduplicates normalized parallel creation including Done without changing bindings, revisions or events',async()=>{
    const [first,second]=await Promise.all([f.create(boardId,' Ｔask\tOne '),f.create(boardId,'task one')])
    expect(first.card?.id).toBe(second.card?.id)
    expect([first.outcome,second.outcome].sort()).toEqual(['created','existing'])
    const card=first.card!
    const done=await f.service.mutate(principal,{kind:'card_update',boardId,cardId:card.id,patch:{status:'done',completionKind:'completed'}})
    const before=await f.snapshot()
    expect((await f.create(boardId,'TASK ONE')).card).toEqual(done.card)
    expect((await f.snapshot()).board.revision).toBe(before.board.revision)
    expect(await f.service.changes(principal,{boardId,afterSequence:before.sequence})).toMatchObject({items:[]})
  })
  it('replays one command and preserves no-op revisions and timestamps; rejects reused different input',async()=>{
    const command={kind:'note_create' as const,boardId,commandId:randomUUID(),text:'Keep this'}
    const saved=await f.service.mutate(principal,command)
    expect(await f.restart().mutate(principal,command)).toEqual(saved)
    const same=await f.service.mutate(principal,{kind:'note_update',boardId,noteId:saved.note!.id,patch:{text:'Keep this'}})
    expect(same).toMatchObject({outcome:'unchanged',note:saved.note,boardRevision:saved.boardRevision})
    await expect(f.service.mutate(principal,{...command,text:'Different'})).rejects.toMatchObject({code:'COMMAND_INPUT_CONFLICT'})
  })
  it('merges current partial edits, reports rename collisions and durably recovers a rejected command',async()=>{
    const a=await f.create(boardId,'First'),b=await f.create(boardId,'Second')
    await f.service.mutate(principal,{kind:'card_update',boardId,cardId:a.card!.id,patch:{body:'New body'}})
    const changed=await f.service.mutate(principal,{kind:'card_update',boardId,cardId:a.card!.id,patch:{title:'Renamed'}})
    expect(changed.card?.body).toBe('New body')
    const command={kind:'card_update' as const,boardId,cardId:a.card!.id,commandId:randomUUID(),expectedRevision:0,patch:{title:'Old'}}
    await expect(f.service.mutate(principal,command)).rejects.toMatchObject({code:'REVISION_CONFLICT'})
    expect(await f.restart().read(principal,{boardId,view:'command',commandId:command.commandId})).toMatchObject({state:'rejected',error:{code:'REVISION_CONFLICT'}})
    await expect(f.service.mutate(principal,{kind:'card_update',boardId,cardId:a.card!.id,patch:{title:' SECOND '}}))
      .rejects.toMatchObject({code:'DUPLICATE_CARD_TITLE',details:{cardId:b.card!.id}})
  })
  it('keeps assignment as display only and preserves a reasoned reopen after old accepted work',async()=>{
    const task=await f.prepareWork()
    const display=await f.create(boardId,'Assigned only',{assignee:task.value.node,linkedNodes:[task.value.node]})
    expect(display.bindings).toEqual([]);expect(display.claims).toEqual([])
    const bound=await f.service.mutate(principal,{kind:'card_create',boardId,card:{title:'Bound',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]},
      workSelections:[{kind:'current',work:task.work}]})
    await f.publish(f.fact(task,'accepted'))
    const reopened=await f.service.mutate(principal,{kind:'card_update',boardId,cardId:bound.card!.id,
      patch:{status:'todo',completionKind:null,reason:'Another review is needed'}})
    expect(reopened.card?.status).toBe('todo')
    await f.publish(f.fact(task,'accepted'))
    expect((await f.card(boardId,bound.card!.id)).card.status).toBe('todo')
  })
  it('requires every exact work item, consumes Next once, and ignores later unrelated activations',async()=>{
    const a=await f.prepareWork(),b=await f.prepareWork('running',{...f.agent,workflowNodeId:'worker-b'})
    const saved=await f.service.mutate(principal,{kind:'card_create',boardId,card:{title:'Joint',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]},
      workSelections:[{kind:'current',work:a.work},{kind:'current',work:b.work}]})
    await f.publish(f.fact(a,'accepted'));expect((await f.card(boardId,saved.card!.id)).card.status).toBe('doing')
    await f.publish(f.fact(b,'accepted'));expect((await f.card(boardId,saved.card!.id)).card.status).toBe('done')
    const next=await f.service.mutate(principal,{kind:'card_create',boardId,card:{title:'Next',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]},
      workSelections:[{kind:'next_activation',node:a.value.node}]})
    const admitted=await f.prepareWork('queued')
    await f.publish(f.fact(admitted,'admitted'));await f.publish(f.fact(admitted,'launched'));await f.publish(f.fact(admitted,'accepted'))
    const later=await f.prepareWork('queued');await f.publish(f.fact(later,'admitted'));await f.publish(f.fact(later,'launched'))
    expect(await f.card(boardId,next.card!.id)).toMatchObject({card:{status:'done'},claims:[{state:'consumed',consumedBy:admitted.work}]})
  })
  it.each(['queued','running','awaiting_acceptance','waiting_children','blocked'] as const)('rejects Done and Drop while required work is %s',async state=>{
    const task=await f.prepareWork(state)
    const saved=await f.service.mutate(principal,{kind:'card_create',boardId,card:{title:'Active',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]},workSelections:[{kind:'current',work:task.work}]})
    for(const completionKind of ['completed','dropped'] as const)await expect(f.service.mutate(principal,{kind:'card_update',boardId,cardId:saved.card!.id,
      patch:{status:'done',completionKind,reason:'Requested close'}})).rejects.toMatchObject({code:'ACTIVE_WORK_UNRESOLVED'})
  })
  it.each(['failed','canceled'] as const)('rolls back and replays atomic %s facts, retains evidence when explicitly dropped',async phase=>{
    const task=await f.prepareWork();f.setSubject(task.subject)
    const saved=await f.service.mutate(f.worker,{kind:'card_create',boardId,card:{title:'Work',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}})
    const fact=f.fact(task,phase)
    await expect(f.publish(fact,true)).rejects.toThrow('Simulated owner transaction failure')
    expect(await f.committedFact(fact.sourceEventKey)).toBeUndefined();expect((await f.card(boardId,saved.card!.id)).card.status).toBe('doing')
    const applied=await f.publish(fact),replay=await f.publish(fact)
    expect(replay).toEqual({...applied,replayed:true})
    const dropped=await f.service.mutate(principal,{kind:'card_update',boardId,cardId:saved.card!.id,patch:{status:'done',completionKind:'dropped',reason:'No longer needed'}})
    expect(dropped.bindings[0]).toMatchObject({state:phase,resolution:{kind:'dropped',reason:'No longer needed'}})
  })
  it('keeps parent waiting Doing and transfers verified continuation lineage without a canceled state',async()=>{
    const task=await f.prepareWork();f.setSubject(task.subject)
    const saved=await f.service.mutate(f.worker,{kind:'card_create',boardId,card:{title:'Continue',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}})
    await f.publish(f.fact(task,'waiting_children',{requestGroupId:randomUUID(),outstandingRequestIds:[randomUUID()]}))
    expect((await f.card(boardId,saved.card!.id)).card.status).toBe('doing')
    const successor={...task.execution,executionId:randomUUID(),attempt:2}
    await f.publish(f.fact(task,'continuation_admitted',{execution:successor,previousExecution:task.execution,controlContinuationId:randomUUID()}))
    expect(await f.card(boardId,saved.card!.id)).toMatchObject({card:{status:'doing'},bindings:[{state:'queued',currentExecutionId:successor.executionId}]})
    await expect(f.publish(f.fact(task,'canceled'))).rejects.toMatchObject({code:'STALE_EXECUTION'})
  })
  it('transfers an ordinary child-return continuation and does not consume a fresh Next claim during technical retry',async()=>{
    const original=await f.prepareWork();f.setSubject(original.subject)
    const saved=await f.service.mutate(f.worker,{kind:'card_create',boardId,card:{title:'Parent obligation',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}})
    await f.publish(f.fact(original,'waiting_children',{requestGroupId:randomUUID(),outstandingRequestIds:[randomUUID()]}))
    const successor=await f.prepareWork('queued',f.agent,original.work)
    await f.publish(f.fact(successor,'admitted',{continuationOf:original.work}))
    expect(await f.card(boardId,saved.card!.id)).toMatchObject({card:{status:'doing'},bindings:[{work:successor.work,currentExecutionId:successor.execution.executionId,state:'queued'}]})
    await f.publish(f.fact(successor,'failed'))
    const next=await f.service.mutate(principal,{kind:'card_create',boardId,card:{title:'Future independent work',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]},
      workSelections:[{kind:'next_activation',node:successor.value.node}]})
    await f.publish(f.fact(successor,'retry_admitted'))
    expect(await f.card(boardId,next.card!.id)).toMatchObject({bindings:[],claims:[{state:'armed'}]})
  })
  it('transfers a waiting task to the launched child-return work',async()=>{
    const original=await f.prepareWork()
    f.setSubject(original.subject)
    const saved=await f.service.mutate(f.worker,{kind:'card_create',boardId,
      card:{title:'Waiting task',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}})
    await f.publish(f.fact(original,'waiting_children',{requestGroupId:randomUUID(),outstandingRequestIds:[randomUUID()]}))
    const successor=await f.prepareWork('running',f.agent,original.work)
    await f.publish(f.fact(successor,'launched',{continuationOf:original.work}))
    expect(await f.card(boardId,saved.card!.id)).toMatchObject({
      card:{status:'doing'},
      bindings:[{work:successor.work,currentExecutionId:successor.execution.executionId,state:'running'}],
    })
    await f.publish(f.fact(successor,'accepted'))
    expect((await f.card(boardId,saved.card!.id)).card.status).toBe('done')
  })
  it('records a never-launched preparation failure atomically without fabricated Doing history',async()=>{
    const task=await f.prepareWork('queued')
    const saved=await f.service.mutate(principal,{kind:'card_create',boardId,card:{title:'Preparation',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]},workSelections:[{kind:'current',work:task.work}]})
    const failure=f.fact(task,'failed',{reason:'Working directory preparation failed'})
    await expect(f.publish(failure,true)).rejects.toThrow('Simulated owner transaction failure')
    expect((await f.card(boardId,saved.card!.id)).card.status).toBe('todo')
    await f.publish(failure)
    const detail=await f.card(boardId,saved.card!.id)
    expect(detail.card).toMatchObject({status:'blocked',reason:'Working directory preparation failed'})
    expect(detail.history.items.some(change=>change.changes?.status?.after==='doing')).toBe(false)
  })
  it('clears an engine blocker on acceptance but preserves a human blocker through retry and acceptance',async()=>{
    const task=await f.prepareWork();f.setSubject(task.subject)
    const saved=await f.service.mutate(f.worker,{kind:'card_create',boardId,card:{title:'Blocker',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}})
    await f.publish(f.fact(task,'blocked'));await f.publish(f.fact(task,'accepted'))
    expect((await f.card(boardId,saved.card!.id)).card.status).toBe('done')
    const again=await f.prepareWork();f.setSubject(again.subject)
    const manual=await f.service.mutate(f.worker,{kind:'card_create',boardId,card:{title:'Manual blocker',body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}})
    await f.publish(f.fact(again,'failed'))
    await f.service.mutate(principal,{kind:'card_update',boardId,cardId:manual.card!.id,patch:{reason:'Waiting for user decision'}})
    await f.publish(f.fact(again,'retry_admitted'));await f.publish(f.fact(again,'launched'));await f.publish(f.fact(again,'accepted'))
    expect((await f.card(boardId,manual.card!.id)).card).toMatchObject({status:'blocked',reason:'Waiting for user decision'})
  })
  it('publishes model effects and owner facts atomically, then accepts without applying the model delta twice',async()=>{
    const task=await f.prepareWork(),sourceEventKey=randomUUID()
    const input={subject:task.subject,execution:task.execution,work:task.work,sourceEventKey,result:{kind:'changes' as const,
      operations:[{kind:'note_create' as const,boardId,text:'A committed result note'}]}}
    await expect(f.transaction(async tx=>{await f.service.applyResultLocked(tx,input);throw new Error('Owner failed')})).rejects.toThrow('Owner failed')
    expect((await f.snapshot()).notes.items).toEqual([])
    const receipt=await f.transaction(tx=>f.service.applyResultLocked(tx,input))
    expect(await f.transaction(tx=>f.service.applyResultLocked(tx,input))).toEqual({...receipt,replayed:true})
    await f.publish(f.fact(task,'accepted'))
    expect((await f.snapshot()).notes.items).toHaveLength(1)
  })
  it('rejects a whole invalid result batch and denies no-access/read-only result writes',async()=>{
    const task=await f.prepareWork(),input={subject:task.subject,execution:task.execution,work:task.work,sourceEventKey:randomUUID(),result:{kind:'changes' as const,
      operations:[{kind:'note_create' as const,boardId,text:'Must roll back'},{kind:'note_update' as const,boardId,noteId:randomUUID(),patch:{text:'Missing'}}]}}
    await expect(f.transaction(tx=>f.service.applyResultLocked(tx,input))).rejects.toMatchObject({code:'NOT_FOUND'})
    expect((await f.snapshot()).notes.items).toEqual([])
    f.permissions.readOnly=true
    await expect(f.transaction(tx=>f.service.applyResultLocked(tx,{...input,result:{kind:'changes',operations:[input.result.operations[0]!]}})))
      .rejects.toMatchObject({code:'ACCESS_DENIED'})
    f.permissions.tools=[]
    expect(await f.readFreeService().readDigest({subject:task.subject})).toEqual({text:'',cardIds:[],byteLength:0,omittedCount:0})
  })
  it('reconciles an immediate command from a custom write-only tool subset',async()=>{
    const task=await f.prepareWork();f.setSubject(task.subject);f.permissions.tools=['memory_note_create']
    const saved=await f.service.mutate(f.worker,{kind:'note_create',boardId,text:'Already recorded'})
    const receipt=await f.transaction(tx=>f.service.applyResultLocked(tx,{subject:task.subject,work:task.work,
      execution:task.execution,sourceEventKey:randomUUID(),result:{kind:'none',reason:'already_recorded',appliedCommandIds:[saved.commandId]}}))
    expect(receipt.commandIds).toEqual([saved.commandId])
    expect((await f.snapshot()).notes.items).toHaveLength(1)
  })
  it('pages independent open columns, Done outcomes and literal prefixes while notes archive and restore retain identity',async()=>{
    for(let index=0;index<23;index+=1)await f.create(boardId,`Todo ${index.toString().padStart(2,'0')}`)
    for(let index=0;index<9;index+=1)await f.create(boardId,`Done% ${index.toString().padStart(2,'0')}`,{status:'done',completionKind:index%2?'dropped':'completed',reason:'Done explicitly'})
    const snapshot=await f.snapshot()
    expect(snapshot.openColumns.find(column=>column.status==='todo')).toMatchObject({hasMore:true,items:expect.any(Array)})
    expect(snapshot.openColumns.flatMap(column=>column.items)).toHaveLength(20)
    const first=await f.service.read(principal,{boardId,view:'cards',status:'done',completionKind:'completed',query:'Done%',limit:2}) as Page<MemoryCard>
    const second=await f.service.read(principal,{boardId,view:'cards',status:'done',completionKind:'completed',query:'Done%',limit:2,cursor:first.nextCursor!}) as Page<MemoryCard>
    expect(new Set([...first.items,...second.items].map(card=>card.id)).size).toBe(4)
    expect(first.items.map(card=>card.title)).toEqual(['Done% 00','Done% 02'])
    const note=await f.service.mutate(principal,{kind:'note_create',boardId,text:'Pinned'})
    await f.service.mutate(principal,{kind:'note_archive',boardId,noteId:note.note!.id,archived:true})
    expect((await f.snapshot()).notes.items).toEqual([])
    await f.service.mutate(principal,{kind:'note_archive',boardId,noteId:note.note!.id,archived:false})
    const page=await f.service.read(principal,{boardId,view:'notes'}) as Page<MemoryNote>
    expect(page.items[0]?.id).toBe(note.note!.id)
    await expect(f.service.read(principal,{boardId,view:'cards',status:'done',completionKind:'completed',query:'Done%',cursor:first.nextCursor!}))
      .rejects.toMatchObject({code:'CURSOR_STALE'})
  })
  it('keeps workspace and workflow boards separate and bounds Unicode digest bytes and cards',async()=>{
    const task=await f.prepareWork();f.setSubject(task.subject)
    for(let index=0;index<25;index+=1)await f.service.mutate(f.worker,{kind:'card_create',boardId,card:{title:`Task ${index}`,body:'',status:'todo',completionKind:null,reason:null,
      assignee:task.value.node,linkedNodes:[]}})
    for(let index=0;index<3;index+=1)await f.service.mutate(principal,{kind:'note_create',boardId,text:'ی'.repeat(3900)})
    const digest=await f.service.readDigest({subject:task.subject})
    expect(digest.cardIds.length).toBeLessThanOrEqual(20);expect(Buffer.byteLength(digest.text)).toBe(digest.byteLength)
    expect(digest.byteLength).toBeLessThanOrEqual(12288);expect(digest.omittedCount).toBeGreaterThanOrEqual(5)
    const workspace=await f.service.read(principal,{scope:{kind:'workspace',workspaceId:f.workspaceId}}) as BoardSnapshot
    expect(workspace.openColumns.flatMap(column=>column.items)).toEqual([])
    const changes=await f.service.changes(principal,{boardId,afterSequence:999999}) as ChangesPage
    expect(changes.resetRequired).toBe(true)
  })
  it('keeps Worker identity exact, includes an Orchestrator branch and exposes a workflow-wide blocker to Master',async()=>{
    const worker=await f.prepareWork()
    const orchestrator=await f.prepareWork('running',{...f.agent,workflowNodeId:'branch',agentId:randomUUID(),productRole:'orchestrator'})
    const master=await f.prepareWork('running',{...f.agent,workflowNodeId:'master',agentId:randomUUID(),productRole:'master'})
    const own=await f.create(boardId,'Worker task',{assignee:worker.value.node})
    const branch=await f.create(boardId,'Branch coordination',{assignee:orchestrator.value.node})
    const replaced=await f.create(boardId,'Different saved agent',{assignee:{...worker.value.node,agentId:randomUUID()}})
    const blocker=await f.create(boardId,'Workflow-wide blocker',{status:'blocked',reason:'A shared decision is needed'})
    const workerDigest=await f.service.readDigest({subject:worker.subject})
    expect(workerDigest.cardIds).toContain(own.card!.id)
    expect(workerDigest.cardIds).not.toContain(replaced.card!.id)
    expect(workerDigest.cardIds).not.toContain(blocker.card!.id)
    const branchDigest=await f.service.readDigest({subject:orchestrator.subject})
    expect(branchDigest.cardIds).toContain(own.card!.id)
    expect(branchDigest.cardIds).toContain(branch.card!.id)
    expect(branchDigest.cardIds).not.toContain(blocker.card!.id)
    const masterDigest=await f.service.readDigest({subject:master.subject})
    expect(masterDigest.cardIds).toContain(blocker.card!.id)
    expect(masterDigest.text).toContain('A shared decision is needed')
  })
  it('applies the canonical active-note ceiling to the final batch state and keeps no-ops usable at capacity',async()=>{
    const task=await f.prepareWork()
    for(let offset=0;offset<1000;offset+=32){
      const operations=Array.from({length:Math.min(32,1000-offset)},(_,index)=>({kind:'note_create' as const,boardId,text:`Capacity note ${offset+index}`}))
      await f.transaction(tx=>f.service.applyResultLocked(tx,{subject:task.subject,execution:task.execution,work:task.work,
        sourceEventKey:randomUUID(),result:{kind:'changes',operations}}))
    }
    const full=await f.snapshot(),first=full.notes.items[0]!
    expect(full.counts.notes).toBe(1000)
    const unchanged=await f.service.mutate(principal,{kind:'note_update',boardId,noteId:first.id,patch:{text:first.text}})
    expect(unchanged.outcome).toBe('unchanged')
    expect(unchanged.boardRevision).toBe(full.board.revision)
    await expect(f.service.mutate(principal,{kind:'note_create',boardId,text:'Must not overflow'})).rejects.toMatchObject({code:'MEMORY_BOARD_CAPACITY'})
    expect((await f.snapshot()).counts.notes).toBe(1000)
    await f.transaction(tx=>f.service.applyResultLocked(tx,{subject:task.subject,execution:task.execution,work:task.work,
      sourceEventKey:randomUUID(),result:{kind:'changes',operations:[
        {kind:'note_create',boardId,text:'Replacement note'},
        {kind:'note_archive',boardId,noteId:first.id,archived:true},
      ]}}))
    expect((await f.snapshot()).counts.notes).toBe(1000)
    const archived=await f.service.read(principal,{boardId,view:'notes',archived:true}) as Page<MemoryNote>
    expect(archived.items.map(note=>note.id)).toContain(first.id)
  },60000)
})
