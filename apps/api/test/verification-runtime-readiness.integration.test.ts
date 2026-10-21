import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { JobAuthoringChoicesRecordSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { JobRuntimeProfileListRecordSchema, JobVerificationProfileSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { buildApp } from '../src/app.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { verificationJobsMcpFixture } from './helpers/verificationJobsMcpFixture.js'
import { retainedJobFixture } from './helpers/retainedJobFixture.js'

it.each(['unavailable', 'changed','root-revoked'] as const)('reports %s runtime templates consistently through HTTP and MCP', async state => {
  const f = await verificationJobsMcpFixture()
  const workspaceId = f.retained.workspaceId
  const jobs = f.createJobs()
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: f.access, services: { commands: f.retained.commands, jobs,
      jobRuntimeProfiles: f.profiles } as unknown as OperatorServices },
  })
  registerJobRuntimeProfileRoutes(app, f.profiles)
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'Verification readiness test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const writer = await connect(f.writer.token)
    const reader = await connect(f.reader.token)
    const saveProfile = async (root: typeof f.retained.root) => {
      const result = await writer.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: null, name: 'Runtime readback profile', spec: {
          rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
          resources: f.seed.spec.verification.resources, policy: jobPolicyRequirementsRecord(f.seed.spec.policy),
          suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS },
        },
      } })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return z.object({ profile: JobVerificationProfileSchema }).parse(decodeMcpToolResult(result)).profile
    }
    const profile = await saveProfile(f.retained.root)
    const qualified = await f.qualify(profile)
    const fingerprint = qualified.measurement!.fingerprint
    const snapshots = async () => (await f.database.pool.query(
      `select p.record as profile,a.record as approval,a.measurement
       from job_runtime_profiles p join job_runtime_qualification_approvals a on a.profile_id=p.id
       where p.id=$1 and a.id=$2`, [profile.id, qualified.measurement!.identity.approvalId])).rows[0]
    const saved = await snapshots()
    const choices = async (profileId = profile.id) => {
      const response = await reader.callTool({ name: 'job_choices_get', arguments: { workspaceId } })
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      const mcp = JobAuthoringChoicesRecordSchema.parse(decodeMcpToolResult(response))
      const http = await app.inject({ method: 'GET', url: `/api/management/workspaces/${workspaceId}/jobs/choices`,
        headers: { authorization: `Bearer ${f.reader.token}` } })
      expect(http.statusCode, http.body).toBe(200)
      expect(JobAuthoringChoicesRecordSchema.parse(http.json())).toEqual(mcp)
      return mcp.verificationTemplates!.find(template => template.profileId === profileId)
    }
    expect(await choices()).toMatchObject({ ready: true })
    if (state === 'unavailable') f.runtimeMetadata.delete(profile.id)
    else if (state === 'root-revoked') await f.database.pool.query(`update workspace_root_policies
      set revoked_at=now() where workspace_id=$1 and root_policy_id=$2 and root_policy_revision=$3`,
    [workspaceId,profile.root.selection.rootPolicyId,profile.root.selection.rootPolicyRevision])
    else f.runtimeMetadata.set(profile.id, { ...fingerprint, runtimeBinarySha256: 'b'.repeat(64) })
    expect(await choices()).toMatchObject({ ready: false })
    const read = await reader.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId } })
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
    expect(JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(read)).profiles
      .find(value => value.profile.id === profile.id)).toEqual({
      profile: qualified, ready: false,
      reasons:state === 'root-revoked' ? ['root_context_changed'] : ['context_changed'],sideEffects:false,
    })
    const denied = await f.access.issue({ name: 'Caller without job access', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const deniedClient = await connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'job_choices_get', arguments: { workspaceId } }))
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId } }))
    expect((await app.inject({ method: 'GET', url: `/api/management/workspaces/${workspaceId}/jobs/choices`,
      headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
    expect(await snapshots()).toEqual(saved)
    f.runtimeMetadata.set(profile.id, fingerprint)
    if (state === 'root-revoked') {
      const replacement = await retainedJobFixture(f.database.pool, f.database.directory, f.writer.principal,
        { workspaceId })
      const replacementProfile = await saveProfile(replacement.root)
      await f.qualify(replacementProfile)
      expect(await choices(replacementProfile.id)).toMatchObject({ ready: true })
      expect(await choices()).toMatchObject({ ready: false })
    } else {
      expect(await choices()).toMatchObject({ ready: true })
    }
    expect(await snapshots()).toEqual(saved)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await jobs.closeQueue()
    await f.runtime.close()
    await f.database.close()
  }
}, 60_000)
