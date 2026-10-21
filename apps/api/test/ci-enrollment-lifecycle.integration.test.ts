import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { CiEnrollmentStateSchema } from '@foreman-code/contracts'
import { OperatorCapabilitiesSchema } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'
import { CI_ENROLLMENT_ACTIONS, CiEnrollment } from '../src/modules/jobs/ciEnrollment.js'
import { ciEnrollmentProfileInput } from '../src/modules/jobs/ciEnrollmentProfiles.js'
import { buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('automatic CI enrollment: lifecycle', () => {
  const fixture = ciEnrollmentFixture()

  it('persists preparation failures through MCP and waits for backoff before retrying', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      const retryAt = new Date(Date.now() + 60 * 60_000).toISOString()
      const message = 'Root catalog authority does not match the approved workspace/host.'
      for (const [id, status] of f.preparations) {
        f.preparations.set(id, { ...status, state: 'failed', message, failureCount: 6, retryAt })
      }
      await f.enrollment.reconcile()
      await f.enrollment.reconcile()
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const reader = await f.access.issue({ name: 'Enrollment reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const client = await f.connect(reader.token)
      const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
      expect(state.computers.every(computer => computer.state === 'failed'
        && computer.message?.includes(message) && computer.message.includes(retryAt))).toBe(true)
      const persisted = await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])
      expect(persisted.rows.map(row => row.state)).toEqual(expect.arrayContaining(state.computers))
      expect((await client.callTool({ name: 'ci_enrollment_update', arguments: {
        workspaceId: f.workspaceId, target: f.computers[0]!.target, commandId: randomUUID(),
        expectedRevision: 0, enabled: true,
      } })).isError).toBe(true)
      const [id, failure] = [...f.preparations][0]!
      f.preparations.set(id, { ...failure, retryAt: new Date(Date.now() - 1).toISOString() })
      await f.enrollment.reconcile()
      expect(f.preparation.start).toHaveBeenCalledTimes(4)
      expect(f.preparations.get(id)!.state).toBe('preparing')
      const restarted = new CiEnrollment(f.db.pool, f.commands, f.profiles, f.preparation, f.inventory)
      expect(await restarted.read(reader.principal, { workspaceId: f.workspaceId }))
        .toEqual(await f.enrollment.read(reader.principal, { workspaceId: f.workspaceId }))
      await restarted.close()
    } finally { await f.close() }
  })

  it('drops disconnected and build-disabled computers, then restores their saved profiles on reconnect', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      const before = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      f.computers[1]!.connected = false
      f.computers[2]!.buildEnabled = false
      await f.enrollment.reconcile()
      const unavailable = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(unavailable.computers[1]!.state).toBe('offline')
      expect(unavailable.computers[2]!.state).toBe('disabled')
      f.computers[1]!.connected = true
      f.computers[2]!.buildEnabled = true
      await f.enrollment.reconcile()
      const restored = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(restored.computers.map(computer => computer.profileIds)).toEqual(
        before.computers.map(computer => computer.profileIds))
      expect(restored.computers.every(computer => computer.state === 'preparing')).toBe(true)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
    } finally { await f.close() }
  })

  it('automatically enrolls after profile save and build-enable changes', async () => {
    const f = await fixture()
    try {
      f.computers[1]!.buildEnabled = false
      f.profiles.enrollment = f.enrollment
      f.settings.enrollment = f.enrollment
      const template = f.stored
      if (template.schemaVersion !== 2) throw new Error('Verification template required')
      await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId,
        ciEnrollmentProfileInput(template, template.root, {
          diskBytes: template.spec.resources.limits.diskBytes,
          mutableInodes: template.spec.resources.mutableInodes,
        }, randomUUID(), template))
      await vi.waitFor(async () => {
        expect(f.preparation.start).toHaveBeenCalledTimes(2)
        const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
        expect(state.computers[1]!.state).toBe('disabled')
      })
      f.computers[1]!.buildEnabled = true
      const preference = await f.settings.read(f.owner.principal, { target: f.computers[1]!.target })
      await f.settings.update(f.owner.principal, 'mcp', { target: f.computers[1]!.target,
        commandId: randomUUID(), expectedRevision: preference.preference.revision,
        buildEnabled: true, buildPriority: 60 })
      await vi.waitFor(async () => {
        expect(f.preparation.start).toHaveBeenCalledTimes(3)
        const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
        expect(state.computers[1]!.profileIds).toHaveLength(1)
      })
    } finally { await f.close() }
  })

  it('persists revisioned MCP enable/disable controls, denies callers and retains idempotent audit history', async () => {
    const f = await fixture()
    try {
      const client = await f.connect()
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['ci_enrollment_get', 'ci_enrollment_update']))
      const discovery = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full', workspaceId: f.workspaceId } })
      expect(discovery.isError, JSON.stringify(discovery.content)).not.toBe(true)
      const capabilities = OperatorCapabilitiesSchema.parse(decodeMcpToolResult(discovery))
      expect(capabilities.tools).toEqual(expect.arrayContaining(['ci_enrollment_get', 'ci_enrollment_update']))
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({
        name: 'ci_enrollment_update', actions: CI_ENROLLMENT_ACTIONS,
      }))
      const input = { workspaceId: f.workspaceId, target: f.computers[0]!.target,
        commandId: randomUUID(), expectedRevision: 0, enabled: false }
      const changed = await client.callTool({ name: 'ci_enrollment_update', arguments: input })
      expect(changed.isError, JSON.stringify(changed.content)).not.toBe(true)
      const disabled = CiEnrollmentStateSchema.parse(decodeMcpToolResult(changed)).computers[0]!
      expect(disabled).toMatchObject({ enabled: false, revision: 1, state: 'disabled' })
      expect((await client.callTool({ name: 'ci_enrollment_update', arguments: input })).isError).not.toBe(true)
      const restarted = new CiEnrollment(f.db.pool, f.commands, f.profiles, f.preparation, f.inventory)
      expect((await restarted.read(f.owner.principal, { workspaceId: f.workspaceId })).computers[0])
        .toMatchObject({ target: disabled.target, enabled: false, revision: 1, state: 'disabled' })
      await restarted.close()
      const stale = await client.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: randomUUID(), enabled: true,
      } })
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
      const conflicting = await client.callTool({ name: 'ci_enrollment_update', arguments: { ...input, enabled: true } })
      expect(conflicting.isError).toBe(true)
      expect(JSON.stringify(conflicting.content)).toContain('COMMAND_ID_CONFLICT')
      const reader = await f.access.issue({ name: 'CI enrollment reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      expect((await readonly.listTools()).tools.map(tool => tool.name)).not.toContain('ci_enrollment_update')
      const denied = await readonly.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: undefined, expectedRevision: 1, enabled: true,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const read = await readonly.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(read)).computers[0])
        .toMatchObject({ target: disabled.target, enabled: false, revision: 1, state: 'disabled' })
      const outsider = await f.access.issue({ name: 'Other workspace CI owner', audience: 'operator',
        grants: [{ actions: CI_ENROLLMENT_ACTIONS, scope: { workspaceIds: [randomUUID()] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const foreign = await f.connect(outsider.token)
      expect((await foreign.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: undefined, expectedRevision: 1, enabled: true,
      } })).isError).toBe(true)
      expect((await f.db.pool.query(`select outcome from management_audit
        where principal_id=$1 and action='ci_enrollment_update'`, [reader.principal.id])).rows)
        .toEqual([{ outcome: 'denied' }])
      expect((await f.db.pool.query(`select count(*)::int as count from management_audit
        where principal_id=$1 and action='ci_enrollment_update' and outcome='succeeded'`, [f.owner.principal.id]))
        .rows[0]!.count).toBe(1)
      const enabled = await client.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: undefined, expectedRevision: 1, enabled: true,
      } })
      expect(enabled.isError, JSON.stringify(enabled.content)).not.toBe(true)
      await f.enrollment.close()
      const readback = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      const computer = CiEnrollmentStateSchema.parse(decodeMcpToolResult(readback)).computers[0]!
      expect(computer).toMatchObject({ revision: 2, enabled: true })
      expect((await f.db.pool.query(`select revision,enabled from ci_enrollment_computers
        where workspace_id=$1 and host_key=$2`, [f.workspaceId, buildComputerKey(input.target)])).rows[0])
        .toMatchObject({ revision: '2', enabled: true })
    } finally { await f.close() }
  })
})
