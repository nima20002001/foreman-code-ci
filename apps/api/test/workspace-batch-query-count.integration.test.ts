import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

it('archives only selected persisted workspaces with constant database round trips', async () => {
  const db = await currentDatabase()
  const commands = new PostgresCommandCoordinator(db.pool)
  const service = new WorkspaceManagementService(db.pool, commands, new WorkspaceLocationService(db.pool, commands))
  try {
    const { principal } = await new PostgresAccessService(db.pool).issue({ name: 'Archive operator', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['workspaces:create', 'workspaces:read',
        'workspaces:archive'], scope: {} }] })
    const create = async () => (await service.create(principal, 'http', {
      name: 'Archive fixture', commandId: randomUUID(),
    })).value
    const unselected = await create()
    let singleQueries = 0
    for (const size of [1, 100]) {
      const selected = []
      for (let index = 0; index < size; index++) selected.push(await create())
      const query = vi.spyOn(pg.Client.prototype, 'query')
      let count: number
      try {
        const result = await service.archiveBatch(principal, 'http', { commandId: randomUUID(),
          workspaces: selected.map(item => ({ workspaceId: item.workspace.id, expectedRevision: item.revision })) })
        expect(result.value.workspaceIds).toEqual(selected.map(item => item.workspace.id).sort())
        count = query.mock.calls.length
      } finally { query.mockRestore() }
      if (size === 1) singleQueries = count
      else expect(count).toBe(singleQueries)
      expect(count).toBeGreaterThan(0)
      for (const item of selected) {
        const archived = await service.get(principal, item.workspace.id)
        expect(archived.archivedAt).not.toBeNull()
        expect(archived.revision).toBe(item.revision + 1)
      }
      expect(await service.get(principal, unselected.workspace.id)).toEqual(unselected)
    }
  } finally { await db.close() }
})
