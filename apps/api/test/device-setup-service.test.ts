import pg from 'pg'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { generateKeyPairSync,randomUUID } from 'node:crypto'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { workerIdentityRequestCode } from '@foreman-code/contracts/device-setup-node'
import { decodeWorkerEnrollmentCode } from '@foreman-code/contracts/device-setup'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
afterEach(()=>vi.restoreAllMocks())
function fixture(){
  const mainId=randomUUID(),keys=generateKeyPairSync('ed25519'),mainPublicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),worker=generateKeyPairSync('ed25519'),publicKey=worker.publicKey.export({type:'spki',format:'pem'}).toString(),identity={workerInstallationId:randomUUID(),publicKey,publicKeyFingerprint:publicKeyFingerprint(publicKey)}
  const principal:ManagementPrincipal={id:'setup-actor',name:'Actor',audience:'operator',grants:[{actions:['settings:read','settings:update'],scope:{}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null},receipts=new Map<string,unknown>(),registrations:unknown[]=[]
  let grants=0,available=true,revoked=false
  const query=vi.fn(async(text:string,values?:unknown[])=>{
    let rows:unknown[]=[]
    if(text.includes('pg_try_advisory_lock'))rows=[{locked:true}]
    else if(text.includes('select id,name,audience,grants'))rows=[{id:principal.id,name:principal.name,audience:'operator',grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:revoked?new Date():null,delegated_from:null}]
    else if(text.includes('from device_main_identity'))rows=[{mainPublicKey,mainPublicKeyFingerprint:publicKeyFingerprint(mainPublicKey)}]
    else if(text.includes('device_authorization_secret'))rows=[{secret:'a'.repeat(64)}]
    else if(text.includes('input_hash, target_key, result'))rows=receipts.has(`${values![1]}:${values![2]}`)?[receipts.get(`${values![1]}:${values![2]}`)]:[]
    else if(text.startsWith('select record from device_registrations'))rows=registrations.length?[{record:registrations[0]}]:[]
    if(text.startsWith('insert into management_command_receipts'))receipts.set(`${values![1]}:${values![2]}`,{input_hash:values![4],target_key:values![3],result:JSON.parse(values![5] as string)})
    if(text.startsWith('insert into device_registrations'))registrations.push(values![4])
    if(text.startsWith('insert into device_pairing_grants'))grants++
    return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
  })
  const connection={query,release:vi.fn()},pool=new pg.Pool()
  vi.spyOn(pg.Pool.prototype,'query').mockImplementation(query as never)
  vi.spyOn(pg.Pool.prototype,'connect').mockResolvedValue(connection as never)
  const service=new PostgresDeviceAccessService(pool,mainId,undefined,()=>available?{endpoint:'wss://192.168.1.12:7443/device/connect',available:true,reason:null}:{endpoint:null,available:false,reason:'listener-not-started'})
  const input={commandId:randomUUID(),identityRequestCode:workerIdentityRequestCode(identity),endpoint:'wss://192.168.1.12:7443/device/connect',scopes:['connect','heartbeat'] as ('connect'|'heartbeat')[]}
  return {service,principal,input,query,receipts,get grants(){return grants},get registrations(){return registrations},unavailable:()=>{available=false},available:()=>{available=true},revoke:()=>{revoked=true}}
}
describe('actual setup approval service with original command/grant persistence',()=>{
  it('retries setup after the listener becomes available and persists one original enrollment',async()=>{
    const f=fixture()
    f.unavailable()
    await expect(f.service.createSetupCode(f.principal,f.input)).rejects.toMatchObject({code:'DEVICE_SETUP_ENDPOINT_UNAVAILABLE'})
    expect(f.grants).toBe(0)
    expect(f.receipts.size).toBe(0)
    f.available()
    const created=await f.service.createSetupCode(f.principal,f.input,'http')
    await expect(f.service.createSetupCode(f.principal,f.input,'mcp')).resolves.toEqual(created)
    expect(decodeWorkerEnrollmentCode(created.enrollmentCode).enrollment.mainId).toBe(created.registration.mainId)
    expect(f.grants).toBe(1)
    expect(f.registrations).toEqual([created.registration])
    expect(f.receipts.size).toBe(2)
  })
  it('creates one grant and registration, returns one original code on retries, and stores no private code/grant in outer receipt',async()=>{
    const f=fixture(),first=await f.service.createSetupCode(f.principal,f.input,'http'),retry=await f.service.createSetupCode(f.principal,f.input,'mcp')
    expect(retry).toEqual(first);expect(f.grants).toBe(1);expect(f.registrations).toHaveLength(1)
    const code=decodeWorkerEnrollmentCode(first.enrollmentCode);expect(code.expiresAt).toBe(first.expiresAt);expect(code.enrollment.grant).toHaveLength(43)
    const saved=JSON.stringify([...f.receipts.values()]);expect(saved).not.toContain(code.enrollment.grant);expect(saved).not.toContain(first.enrollmentCode)
    await expect(f.service.createSetupCode(f.principal,{...f.input,endpoint:'wss://different.example/device/connect'})).rejects.toMatchObject({code:'COMMAND_ID_CONFLICT'})
    expect(f.grants).toBe(1)
  })
  it('refuses absent actual listener or wrong endpoint before issuing any grant',async()=>{
    const f=fixture();f.unavailable();expect((await f.service.readSetupOptions(f.principal)).available).toBe(false)
    await expect(f.service.createSetupCode(f.principal,f.input)).rejects.toMatchObject({code:'DEVICE_SETUP_ENDPOINT_UNAVAILABLE'});expect(f.grants).toBe(0)
  })
  it('denies readonly and revoked authority, without issuing grants',async()=>{
    const f=fixture(),reader={...f.principal,grants:[{actions:['settings:read'] as const,scope:{}}]}
    await expect(f.service.createSetupCode({...reader,grants:reader.grants.map(grant=>({...grant,actions:[...grant.actions]}))},f.input)).rejects.toMatchObject({code:'ACCESS_DENIED'})
    f.revoke();await expect(f.service.createSetupCode(f.principal,f.input)).rejects.toMatchObject({code:'AUTH_REVOKED'});expect(f.grants).toBe(0)
  })
})
