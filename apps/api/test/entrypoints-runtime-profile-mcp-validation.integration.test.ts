import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { runtimeProfileFixture } from './helpers/runtimeProfileMcpFixture.js'

describe.skipIf(!postgresEnabled)('runtime profile authenticated HTTP/MCP parity', () => {
  const fixture = runtimeProfileFixture()

  it.each(['http', 'mcp'] as const)('rejects an oversized spool on %s profile save before writing a profile', async transport => {
    const f = await fixture()
    try {
      const input = { ...f.input, commandId: randomUUID(), spec: { ...f.input.spec, policy: { ...f.input.spec.policy, maxWorkerSpoolBytes: 67108865 } } }
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles`, headers: f.auth, payload: input })
        expect(response.statusCode, response.body).toBe(400)
      } else {
        const client = await f.connect()
        expect((await client.callTool({ name: 'job_runtime_profile_save', arguments: { ...input, workspaceId: f.workspaceId } })).isError).toBe(true)
      }
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_profiles')).rows[0].count).toBe(1)
      expect(f.producer.run).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)

  it('rejects qualification requests for an older oversized profile on HTTP and MCP before candidate capture', async () => {
    const f = await fixture()
    try {
      const older = { ...f.profile, policy: { ...f.profile.policy, maxWorkerSpoolBytes: 67108865 } }
      await f.db.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1', [f.profile.id, JSON.stringify(older)])
      f.producer.capture.mockClear()
      const http = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles/${f.profile.id}/qualification-requests`, headers: f.auth,
        payload: { commandId: randomUUID(), expectedRevision: 1 } })
      expect(http.statusCode, http.body).toBe(400)
      const client = await f.connect()
      expect((await client.callTool({ name: 'job_runtime_qualification_request', arguments: {
        workspaceId: f.workspaceId, profileId: f.profile.id, commandId: randomUUID(), expectedRevision: 1,
      } })).isError).toBe(true)
      expect(f.producer.capture).not.toHaveBeenCalled(); expect(f.producer.run).not.toHaveBeenCalled()
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_qualification_approvals')).rows[0].count).toBe(1)
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1', [f.profile.id])).rows[0].record).toEqual(older)
    } finally { await f.close() }
  }, 120_000)

  it.each(['http', 'mcp'] as const)('settles a thrown %s qualification in recovery-required with a sanitized reason and retained ownership', async transport => {
    const f = await fixture()
    try {
      const commandId = randomUUID(), client = await f.connect()
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-qualifications/${f.approval.id}/run`, headers: f.auth, payload: { commandId } })
        expect(response.statusCode).toBe(500); expect(response.body).not.toContain('/secret/path')
      } else {
        const response = await client.callTool({ name: 'job_runtime_qualification_run', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id, commandId } })
        expect(response.isError).toBe(true); expect(JSON.stringify(response)).not.toContain('/secret/path')
      }
      const read = await f.app.inject({ method: 'GET', url: `${f.base}/runtime-qualifications/${f.approval.id}`, headers: f.auth })
      expect(read.statusCode, read.body).toBe(200)
      expect(read.json()).toMatchObject({ profile: { status: 'recovery-required', measurement: null }, approval: { status: 'recovery-required' },
        measurement: null, readiness: { ready: false, reasons: ['JOB_RUNTIME_QUALIFICATION_FAILED'], sideEffects: false } })
      expect(decodeMcpToolResult((await client.callTool({ name: 'job_runtime_qualification_get', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id } })))).toEqual(read.json())
      const stored = (await f.db.pool.query('select run_command_id,run_principal_id,run_result from job_runtime_qualification_approvals where id=$1', [f.approval.id])).rows[0]
      expect(stored).toEqual({ run_command_id: commandId, run_principal_id: f.owner.principal.id,
        run_result: { outcome: 'denied', closure: 'unconfirmed', reasons: ['JOB_RUNTIME_QUALIFICATION_FAILED'] } })
      const retry = await client.callTool({ name: 'job_runtime_qualification_run', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id, commandId } })
      expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true)
      expect(decodeMcpToolResult(retry)).toMatchObject({ profile: { status: 'recovery-required', measurement: null } })
      expect(f.producer.run).toHaveBeenCalledOnce()
    } finally { await f.close() }
  }, 120_000)


})
