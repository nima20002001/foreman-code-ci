import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import { CiEnrollmentStateSchema } from '@foreman-code/contracts'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { describe, expect, it, vi } from 'vitest'
import { CiEnrollment } from '../src/modules/jobs/ciEnrollment.js'
import { buildComputerFixture } from './helpers/buildComputerFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('automatic CI enrollment: templates', () => {
  const fixture = ciEnrollmentFixture()

  it.each(['empty', 'revoked'] as const)(
    'reports missing %s workspace templates through authenticated MCP and persists the setup requirement',
    async configuration => {
      const f = await fixture()
      try {
        let workspaceId = f.workspaceId
        if (configuration === 'empty') {
          workspaceId = randomUUID()
          await f.db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
            [workspaceId, JSON.stringify({ id: workspaceId, name: 'Unconfigured CI' })])
        } else {
          await f.db.pool.query(`update job_runtime_profiles
            set record=jsonb_set(record,'{status}','"revoked"') where workspace_id=$1`, [workspaceId])
        }
        const client = await f.connect()
        const read = async (reader: Client) => {
          const result = await reader.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId } })
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
          return CiEnrollmentStateSchema.parse(decodeMcpToolResult(result))
        }
        const initial = await read(client)
        expect(initial.computers).toHaveLength(f.computers.length)
        for (const computer of initial.computers) {
          expect(computer).toMatchObject({ state: 'templates-required', enabled: true,
            revision: 0, profileIds: [], templates: [], updatedAt: null })
          expect(computer.message).toContain('job_runtime_profile_save')
        }
        expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
          [workspaceId])).rows).toEqual([])

        const reader = await f.access.issue({ name: 'Unconfigured CI reader', audience: 'operator',
          grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }],
          expiresAt: new Date(Date.now() + 600_000) })
        const readonly = await f.connect(reader.token)
        expect(await read(readonly)).toEqual(initial)
        const input = { workspaceId, target: f.computers[0]!.target,
          commandId: randomUUID(), expectedRevision: 0, enabled: true }
        const denied = await readonly.callTool({ name: 'ci_enrollment_update', arguments: input })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
        expect(await read(readonly)).toEqual(initial)

        const updated = await client.callTool({ name: 'ci_enrollment_update', arguments: input })
        expect(updated.isError, JSON.stringify(updated.content)).not.toBe(true)
        await expect.poll(async () => (await read(readonly)).computers.map(computer => ({
          state: computer.state, persisted: computer.updatedAt !== null,
        })), { timeout: 5000 }).toEqual(f.computers.map(() => ({ state: 'templates-required', persisted: true })))
        const rows = (await f.db.pool.query<{ state: { state: string } }>(
          'select state from ci_enrollment_computers where workspace_id=$1', [workspaceId])).rows
        expect(rows).toHaveLength(f.computers.length)
        expect(rows.every(row => row.state.state === 'templates-required')).toBe(true)
        await f.enrollment.close()
        const readback = await read(readonly)
        expect(readback.computers[0]).toMatchObject({ state: 'templates-required', enabled: true,
          revision: 1, profileIds: [], templates: [] })
        const persisted = (await f.db.pool.query<{ state: unknown }>(
          'select state from ci_enrollment_computers where workspace_id=$1', [workspaceId])).rows
        expect(persisted.map(row => row.state)).toEqual(expect.arrayContaining(readback.computers))
        const restarted = new CiEnrollment(f.db.pool, f.commands, f.profiles, f.preparation, f.inventory)
        try {
          expect(await restarted.read(reader.principal, { workspaceId })).toEqual(readback)
        } finally {
          await restarted.close()
        }
        expect(f.preparation.start.mock.calls.filter(([, , request]) => request.workspaceId === workspaceId))
          .toEqual([])
        expect((await f.db.pool.query(`select outcome from management_audit
          where principal_id=$1 and action='ci_enrollment_update'`, [reader.principal.id])).rows)
          .toEqual([{ outcome: 'denied' }])
      } finally {
        await f.close()
      }
    },
  )

  it.each([true, false])('reports ordinary templates without automatic qualification with verification storage=%s',
    async installed => {
      const f = await fixture()
      try {
        const template = buildComputerFixture(f.roots[0]!.binding.mainId, f.workspaceId).candidate.profile
        const ordinary = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
          commandId: randomUUID(), expectedRevision: null, name: 'Ordinary CI',
          spec: { rootId: f.roots[0]!.binding.rootId, bindingRevision: 1, limits: template.limits,
            policy: { ...jobPolicyRequirementsRecord(template.policy), maxWorkerSpoolBytes: 131072 } },
        })
        if (!installed) f.inventory.storage = async () => null
        const qualification = vi.spyOn(f.profiles, 'requestQualification')
        await f.enrollment.reconcile()
        const reader = await f.access.issue({ name: 'Enrollment status reader', audience: 'operator',
          grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
          expiresAt: new Date(Date.now() + 600_000) })
        const client = await f.connect(reader.token)
        const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
        expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
        const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
        for (const computer of state.computers) {
          expect(computer.state).toBe('partial')
          expect(computer.templates).toContainEqual({ templateId: ordinary.id, profileId: null,
            state: 'not-enrolled-automatically',
            message: 'Ordinary Job templates are not enrolled automatically; configure and qualify their protected runtime explicitly.' })
          expect(computer.templates).toContainEqual(expect.objectContaining({ templateId: f.stored.id,
            state: installed ? 'preparing' : 'runtime-required' }))
        }
        expect(qualification).not.toHaveBeenCalled()
        expect(f.preparation.start).toHaveBeenCalledTimes(installed ? 3 : 0)
        expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toHaveLength(installed ? 4 : 2)
        const denied = await client.callTool({ name: 'ci_enrollment_update', arguments: {
          workspaceId: f.workspaceId, target: f.computers[0]!.target, expectedRevision: 0,
          enabled: false, commandId: randomUUID(),
        } })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
        const forbiddenRead = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: randomUUID() } })
        expect(forbiddenRead.isError).toBe(true)
        expect(JSON.stringify(forbiddenRead.content)).toContain('ACCESS_DENIED')
        const readback = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
        expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(readback))).toEqual(state)
        const persisted = (await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
          [f.workspaceId])).rows.map(row => row.state)
        expect(persisted).toEqual(expect.arrayContaining(state.computers))
      } finally { await f.close() }
    })
})
