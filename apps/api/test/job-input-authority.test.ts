import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import { JobInputAuthority } from '../src/modules/files/jobInputs/authority.js'
import type { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { jobExecution } from './helpers/jobFixture.js'
const principal:ManagementPrincipal={id:'actor',name:'Actor',audience:'operator',grants:[{actions:['workspaces:read'],scope:{workspaceIds:['workspace']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
function fixture(){const pool=new pg.Pool(),authority=new JobInputAuthority(pool,{} as PostgresJobDispatch);let revoked=false;const statements:string[]=[]
 const sql={query:async(statement:string)=>{statements.push(statement);if(statement.includes('management_principals'))return {rows:[{id:principal.id,name:principal.name,audience:principal.audience,grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:revoked?new Date():null,delegated_from:null}]};if(statement.includes('workspaces'))return {rows:[{archived_at:null}]};throw new Error(`Unexpected query: ${statement}`)}} as JobSql
 const pin={path:'input.md',fileId:'file',revisionId:'revision',sha256:'1'.repeat(64),byteSize:3},value={file:{fileId:'file',currentRevisionId:'revision',createdAt:'2026-10-01T00:00:00.000Z',scope:{kind:'workspace_reference',workspaceId:'workspace'},state:'ready'},revision:pin} as unknown as FileWithRevision
 const read=vi.spyOn(authority.files,'read').mockResolvedValue({value,storageKey:'opaque',lifecycleState:'ready'} as never)
 return {pool,authority,sql,pin,read,statements,value,revoke:()=>{revoked=true}}
}
afterEach(()=>vi.restoreAllMocks())

function recipientFixture() {
  const pool = new pg.Pool()
  const execution = jobExecution()
  const expected = structuredClone(execution)
  const actor: ManagementPrincipal = { ...principal,
    grants: [{ actions: ['jobs:start'], scope: { workspaceIds: [execution.workspaceId] } }] }
  let revoked = false
  const require = vi.fn(async () => {})
  const authority = new JobInputAuthority(pool, { require })
  const sql = { query: async (statement: string) => {
    if (statement.includes('job_executions')) {
      return { rows: [{ record: execution, accepted_spec: execution.acceptedSpec, accepted_by: actor.id }] }
    }
    if (statement.includes('management_principals')) {
      return { rows: [{ ...actor, expires_at: new Date(actor.expiresAt), revoked_at: revoked ? new Date() : null,
        delegated_from: null }] }
    }
    throw new Error('Unexpected input authority query')
  } } as JobSql
  return { pool, authority, execution, expected, sql, require, revoke: () => { revoked = true } }
}

it('checks the complete dispatch authority once per input authorization and propagates a runtime denial', async () => {
  const f = recipientFixture()
  try {
    expect((await f.authority.recipient(f.sql, f.expected)).execution).toEqual(f.execution)
    expect(f.require).toHaveBeenCalledTimes(1)
    f.require.mockRejectedValueOnce(new Error('Runtime permission withdrawn'))
    await expect(f.authority.recipient(f.sql, f.expected)).rejects.toThrow('Runtime permission withdrawn')
  } finally { await f.pool.end() }
})

it.each(['revoked', 'cancelled', 'another-attempt'] as const)('rejects %s input recipients before dispatch validation', async state => {
  const f = recipientFixture()
  try {
    if (state === 'revoked') f.revoke()
    if (state === 'cancelled') f.execution.cancelRequestedAt = new Date().toISOString()
    if (state === 'another-attempt') f.execution.attemptId = 'different-attempt'
    await expect(f.authority.recipient(f.sql, f.expected)).rejects.toThrow()
    expect(f.require).not.toHaveBeenCalled()
  } finally { await f.pool.end() }
})

it('supports empty declared inputs with actual live SQL authority, without execution or bytes',async()=>{const f=fixture();try{await f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[]);expect(f.statements).toHaveLength(1);expect(f.read).not.toHaveBeenCalled()}finally{await f.pool.end()}})
it('validates exact revision and scope through canonical metadata at Save/Start',async()=>{const f=fixture();try{await f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[f.pin]);expect(f.read).toHaveBeenCalledWith('file','revision',f.sql);expect(f.statements.some(value=>value.includes('from workspaces'))).toBe(true)}finally{await f.pool.end()}})
it('rejects a changed pinned digest and cross-workspace source',async()=>{const f=fixture();try{await expect(f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[{...f.pin,sha256:'2'.repeat(64)}])).rejects.toThrow('differs');await expect(f.authority.validateDeclaredJobInputs(f.sql,principal,'elsewhere',[f.pin])).rejects.toThrow('outside')}finally{await f.pool.end()}})
it('rejects revocation before even an empty input admission',async()=>{const f=fixture();try{f.revoke();await expect(f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[])).rejects.toThrow('no longer active')}finally{await f.pool.end()}})
