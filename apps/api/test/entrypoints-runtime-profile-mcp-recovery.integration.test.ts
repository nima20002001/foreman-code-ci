import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { runtimeProfileFixture } from './helpers/runtimeProfileMcpFixture.js'

describe.skipIf(!postgresEnabled)('runtime profile authenticated HTTP/MCP parity', () => {
  const fixture = runtimeProfileFixture()

  it.each(['throw','unconfirmed'] as const)('reconciles a saved %s result through MCP across service restart', async fault => {
    const f = await fixture()
    try {
      vi.spyOn(f.service,'qualify').mockImplementation((...args) => f.createService().qualify(...args))
      const client = await f.connect()
      const commandId = randomUUID()
      const args = { workspaceId:f.workspaceId,approvalId:f.approval.id,commandId }
      if (fault === 'unconfirmed') f.producer.run.mockResolvedValueOnce({ outcome:'denied',closure:'unconfirmed',
        reasons:['Original cleanup pending'] })
      const first = await client.callTool({ name:'job_runtime_qualification_run',arguments:args })
      expect(first.isError === true).toBe(fault === 'throw')
      f.producer.reconcile.mockResolvedValue({ outcome:'denied',closure:'confirmed',reasons:['Original operation closed'] })
      const reader = await f.access.issue({ name:'Qualification reader',audience:'operator',
        grants:[{ actions:['job_definitions:read'],scope:{ workspaceIds:[f.workspaceId] } }],
        expiresAt:new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      expect((await readonly.callTool({ name:'job_runtime_qualification_run',arguments:args })).isError).toBe(true)
      expect((await client.callTool({ name:'job_runtime_qualification_run',arguments:{ ...args,commandId:randomUUID() } })).isError)
        .toBe(true)
      const recovered = await client.callTool({ name:'job_runtime_qualification_run',arguments:args })
      expect(recovered.isError,JSON.stringify(recovered.content)).not.toBe(true)
      expect(decodeMcpToolResult(recovered)).toMatchObject({ profile:{ status:'failed',measurement:null } })
      expect(decodeMcpToolResult((await client.callTool({ name:'job_runtime_qualification_run',arguments:args }))))
        .toEqual(decodeMcpToolResult(recovered))
      const readback = await readonly.callTool({ name:'job_runtime_qualification_get',
        arguments:{ workspaceId:f.workspaceId,approvalId:f.approval.id } })
      expect(decodeMcpToolResult(readback)).toMatchObject({ approval:{ status:'failed' },profile:{ status:'failed' } })
      const row = (await f.db.pool.query(`select run_command_id,run_principal_id,run_result
        from job_runtime_qualification_approvals where id=$1`,[f.approval.id])).rows[0]
      expect(row).toEqual({ run_command_id:commandId,run_principal_id:f.owner.principal.id,
        run_result:{ outcome:'denied',closure:'confirmed',reasons:['Original operation closed'] } })
      expect(f.producer.run).toHaveBeenCalledOnce()
      expect(f.producer.reconcile).toHaveBeenCalledOnce()
    } finally { await f.close() }
  },120_000)

  it.each(['expired','edited'] as const)('recovers an %s original operation without replacing newer profile data', async change => {
    const f = await fixture()
    try {
      const client = await f.connect()
      const commandId = randomUUID()
      const args = { workspaceId:f.workspaceId,approvalId:f.approval.id,commandId }
      f.producer.run.mockResolvedValueOnce({ outcome:'denied',closure:'unconfirmed',reasons:['Cleanup pending'] })
      expect((await client.callTool({ name:'job_runtime_qualification_run',arguments:args })).isError).not.toBe(true)
      if (change === 'expired') {
        const record = { ...f.approval,status:'recovery-required',expiresAt:'2020-01-01T00:00:00Z' }
        await f.db.pool.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',
          [f.approval.id,JSON.stringify(record)])
      } else {
        const changed = await client.callTool({ name:'job_runtime_profile_save',arguments:{ workspaceId:f.workspaceId,
          ...f.input,id:f.profile.id,expectedRevision:1,commandId:randomUUID(),name:'Edited profile' } })
        expect(changed.isError,JSON.stringify(changed.content)).not.toBe(true)
      }
      const current = (await f.db.pool.query('select record from job_runtime_profiles where id=$1',[f.profile.id])).rows[0].record
      f.producer.reconcile.mockResolvedValue({ outcome:'denied',closure:'confirmed',reasons:['Original cleanup confirmed'] })
      const recovered = await client.callTool({ name:'job_runtime_qualification_run',arguments:args })
      expect(recovered.isError,JSON.stringify(recovered.content)).not.toBe(true)
      const persisted = (await f.db.pool.query('select record from job_runtime_profiles where id=$1',[f.profile.id])).rows[0].record
      if (change === 'edited') expect(persisted).toEqual(current)
      else expect(persisted).toMatchObject({ status:'failed',measurement:null })
      expect(decodeMcpToolResult((await client.callTool({ name:'job_runtime_qualification_get',
        arguments:{ workspaceId:f.workspaceId,approvalId:f.approval.id } }))))
        .toMatchObject({ approval:{ status:'failed' },profile:persisted })
      expect(f.producer.run).toHaveBeenCalledOnce()
      expect(f.producer.reconcile).toHaveBeenCalledOnce()
    } finally { await f.close() }
  },120_000)


})
