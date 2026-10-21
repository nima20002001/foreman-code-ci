import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { runtimeProfileFixture } from './helpers/runtimeProfileMcpFixture.js'
import type { Client } from '@modelcontextprotocol/client'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { JobRuntimeProfileListSchema } from '@foreman-code/contracts/job-runtime'
import { JobRuntimeProfileListRecordSchema, JobVerificationProfileSchema, JobRuntimeQualificationReadRecordSchema,
  type JobRuntimeApprovalRecord } from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { z } from 'zod'
import { verificationFixture } from './helpers/jobVerificationFixture.js'

const verificationSaveResult = z.object({ profile: JobVerificationProfileSchema }).strict()

describe.skipIf(!postgresEnabled)('runtime profile authenticated HTTP/MCP parity', () => {
  const fixture = runtimeProfileFixture()

  it('keeps a newer qualification ready when an older denial completes and reads old evidence separately', async () => {
    const f = await fixture()
    let finish!: () => void
    let pending: ReturnType<Client['callTool']> | undefined
    try {
      const v = verificationFixture()
      const client = await f.connect()
      const second = await f.connect()
      const response = await client.callTool({ name:'job_runtime_profile_save',arguments:{ workspaceId:f.workspaceId,
        commandId:randomUUID(),expectedRevision:null,name:'Concurrent qualification',spec:{
          rootId:f.input.spec.rootId,bindingRevision:1,resources:v.resources,policy:jobPolicyRequirementsRecord(v.spec.policy),
          suites:['unit'],approvalConfig:{ approvalLifetimeMs:JOB_VERIFICATION_APPROVAL_LIFETIME_MS },
        } } })
      expect(response.isError,JSON.stringify(response.content)).not.toBe(true)
      const saved = verificationSaveResult.parse(decodeMcpToolResult(response)).profile
      const capture = async (using = client) => {
        const result = await using.callTool({ name:'job_runtime_qualification_request',arguments:{ workspaceId:f.workspaceId,
          profileId:saved.id,expectedRevision:saved.revision,commandId:randomUUID() } })
        expect(result.isError,JSON.stringify(result.content)).not.toBe(true)
        return (decodeMcpToolResult(result) as { approval:JobRuntimeApprovalRecord }).approval
      }
      const older = await capture()
      let started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      const release = new Promise<void>(resolve => { finish = resolve })
      f.producer.run.mockImplementationOnce(async () => {
        started()
        await release
        return { outcome:'denied',closure:'confirmed',reasons:['Older suite failed'] }
      })
      pending = client.callTool({ name:'job_runtime_qualification_run',arguments:{ workspaceId:f.workspaceId,
        approvalId:older.id,commandId:randomUUID() } })
      await entered
      const newer = await capture(second)
      const completed = await second.callTool({ name:'job_runtime_qualification_run',arguments:{ workspaceId:f.workspaceId,
        approvalId:newer.id,commandId:randomUUID() } })
      expect(completed.isError,JSON.stringify(completed.content)).not.toBe(true)
      const qualified = verificationSaveResult.parse(decodeMcpToolResult(completed)).profile
      finish()
      const denied = await pending
      expect(denied.isError,JSON.stringify(denied.content)).not.toBe(true)
      expect(decodeMcpToolResult(denied)).toEqual({ profile:qualified })
      const read = await client.callTool({ name:'job_runtime_qualification_get',arguments:{
        workspaceId:f.workspaceId,approvalId:older.id } })
      expect(JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(read))).toMatchObject({
        approval:{ id:older.id,status:'failed' },measurement:null,profile:qualified,readiness:{ ready:true,sideEffects:false },
      })
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1',[saved.id])).rows[0].record)
        .toEqual(qualified)
      expect(qualified.measurement?.identity.qualificationId).toBe(newer.qualificationId)
      expect((await f.db.pool.query('select record,run_result from job_runtime_qualification_approvals where id=$1',
        [older.id])).rows[0]).toMatchObject({ record:{ status:'failed' },run_result:{ outcome:'denied',closure:'confirmed' } })
    } finally {
      finish?.()
      await Promise.allSettled(pending ? [pending] : [])
      await f.close()
    }
  },120_000)

  it.each(['qualifying','recovery-required'] as const)('discovers %s ownership through HTTP and read-only MCP', async status => {
    const f = await fixture()
    try {
      const commandId = randomUUID()
      const record = { ...f.approval,status }
      await f.db.pool.query(`update job_runtime_qualification_approvals
        set record=$2::jsonb,run_command_id=$3,run_principal_id=$4 where id=$1`,
      [f.approval.id,JSON.stringify(record),commandId,f.owner.principal.id])
      const before = (await f.db.pool.query('select * from job_runtime_qualification_approvals where id=$1',[f.approval.id])).rows[0]
      const reader = await f.access.issue({ name:'Recovery discovery reader',audience:'operator',
        grants:[{ actions:['job_definitions:read'],scope:{ workspaceIds:[f.workspaceId] } }],
        expiresAt:new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      const listed = await readonly.callTool({ name:'job_runtime_profile_list',arguments:{ workspaceId:f.workspaceId } })
      expect(listed.isError,JSON.stringify(listed.content)).not.toBe(true)
      const result = JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(listed))
      expect(result.approvals).toEqual([{ ...record,runCommandId:commandId,runPrincipalId:f.owner.principal.id }])
      const http = await f.app.inject({ method:'GET',url:`${f.base}/runtime-profiles`,
        headers:{ authorization:`Bearer ${reader.token}` } })
      expect(http.statusCode,http.body).toBe(200)
      expect(http.json()).toEqual(result)
      const outsider = await f.access.issue({ name:'Outside recovery scope',audience:'operator',
        grants:[{ actions:['job_definitions:read'],scope:{ workspaceIds:['foreign'] } }],
        expiresAt:new Date(Date.now() + 600_000) })
      const denied = await f.connect(outsider.token)
      expect((await denied.callTool({ name:'job_runtime_profile_list',arguments:{ workspaceId:f.workspaceId } })).isError)
        .toBe(true)
      expect((await f.db.pool.query('select * from job_runtime_qualification_approvals where id=$1',[f.approval.id])).rows[0])
        .toEqual(before)
      expect(f.producer.run).not.toHaveBeenCalled()
      expect(f.producer.reconcile).not.toHaveBeenCalled()
    } finally { await f.close() }
  },120_000)
  it('lists the shared persisted profile and pending approval DTO and denies a foreign scope', async () => {
    const f = await fixture()
    try {
      const client = await f.connect()
      const http = await f.app.inject({ method: 'GET', url: `${f.base}/runtime-profiles`, headers: f.auth })
      expect(http.statusCode, http.body).toBe(200)
      const expected = JobRuntimeProfileListSchema.parse(http.json())
      expect(expected.profiles).toHaveLength(1); expect(expected.approvals).toEqual([f.approval])
      const read = await client.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      expect(JobRuntimeProfileListSchema.parse(decodeMcpToolResult(read))).toEqual(expected)
      const persisted = (await f.db.pool.query('select record from job_runtime_profiles where id=$1', [f.profile.id])).rows[0].record
      expect(expected.profiles[0]?.profile).toEqual(persisted)
      const outsider = await f.access.issue({ name: 'Foreign scope reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: ['foreign'] } }], expiresAt: new Date(Date.now() + 600_000) })
      const denied = await f.connect(outsider.token)
      expect((await denied.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })).isError).toBe(true)
      expect((await f.db.pool.query("select outcome from management_audit where principal_id=$1 and action='job_runtime_profile_list'", [outsider.principal.id])).rows).toEqual([{ outcome: 'denied' }])
      expect(f.producer.run).not.toHaveBeenCalled(); expect(f.producer.revalidate).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)
})
