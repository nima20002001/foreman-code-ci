import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { AgentIdentity, AgentSubject, BoardLifecycleFact, LogicalWorkRef, MemoryBoardScope } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { MemoryBoardService } from '../service.js'
import { createMemoryBoardService } from '../production.js'
import type { BoardSnapshot, CardDetail, MemoryBoardAuthority, ResolvedWork, SubjectAccess } from '../types.js'
import { memoryReadTools, memoryWriteTools } from '../types.js'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../../run-graph/connection.js'
import { DomainError } from '../../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'

/** Typed fakes only for D's not-yet-composed authority/engine ports. The board,
 * transactions, rows, uniqueness, receipts and outbox use real PostgreSQL. */
export function memoryFixture(pool: pg.Pool, principal: ManagementPrincipal) {
  const workspaceId=randomUUID(),workflowId=randomUUID()
  const scope:MemoryBoardScope={kind:'workflow',workspaceId,workflowId}
  const agent:AgentIdentity={workspaceId,workflowId,workflowNodeId:'worker',agentId:randomUUID(),
    productRole:'coder',displayName:'Worker',configurationVersionId:randomUUID()}
  const permissions={tools:[...memoryReadTools,...memoryWriteTools] as string[],readOnly:false}
  const transaction=<T>(work:(tx:GraphTransactionSql)=>Promise<T>)=>withExclusiveGraphConnection(pool,connection=>connection.transaction(work))
  const findWork=async(tx:GraphTransactionSql,work:LogicalWorkRef):Promise<ResolvedWork>=>{
    const result=await tx.query<{record:ResolvedWork}>('select record from memory_test_owner where id=$1',[canonicalJson(work)])
    if(!result.rows[0])throw new DomainError('NOT_FOUND','Work is not available.',404)
    return result.rows[0].record
  }
  const access=(subject:AgentSubject):SubjectAccess=>({principalId:`agent:${subject.kind==='execution'?subject.execution.executionId:subject.kind==='conversation'?subject.conversationId:subject.binding.consultationId}`,
    subject,tools:permissions.tools,readOnly:permissions.readOnly,branchNodeIds:[agent.workflowNodeId]})
  let activeSubject:AgentSubject|undefined
  const authority:MemoryBoardAuthority={
    async caller(_tx,caller){
      if(caller.audience==='operator')return null
      if(!activeSubject)throw new DomainError('ACCESS_DENIED','No agent credential binding.',403)
      return access(activeSubject)
    },
    async subject(_tx,subject){if(subject.agent.workspaceId!==workspaceId)throw new DomainError('ACCESS_DENIED','Foreign subject.',403);return access(subject)},
    async scope(_tx,value){if(value.workspaceId!==workspaceId || value.kind==='workflow'&&value.workflowId!==workflowId)throw new DomainError('NOT_FOUND','Foreign scope.',404)},
    async node(_tx,node,value){if(node.workspaceId!==value.workspaceId || node.workflowId!==workflowId)throw new DomainError('VALIDATION_ERROR','Foreign node.',400)},
    work:findWork,
    async currentWork(tx,subject){
      if(subject.kind!=='execution')return null
      const result=await tx.query<{record:ResolvedWork}>("select record from memory_test_owner where record->>'currentExecutionId'=$1",[subject.execution.executionId])
      return result.rows[0]?.record??null
    },
    async sourcePost(){throw new DomainError('ACCESS_DENIED','No visible source post in this fixture.',403)},
    async lifecycle(tx,identity,work){const saved=await findWork(tx,work);if(saved.node.agentId!==identity.agentId)throw new DomainError('VALIDATION_ERROR','Wrong saved agent.',400)},
  }
  const service=createMemoryBoardService(pool,authority)
  const worker:ManagementPrincipal={id:randomUUID(),name:'Scoped Worker',audience:'worker',agentId:agent.agentId,
    grants:[],expiresAt:'9999-12-31T23:59:59.999Z',revokedAt:null}
  async function prepareWork(state:ResolvedWork['state']='running',identity=agent,run?:Pick<LogicalWorkRef,'runId'|'workflowVersionId'>) {
    const work:LogicalWorkRef={kind:'activation',runId:run?.runId??randomUUID(),workflowVersionId:run?.workflowVersionId??randomUUID(),activationId:randomUUID()}
    const execution={runId:work.runId,workflowVersionId:work.workflowVersionId,activationId:work.activationId,executionId:randomUUID(),attempt:1}
    const subject:AgentSubject={kind:'execution',agent:identity,execution}
    const value:ResolvedWork={node:{workspaceId,workflowId,workflowNodeId:identity.workflowNodeId,agentId:identity.agentId},work,state,isBusinessWork:true,
      currentExecutionId:execution.executionId,reason:['blocked','failed','canceled'].includes(state)?'Native work stopped':null}
    await pool.query('insert into memory_test_owner(id,record) values($1,$2)',[canonicalJson(work),value])
    return {work,execution,subject,value}
  }
  async function snapshot():Promise<BoardSnapshot>{return service.read(principal,{scope}) as Promise<BoardSnapshot>}
  async function card(boardId:string,cardId:string):Promise<CardDetail>{return service.read(principal,{boardId,view:'card',cardId}) as Promise<CardDetail>}
  async function create(boardId:string,title='Task',fields:Record<string,unknown>={}) {
    return service.mutate(principal,{kind:'card_create',boardId,commandId:randomUUID(),
      card:{title,body:'',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[],...fields}})
  }
  async function publish(fact:BoardLifecycleFact,fail=false) {
    return transaction(async tx=>{
      await tx.query('insert into memory_test_facts(id,record) values($1,$2) on conflict(id) do nothing',[fact.sourceEventKey,fact])
      const receipt=await service.applyLifecycleLocked(tx,fact)
      if(fail)throw new Error('Simulated owner transaction failure')
      return receipt
    })
  }
  const fact=(task:Awaited<ReturnType<typeof prepareWork>>,phase:BoardLifecycleFact['phase'],extra:Partial<BoardLifecycleFact>={}):BoardLifecycleFact=>({
    sourceEventKey:randomUUID(),agent:task.subject.agent,work:task.work,execution:task.execution,phase,
    outstandingRequestIds:[],reason:['failed','blocked','canceled'].includes(phase)?'Native work stopped':null,...extra,
  })
  return {service,authority,principal,worker,permissions,workspaceId,workflowId,scope,agent,transaction,prepareWork,snapshot,card,create,publish,fact,
    setSubject(subject:AgentSubject){activeSubject=subject},
    async committedFact(id:string){const result=await pool.query('select record from memory_test_facts where id=$1',[id]);return result.rows[0]?.record},
    restart:()=>createMemoryBoardService(pool,authority),
    readFreeService:()=>new MemoryBoardService({authority,transaction,
      readTransaction:work=>withExclusiveGraphConnection(pool,connection=>connection.transaction(async()=>work({
        transaction:true,query(){throw new Error('No-access digest attempted a board SQL read')},
      }))),listen:async()=>()=>undefined}),
  }
}
