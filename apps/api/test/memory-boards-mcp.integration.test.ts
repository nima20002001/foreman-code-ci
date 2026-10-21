import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { memoryBoardsMigration } from '../src/infrastructure/memoryBoardsMigration.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { bearerToken, PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { registerMemoryBoardRoutes } from '../src/routes/memoryBoards.js'
import { createMemoryBoardTools } from '../src/mcp/operator/tools/memoryBoards.js'
import { stripMcpInputSchemas } from '../src/mcp/shared/inputSchemas.js'
import type { CardDetail, MutationReceipt } from '../src/modules/memory-boards/types.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'
import { memoryTestRegistry } from '../src/modules/memory-boards/testing/mcpRegistry.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Memory board HTTP and authenticated MCP parity',()=>{
  let database:Awaited<ReturnType<typeof agent3Database>>
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

  it('uses the same persisted objects in both interfaces and denies missing credentials, readers and foreign scopes',async()=>{
    const access=new PostgresAccessService(database.pool),commands=new PostgresCommandCoordinator(database.pool)
    const owner=await access.issue({name:'Memory editor',audience:'operator',expiresAt:new Date(Date.now()+600000),
      grants:[{actions:['workspaces:read','workspaces:update','workflows:read','workflows:update'],scope:{}}]})
    const f=memoryFixture(database.pool,owner.principal),boardId=(await f.snapshot()).board.id
    const reader=await access.issue({name:'Memory reader',audience:'operator',expiresAt:new Date(Date.now()+600000),
      grants:[{actions:['workflows:read'],scope:{workspaceIds:[f.workspaceId]}}]})
    const foreign=await access.issue({name:'Foreign editor',audience:'operator',expiresAt:new Date(Date.now()+600000),
      grants:[{actions:['workflows:read','workflows:update'],scope:{workspaceIds:[randomUUID()]}}]})
    const app=Fastify({logger:false}),clients:Client[]=[]
    const tools=createMemoryBoardTools(f.service)
    app.addHook('onRequest',async request=>{
      request.operatorPrincipal=await access.authenticate(bearerToken(request.headers.authorization))
      request.reauthorizeOperator=()=>access.authenticate(bearerToken(request.headers.authorization))
    })
    app.setErrorHandler((error,_request,reply)=>{
      const known=error instanceof DomainError
      const message=error instanceof Error?error.message:'Invalid request'
      return reply.code(known?error.status:400).send({error:{code:known?error.code:'VALIDATION_ERROR',message}})
    })
    registerMemoryBoardRoutes(app,f.service)
    // The registry is a typed composition fake over real transport, authentication and handlers.
    app.post('/mcp',async(request,reply)=>{
      const registry=memoryTestRegistry(request.operatorPrincipal!,commands)
      const rpc=request.body as {id?:string|number;method?:string;params?:{name?:string}}
      const selected=tools.find(tool=>tool.name===rpc.params?.name)
      if(rpc.method==='tools/call' && selected && !registry.available(selected)) {
        const result=await registry.invoke(selected,rpc.params)
        return reply.send({jsonrpc:'2.0',id:rpc.id,result})
      }
      const server=new McpServer({name:'memory-board-parity',version:'1'})
      stripMcpInputSchemas(server)
      for(const tool of tools)if(registry.available(tool))registry.register(server,tool)
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined})
      reply.raw.once('close',()=>{void Promise.allSettled([transport.close(),server.close()])})
      await server.connect(transport)
      reply.hijack()
      const handle=toNodeHandler({fetch:(webRequest,options)=>transport.handleRequest(webRequest,options)},{onerror:error=>request.log.error(error)})
      await handle({method:request.method,url:request.url,headers:request.raw.headers,
        [Symbol.asyncIterator]:()=>request.raw[Symbol.asyncIterator]()},reply.raw,request.body)
    })
    try {
      const address=await app.listen({host:'127.0.0.1',port:0})
      async function connect(token:string){const client=new Client({name:'memory-board-test',version:'1'});clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));return client}
      const editor=await connect(owner.token),readonly=await connect(reader.token),outsider=await connect(foreign.token)
      const command={kind:'card_create',boardId,commandId:randomUUID(),card:{title:'HTTP task',body:'Initial',status:'todo',completionKind:null,reason:null,assignee:null,linkedNodes:[]}}
      const created=await app.inject({method:'POST',url:`/api/memory-boards/${boardId}/cards`,headers:{authorization:`Bearer ${owner.token}`},payload:command})
      expect(created.statusCode).toBe(200)
      const saved=created.json<MutationReceipt>()
      const read=decodeMcpToolResult(await readonly.callTool({name:'memory_board_get',arguments:{boardId,view:'card',cardId:saved.card!.id}}))
      expect(read.card).toEqual(saved.card)
      const updated=decodeMcpToolResult(await editor.callTool({name:'memory_card_update',arguments:{kind:'card_update',boardId,cardId:saved.card!.id,
        commandId:randomUUID(),patch:{body:'Changed over MCP'},explanation:'Ignored by normal wrapper'}}))
      const response=await app.inject({method:'GET',url:`/api/memory-boards?boardId=${boardId}&view=card&cardId=${saved.card!.id}`,headers:{authorization:`Bearer ${reader.token}`}})
      expect(response.json<CardDetail>().card).toEqual(updated.card)
      expect((await readonly.listTools()).tools.map(tool=>tool.name)).not.toContain('memory_card_update')
      expect((await readonly.callTool({name:'memory_card_update',arguments:{kind:'card_update',boardId,cardId:saved.card!.id,patch:{body:'Denied'}}})).isError).toBe(true)
      expect((await outsider.callTool({name:'memory_board_get',arguments:{boardId}})).isError).toBe(true)
      expect((await app.inject({method:'GET',url:`/api/memory-boards?boardId=${boardId}`})).statusCode).toBe(401)
      expect((await f.card(boardId,saved.card!.id)).card.body).toBe('Changed over MCP')
      const mismatch=await app.inject({method:'POST',url:`/api/memory-boards/${randomUUID()}/cards`,headers:{authorization:`Bearer ${owner.token}`},payload:command})
      expect(mismatch.statusCode).toBe(400)
      const view=decodeMcpToolResult(await editor.callTool({name:'memory_board_get',arguments:{boardId}}))
      expect(view).toMatchObject({openColumns:[
        {status:'todo',items:[updated.card]},
        {status:'doing',items:[]},
        {status:'waiting_for_user',items:[]},
        {status:'blocked',items:[]},
      ]})
      const waitingCard={title:'Pay for hosting',body:'',status:'waiting_for_user',completionKind:null,reason:'Approve the payment page.',assignee:null,linkedNodes:[]}
      expect((await readonly.callTool({name:'memory_card_create',arguments:{kind:'card_create',boardId,card:waitingCard}})).isError).toBe(true)
      expect((await editor.callTool({name:'memory_card_create',arguments:{kind:'card_create',boardId,card:{...waitingCard,reason:null}}})).isError).toBe(true)
      const waiting=decodeMcpToolResult(await editor.callTool({name:'memory_card_create',arguments:{kind:'card_create',boardId,commandId:randomUUID(),card:waitingCard}}))
      const moved=decodeMcpToolResult(await editor.callTool({name:'memory_card_update',arguments:{kind:'card_update',boardId,cardId:saved.card!.id,
        commandId:randomUUID(),patch:{status:'waiting_for_user',reason:'Sign in to the registrar.'}}}))
      expect(moved.card).toMatchObject({status:'waiting_for_user',reason:'Sign in to the registrar.'})
      const column=await app.inject({method:'GET',url:`/api/memory-boards?boardId=${boardId}&view=cards&status=waiting_for_user`,headers:{authorization:`Bearer ${reader.token}`}})
      expect(column.json<{items:{id:string}[]}>().items.map(item=>item.id).sort()).toEqual([saved.card!.id,(waiting.card as {id:string}).id].sort())
      expect(decodeMcpToolResult(await readonly.callTool({name:'memory_board_get',arguments:{boardId}}))).toMatchObject({counts:{todo:0,waiting_for_user:2}})
      expect(createMemoryBoardTools(undefined)).toEqual([])
    } finally {
      await Promise.allSettled(clients.map(client=>client.close()))
      await app.close()
    }
  },60000)
})
