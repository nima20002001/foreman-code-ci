import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import pg from 'pg'
import { McpServer } from '@modelcontextprotocol/server'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import { registerOperatorHttpSecurity, requirePrincipal } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { registerDeviceManagementRoutes } from '../src/modules/devices/management.js'
import { registerHarnessRegistryRoutes, registerHarnessRegistryTools } from '../src/modules/harnesses/registryManagement.js'
import { DomainError } from '../src/modules/errors.js'

const mainId='11111111-1111-4111-8111-111111111111',deviceId='22222222-2222-4222-8222-222222222222'
const mainIdentity={mainId,mainPublicKey:'fixture-public-key',mainPublicKeyFingerprint:'a'.repeat(64)}
function principal(actions:ManagementPrincipal['grants'][number]['actions']):ManagementPrincipal {
  return {id:'readback-reader',name:'Reader',audience:'operator',grants:[{actions,scope:{}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
}
afterEach(()=>vi.restoreAllMocks())
async function fixture(caller:ManagementPrincipal) {
  const app=Fastify(),pool=new pg.Pool(),access=new PostgresAccessService(pool)
  vi.spyOn(access,'authenticate').mockImplementation(async token=>{
    if(token!=='route-test-token')throw new DomainError('AUTH_REQUIRED','Authentication required.',401)
    return caller
  })
  app.addHook('onClose',()=>pool.end())
  registerOperatorHttpSecurity(app,access)
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof DomainError?error.status:400).send({error:{code:error instanceof DomainError?error.code:'INVALID_REQUEST'}}))
  const readMainIdentity=vi.fn(async(actor:ManagementPrincipal)=>{requireAuthorization(actor,'settings:read');return mainIdentity})
  const devices={readMainIdentity,list:vi.fn(async()=>[]),createSetupCode:vi.fn(),readSetupOptions:vi.fn(),createPairingGrant:vi.fn(),revoke:vi.fn()}
  registerDeviceManagementRoutes(app,devices,async request=>requirePrincipal(request))
  const get=vi.fn(async(actor:ManagementPrincipal,host:Parameters<typeof HarnessRegistryReadbackSchema.parse>[0])=>{
    requireAuthorization(actor,'harnesses:read')
    return HarnessRegistryReadbackSchema.parse({instances:[],installations:[],hostMetadata:{hostRef:host,applicationInstallationId:mainId,connection:null,workspaceRoots:null,platform:null}})
  })
  app.get('/api/management/harnesses/:harness',async()=>{throw new DomainError('INVALID_REQUEST','Provider route.',400)})
  registerHarnessRegistryRoutes(app,{get},async request=>requirePrincipal(request))
  return {app,devices,registry:{get},headers:{authorization:'Bearer route-test-token'}}
}
describe('authenticated computer HTTP readback registrars',()=>{
  it('permits the settings-only reader to read the actual selected-main service without capability grants',async()=>{
    const f=await fixture(principal(['settings:read']))
    try {
      const result=await f.app.inject({method:'GET',url:'/api/devices/main',headers:f.headers})
      expect(result.statusCode).toBe(200);expect(result.json()).toEqual(mainIdentity)
      expect(f.devices.readMainIdentity).toHaveBeenCalledOnce();expect(result.headers['cache-control']).toBe('no-store')
    } finally {await f.app.close()}
  })
  it('denies a caller without settings authority before selected-main readback',async()=>{
    const f=await fixture(principal(['capabilities:read']))
    try {
      const result=await f.app.inject({method:'GET',url:'/api/devices/main',headers:f.headers})
      expect(result.statusCode).toBe(403);expect(f.devices.readMainIdentity).not.toHaveBeenCalled()
    } finally {await f.app.close()}
  })
  it('allows local human metadata reads while rejecting remote clients and invalid bearer credentials',async()=>{
    const f=await fixture(principal(['settings:read']))
    try {
      expect((await f.app.inject({method:'GET',url:'/api/devices/main',remoteAddress:'192.0.2.1'})).statusCode).toBe(403)
      expect((await f.app.inject({method:'GET',url:'/api/devices/main',headers:{authorization:'Bearer invalid'}})).statusCode).toBe(401)
      expect(f.devices.readMainIdentity).not.toHaveBeenCalled()
      const local=await f.app.inject({method:'GET',url:'/api/devices/main'})
      expect(local.statusCode).toBe(200)
      expect(local.json()).toEqual(mainIdentity)
    } finally {await f.app.close()}
  })
  it('mounts the static registry readback ahead of the provider parameter route',async()=>{
    const caller=principal(['harnesses:read']),f=await fixture(caller)
    try {
      const result=await f.app.inject({method:'GET',url:`/api/management/harnesses/registry?kind=main&mainId=${mainId}`,headers:f.headers})
      expect(result.statusCode).toBe(200)
      expect(f.registry.get).toHaveBeenCalledWith(caller,{kind:'main',mainId})
      expect(result.json().hostMetadata.hostRef).toEqual({kind:'main',mainId})
      expect(result.headers['cache-control']).toBe('private, no-store')
    } finally {await f.app.close()}
  })
  it('preserves the exact selected device in the authorized registry service call',async()=>{
    const caller=principal(['harnesses:read']),f=await fixture(caller)
    try {
      const result=await f.app.inject({method:'GET',url:`/api/management/harnesses/registry?kind=device&mainId=${mainId}&deviceId=${deviceId}`,headers:f.headers})
      expect(result.statusCode).toBe(200);expect(f.registry.get).toHaveBeenCalledWith(caller,{kind:'device',mainId,deviceId})
    } finally {await f.app.close()}
  })
  it('denies a registry caller without harness read authority',async()=>{
    const f=await fixture(principal(['settings:read']))
    try {
      const result=await f.app.inject({method:'GET',url:`/api/management/harnesses/registry?kind=main&mainId=${mainId}`,headers:f.headers})
      expect(result.statusCode).toBe(403);expect(result.json().error.code).toBe('ACCESS_DENIED')
    } finally {await f.app.close()}
  })
  it('rejects missing device identity instead of substituting the local main',async()=>{
    const f=await fixture(principal(['harnesses:read']))
    try {
      const result=await f.app.inject({method:'GET',url:`/api/management/harnesses/registry?kind=device&mainId=${mainId}`,headers:f.headers})
      expect(result.statusCode).toBe(400);expect(f.registry.get).not.toHaveBeenCalled()
    } finally {await f.app.close()}
  })
})
describe('computer registry MCP read parity',()=>{
  it('delegates the exact host to the same service and withholds the tool from denied callers',async()=>{
    const caller=principal(['harnesses:read']),f=await fixture(caller)
    const server=new McpServer({name:'registry-test',version:'1'}),client=new Client({name:'registry-reader',version:'1'})
    registerHarnessRegistryTools(server,f.registry,caller)
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport);await client.connect(clientTransport)
      const result=await client.callTool({name:'harness_registry_get',arguments:{kind:'main',mainId}})
      expect(result.isError).not.toBe(true);expect(decodeMcpToolResult(result)).toEqual(await f.registry.get(caller,{kind:'main',mainId}))
      const denied=new McpServer({name:'denied-registry',version:'1'}),deniedClient=new Client({name:'denied-reader',version:'1'})
      registerHarnessRegistryTools(denied,f.registry,principal(['settings:read']))
      const [deniedClientTransport,deniedTransport]=InMemoryTransport.createLinkedPair()
      try {
        await denied.connect(deniedTransport);await deniedClient.connect(deniedClientTransport)
        expect((await deniedClient.listTools()).tools).toEqual([])
      } finally {await deniedClient.close();await denied.close()}
    } finally {await client.close();await server.close();await f.app.close()}
  })
})
