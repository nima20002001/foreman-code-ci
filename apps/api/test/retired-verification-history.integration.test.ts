import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { JobRuntimeProfileListRecordSchema, JobRuntimeQualificationReadRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { buildApp } from '../src/app.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { jobDigest } from '../src/modules/jobs/service.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { verificationJobsMcpFixture } from './helpers/verificationJobsMcpFixture.js'

it('preserves retired qualification profiles through HTTP and MCP and reports them unavailable', async () => {
  const f = await verificationJobsMcpFixture()
  const workspaceId = f.retained.workspaceId
  const jobs = f.createJobs()
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: f.access, services: { commands: f.retained.commands, jobs,
      jobRuntimeProfiles: f.profiles } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  registerJobRuntimeProfileRoutes(app, f.profiles)
  try {
    const profile = await f.profiles.save(f.writer.principal, 'http', workspaceId, {
      commandId: randomUUID(), expectedRevision: null, name: 'Historical native tool profile',
      spec: { rootId: f.retained.root.binding.rootId, bindingRevision: f.retained.root.binding.bindingRevision,
        resources: f.seed.spec.verification.resources, policy: jobPolicyRequirementsRecord(f.seed.spec.policy),
        suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } },
    })
    if (profile.schemaVersion !== 2) throw new Error('Expected a verification profile')
    const qualified = await f.qualify(profile)
    const measurement = structuredClone(qualified.measurement!)
    measurement.fingerprint.tools.push({ kind: 'opencode', executable: '/saved/opencode',
      version: '1.18.31', binarySha256: 'a'.repeat(64) })
    measurement.identity.fingerprintDigest = jobDigest(measurement.fingerprint)
    const historical = { ...qualified, measurement }
    const approvalId = measurement.identity.approvalId
    const approvalRow = await f.database.pool.query<{ record: Record<string, unknown> }>(
      'select record from job_runtime_qualification_approvals where id=$1', [approvalId])
    const approval = { ...approvalRow.rows[0]!.record, fingerprint: measurement.fingerprint,
      fingerprintDigest: measurement.identity.fingerprintDigest }
    await f.database.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1',
      [profile.id, JSON.stringify(historical)])
    await f.database.pool.query(`update job_runtime_qualification_approvals
      set record=$2::jsonb,measurement=$3::jsonb where id=$1`,
    [approvalId, JSON.stringify(approval), JSON.stringify(measurement)])
    const snapshots = async () => (await f.database.pool.query(
      `select p.record as profile,a.record as approval,a.measurement
       from job_runtime_profiles p join job_runtime_qualification_approvals a on a.profile_id=p.id
       where p.id=$1 and a.id=$2`, [profile.id, approvalId])).rows[0]
    const saved = await snapshots()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'retired-verification-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(f.reader.token)
    const response = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${workspaceId}/jobs/runtime-profiles`,
      headers: { authorization: `Bearer ${f.reader.token}` } })
    expect(response.statusCode, response.body).toBe(200)
    const state = JobRuntimeProfileListRecordSchema.parse(response.json())
    expect(state.profiles.find(value => value.profile.id === profile.id)).toEqual({
      profile: historical, ready: false, reasons: ['HARNESS_RETIRED'], sideEffects: false,
    })
    const result = await client.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(result))).toEqual(state)
    const read = await client.callTool({ name: 'job_runtime_qualification_get', arguments: { workspaceId, approvalId } })
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
    expect(JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(read))).toMatchObject({
      profile: historical, approval, measurement, readiness: { ready: false, reasons: ['HARNESS_RETIRED'] },
    })
    const denied = await f.access.issue({ name: 'Caller without job access', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const deniedClient = await connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId } }))
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'job_runtime_qualification_get',
      arguments: { workspaceId, approvalId } }))
    const deniedResponse = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${workspaceId}/jobs/runtime-profiles`,
      headers: { authorization: `Bearer ${denied.token}` } })
    expect(deniedResponse.statusCode).toBe(403)
    expect(await snapshots()).toEqual(saved)
    await f.database.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1',
      [profile.id, JSON.stringify(qualified)])
    const supportedCurrent = await snapshots()
    const oldQualification = await client.callTool({ name: 'job_runtime_qualification_get',
      arguments: { workspaceId, approvalId } })
    expect(oldQualification.isError, JSON.stringify(oldQualification.content)).not.toBe(true)
    const historicalRead = JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(oldQualification))
    // Readiness describes the current profile while the requested qualification retains its historical measurement.
    expect(historicalRead).toMatchObject({
      profile: qualified, approval, measurement, readiness: { ready: true, reasons: [], sideEffects: false },
    })
    const historicalHttp = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${workspaceId}/jobs/runtime-qualifications/${approvalId}`,
      headers: { authorization: `Bearer ${f.reader.token}` } })
    expect(historicalHttp.statusCode, historicalHttp.body).toBe(200)
    expect(JobRuntimeQualificationReadRecordSchema.parse(historicalHttp.json())).toEqual(historicalRead)
    expect(await snapshots()).toEqual(supportedCurrent)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await jobs.closeQueue()
    await f.runtime.close()
    await f.database.close()
  }
}, 60_000)
