import { randomUUID } from 'node:crypto'
import { CiEnrollmentStateSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it, vi } from 'vitest'
import { CiEnrollment } from '../src/modules/jobs/ciEnrollment.js'
import { buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('Host CI enrollment', () => {
  const fixture = ciEnrollmentFixture()

  it('replaces failed protected preparation with persisted Host CI readiness without retrying it', async () => {
    const f = await fixture()
    try {
      f.computers[2]!.buildEnabled = false
      await f.enrollment.reconcile()
      for (const [id, progress] of f.preparations) {
        f.preparations.set(id, { ...progress, state: 'failed', message: 'extension-rejected',
          retryAt: new Date(Date.now() + 60_000).toISOString() })
      }
      await f.enrollment.reconcile()
      for (const computer of f.computers.slice(0, 2)) computer.executionMode = 'host'
      const status = vi.fn(async () => ({ operation: 'status' as const, ready: true, reasons: [],
        cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] }))
      f.inventory.hostStatus = status
      f.preparation.start.mockClear()
      f.preparation.get.mockClear()
      vi.mocked(f.inventory.storage).mockClear()
      vi.mocked(f.inventory.root).mockClear()
      const profiles = await f.profiles.list(f.owner.principal, f.workspaceId)
      await f.enrollment.reconcile()
      await f.enrollment.reconcile()
      const client = await f.connect()
      const result = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(result.isError).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(result))
      for (const computer of state.computers.slice(0, 2)) {
        expect(computer).toMatchObject({ executionMode: 'host', enabled: true, state: 'ready',
          profileIds: [], templates: [] })
        expect(computer.message).toContain('Use ci_run')
        const persisted = (await f.db.pool.query(`select state from ci_enrollment_computers
          where workspace_id=$1 and host_key=$2`, [f.workspaceId, buildComputerKey(computer.target)])).rows[0]!.state
        expect(persisted).toEqual(computer)
      }
      expect(f.preparation.start).not.toHaveBeenCalled()
      expect(f.preparation.get).not.toHaveBeenCalled()
      expect(f.inventory.storage).not.toHaveBeenCalled()
      expect(f.inventory.root).not.toHaveBeenCalled()
      expect(await f.profiles.list(f.owner.principal, f.workspaceId)).toEqual(profiles)
      const restarted = new CiEnrollment(f.db.pool, f.commands, f.profiles, f.preparation, f.inventory)
      expect(await restarted.read(f.owner.principal, { workspaceId: f.workspaceId })).toEqual(state)
      await restarted.close()
    } finally { await f.close() }
  })

  it('reports missing Host CI prerequisites and global build disable without requiring templates', async () => {
    const f = await fixture()
    try {
      for (const computer of f.computers.slice(0, 2)) computer.executionMode = 'host'
      f.computers[1]!.buildEnabled = false
      f.computers[2]!.buildEnabled = false
      vi.spyOn(f.profiles, 'list').mockResolvedValue({ profiles: [], approvals: [] })
      f.inventory.hostStatus = vi.fn(async () => ({ operation: 'status' as const, ready: false,
        reasons: ['Connect GitHub on this computer.'], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] }))
      const client = await f.connect()
      const input = { workspaceId: f.workspaceId, target: f.computers[0]!.target,
        commandId: randomUUID(), expectedRevision: 0, enabled: true }
      expect((await client.callTool({ name: 'ci_enrollment_update', arguments: input })).isError).not.toBe(true)
      await vi.waitFor(async () => {
        const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
        expect(state.computers[0]!.state).toBe('setup-required')
      })
      await f.enrollment.close()
      const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
      expect(state.computers[0]).toMatchObject({ revision: 1, enabled: true, state: 'setup-required',
        executionMode: 'host', message: 'Connect GitHub on this computer.', templates: [], profileIds: [] })
      expect(state.computers[1]).toMatchObject({ enabled: true, state: 'disabled', executionMode: 'host' })
      expect(state.computers[1]!.message).toContain('build_computer_update')
      expect(f.preparation.start).not.toHaveBeenCalled()
      const reader = await f.access.issue({ name: 'Host CI enrollment reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      const denied = await readonly.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: randomUUID(), expectedRevision: 1, enabled: false,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const persisted = await readonly.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(persisted))).toEqual(state)
    } finally { await f.close() }
  })
})
