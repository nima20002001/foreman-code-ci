import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { ManagedWorkspaceCommandResultSchema, ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { workspaceMcpFixture, callWorkspaceTool } from './helpers/workspaceMcp.js'

const installationA = 'd95abeb8-598a-49a4-8c3c-c6e3533053e8'
const installationB = '8b8fe654-6e4a-4d4c-b451-2795ccbf7074'
const identity = (installationId: string) => ({ installationId, checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) })

it('rejects another document installation before workspace admission and preserves authenticated MCP creation', async () => {
  const databaseA = await migratedDatabase()
  try {
    const a = await workspaceMcpFixture({ database: databaseA, runtimeIdentity: async () => identity(installationA) })
    try {
      const databaseB = await migratedDatabase()
      try {
        const b = await workspaceMcpFixture({ database: databaseB, runtimeIdentity: async () => identity(installationB) })
        try {
          const verified = (await a.app.inject({ method: 'GET', url: '/api/runtime/identity' })).json()
          const input = { commandId: randomUUID(), name: 'Project', parentPath: b.parentPath }
          const rejected = await b.app.inject({ method: 'POST', url: '/api/management/workspaces',
            headers: { 'x-foreman-installation-id': verified.installationId, 'sec-fetch-site': 'same-origin' }, payload: input })
          expect(rejected.statusCode).toBe(409)
          expect(rejected.json()).toMatchObject({ error: { code: 'INSTALLATION_CHANGED' } })
          expect(await readdir(b.parentPath)).toEqual([])
          expect((await b.pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(0)
          expect((await b.pool.query('select count(*)::int as count from management_command_receipts where command_id=$1',
            [input.commandId])).rows[0].count).toBe(0)
          const missing = await b.app.inject({ method: 'POST', url: '/api/management/workspaces',
            headers: { 'sec-fetch-site': 'same-origin' }, payload: input })
          expect(missing.statusCode).toBe(409)
          const reader = await b.issue([{ actions: ['workspaces:read'], scope: {} }])
          const denied = await b.app.inject({ method: 'POST', url: '/api/management/workspaces',
            headers: { 'x-foreman-installation-id': installationB, authorization: `Bearer ${reader.token}` }, payload: input })
          expect(denied.statusCode).toBe(403)
          expect((await reader.client.callTool({ name: 'workspace_create', arguments: input })).isError).toBe(true)
          const created = await callWorkspaceTool(b.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema, input)
          const readback = await callWorkspaceTool(b.owner.client, 'workspace_get', ManagedWorkspaceSchema,
            { workspaceId: created.value.workspace.id })
          expect(readback.workspace.name).toBe('Project')
          expect(await readdir(b.parentPath)).toEqual(['Project'])
          expect((await callWorkspaceTool(b.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema, input)).replayed).toBe(true)
          const matching = await b.app.inject({ method: 'POST', url: '/api/management/workspaces',
            headers: { 'x-foreman-installation-id': installationB, 'sec-fetch-site': 'same-origin' },
            payload: { ...input, commandId: randomUUID(), name: 'Human project' } })
          expect(matching.statusCode).toBe(201)
          const humanReadback = await callWorkspaceTool(b.owner.client, 'workspace_get', ManagedWorkspaceSchema,
            { workspaceId: matching.json().value.workspace.id })
          expect(humanReadback.workspace.name).toBe('Human project')
        } finally { await b.close() }
      } finally { await databaseB.close() }
    } finally { await a.close() }
  } finally { await databaseA.close() }
}, 60_000)
