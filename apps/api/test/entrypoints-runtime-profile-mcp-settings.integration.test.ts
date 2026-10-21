import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { runtimeProfileFixture } from './helpers/runtimeProfileMcpFixture.js'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { JobRuntimeProfileListRecordSchema, JobVerificationProfileSchema,
  JobRuntimeQualificationReadRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { z } from 'zod'
import { verificationFixture } from './helpers/jobVerificationFixture.js'

const verificationSaveResult = z.object({ profile: JobVerificationProfileSchema }).strict()

describe.skipIf(!postgresEnabled)('runtime profile authenticated HTTP/MCP parity', () => {
  const fixture = runtimeProfileFixture()

  it.each(['http', 'mcp'] as const)('persists reviewed offline verification settings on %s and reads the same commit through MCP', async transport => {
    const f = await fixture()
    try {
      const v = verificationFixture()
      const input = { commandId: randomUUID(), expectedRevision: null, name: 'Ordinary verification',
        spec: { rootId: f.input.spec.rootId, bindingRevision: f.input.spec.bindingRevision,
          resources: v.resources, policy: jobPolicyRequirementsRecord(v.spec.policy),
          suites: ['install', 'typecheck', 'lint', 'unit', 'build'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } } }
      const client = await f.connect()
      let saved
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles`, headers: f.auth, payload: input })
        expect(response.statusCode, response.body).toBe(200)
        saved = JobVerificationProfileSchema.parse(response.json().profile)
      } else {
        const response = await client.callTool({ name: 'job_runtime_profile_save',
          arguments: { workspaceId: f.workspaceId, ...input } })
        expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
        saved = verificationSaveResult.parse(decodeMcpToolResult(response)).profile
      }
      expect(saved.spec).toEqual(input.spec)
      expect(saved).toMatchObject({ schemaVersion: 2, revision: 1, status: 'unqualified', measurement: null,
        sourceCommit: '2'.repeat(40), approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
          review: { authority: 'repository-owner', decisionId: 'offline-verification', reviewedOn: '2026-10-05' } } })
      const retry = await client.callTool({ name: 'job_runtime_profile_save', arguments: { workspaceId: f.workspaceId, ...input } })
      expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true)
      expect(verificationSaveResult.parse(decodeMcpToolResult(retry)).profile).toEqual(saved)
      const persisted = (await f.db.pool.query('select record from job_runtime_profiles where id=$1', [saved.id])).rows[0].record
      expect(persisted).toEqual(saved)
      const versions = (await f.db.pool.query('select record from job_runtime_profile_versions where profile_id=$1', [saved.id])).rows
      expect(versions).toEqual([{ record: saved }])
      const read = await client.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })
      const result = JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(read))
      expect(result.profiles.find(item => item.profile.id === saved.id)).toEqual({ profile: saved, ready: false,
        reasons: ['runtime_setup_required'], sideEffects: false })
      const http = await f.app.inject({ method: 'GET', url: `${f.base}/runtime-profiles`, headers: f.auth })
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toEqual(result)

      f.producer.capture.mockClear()
      const pending = await client.callTool({ name: 'job_runtime_qualification_request', arguments: {
        workspaceId: f.workspaceId, profileId: saved.id, commandId: randomUUID(), expectedRevision: saved.revision } })
      expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true)
      const approval = (decodeMcpToolResult(pending) as { approval: { id: string } }).approval
      expect(f.producer.capture).toHaveBeenCalledWith(saved)
      // A paired, authorized computer qualifies its captured candidate directly; there is no approval route.
      const approve = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-qualifications/${approval.id}/approve`,
        headers: await f.browser(), payload: { commandId: randomUUID() } })
      expect(approve.statusCode).toBe(404)
      const runCommandId = randomUUID()
      const run = await client.callTool({ name: 'job_runtime_qualification_run', arguments: {
        workspaceId: f.workspaceId, approvalId: approval.id, commandId: runCommandId } })
      expect(run.isError, JSON.stringify(run.content)).not.toBe(true)
      const qualified = JobVerificationProfileSchema.parse((decodeMcpToolResult(run) as { profile: unknown }).profile)
      expect(qualified.status).toBe('qualified')
      expect(qualified.measurement?.suites.map(item => item.suite)).toEqual(saved.spec.suites)
      const qualification = await client.callTool({ name: 'job_runtime_qualification_get', arguments: {
        workspaceId: f.workspaceId, approvalId: approval.id } })
      const completed = JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(qualification))
      expect(completed).toMatchObject({ profile: qualified, approval: { status: 'complete' },
        readiness: { ready: true, reasons: [], sideEffects: false } })
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1', [saved.id])).rows[0].record)
        .toEqual(qualified)
      expect(decodeMcpToolResult((await client.callTool({ name: 'job_runtime_qualification_run', arguments: {
        workspaceId: f.workspaceId, approvalId: approval.id, commandId: runCommandId } }))))
        .toEqual(decodeMcpToolResult(run))
      expect(f.producer.run).toHaveBeenCalledOnce()

      const reader = await f.access.issue({ name: 'Verification reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      expect((await readonly.callTool({ name: 'job_runtime_profile_save',
        arguments: { workspaceId: f.workspaceId, ...input, commandId: randomUUID() } })).isError).toBe(true)
      const readback = await readonly.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })
      expect(JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(readback)).profiles.find(item => item.profile.id === saved.id))
        .toEqual({ profile: qualified, ready: true, reasons: [], sideEffects: false })
      for (const name of ['job_runtime_qualification_request', 'job_runtime_qualification_run']) {
        const args = name.endsWith('request') ? { profileId: saved.id, expectedRevision: 1 } : { approvalId: approval.id }
        expect((await readonly.callTool({ name, arguments: { workspaceId: f.workspaceId,
          commandId: randomUUID(), ...args } })).isError).toBe(true)
      }
      expect((await f.db.pool.query("select outcome from management_audit where principal_id=$1 and action='job_runtime_profile_save'",
        [reader.principal.id])).rows).toEqual([{ outcome: 'denied' }])
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_profile_versions where profile_id=$1',
        [saved.id])).rows[0].count).toBe(1)
    } finally { await f.close() }
  }, 120_000)

  it('edits verification settings through MCP with revision conflicts and immutable persisted history', async () => {
    const f = await fixture()
    try {
      const v = verificationFixture()
      const input = { commandId: randomUUID(), expectedRevision: null, name: 'Unit verification',
        spec: { rootId: f.input.spec.rootId, bindingRevision: 1, resources: v.resources,
          policy: jobPolicyRequirementsRecord(v.spec.policy), suites: ['unit'],
          approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } } }
      const client = await f.connect()
      const created = await client.callTool({ name: 'job_runtime_profile_save', arguments: { workspaceId: f.workspaceId, ...input } })
      expect(created.isError, JSON.stringify(created.content)).not.toBe(true)
      const first = verificationSaveResult.parse(decodeMcpToolResult(created)).profile
      const edit = { ...input, commandId: randomUUID(), id: first.id, expectedRevision: first.revision,
        name: 'Install and unit verification', spec: { ...input.spec, suites: ['install', 'unit'] } }
      const updated = await client.callTool({ name: 'job_runtime_profile_save', arguments: { workspaceId: f.workspaceId, ...edit } })
      expect(updated.isError, JSON.stringify(updated.content)).not.toBe(true)
      const second = verificationSaveResult.parse(decodeMcpToolResult(updated)).profile
      expect(second.revision).toBe(2)
      expect(second.spec.suites).toEqual(['install', 'unit'])
      expect(second.createdAt).toBe(first.createdAt)
      const conflict = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles`, headers: f.auth,
        payload: { ...edit, commandId: randomUUID() } })
      expect(conflict.statusCode, conflict.body).toBe(409)
      expect(conflict.json().error.code).toBe('REVISION_CONFLICT')
      const suppliedReview = await client.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId: f.workspaceId, ...edit, commandId: randomUUID(), expectedRevision: second.revision,
        spec: { ...edit.spec, approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
          review: { reviewedByPrincipalId: f.owner.principal.id, reviewedAt: new Date().toISOString(), decisionDigest: 'a'.repeat(64) } } },
      } })
      expect(suppliedReview.isError, JSON.stringify(suppliedReview.content)).not.toBe(true)
      const third = verificationSaveResult.parse(decodeMcpToolResult(suppliedReview)).profile
      expect(third.revision).toBe(3)
      expect(third.spec).toEqual(second.spec)
      expect(third.approvalConfig).toEqual(second.approvalConfig)
      const invalid = await client.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId: f.workspaceId, ...edit, commandId: randomUUID(), expectedRevision: third.revision,
        spec: { ...edit.spec, approvalConfig: { approvalLifetimeMs: 0 } },
      } })
      expect(invalid.isError).toBe(true)
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1', [first.id])).rows[0].record).toEqual(third)
      const history = (await f.db.pool.query('select record from job_runtime_profile_versions where profile_id=$1 order by revision',
        [first.id])).rows.map(row => row.record)
      expect(history).toEqual([first, second, third])
      expect(f.producer.run).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)


})
