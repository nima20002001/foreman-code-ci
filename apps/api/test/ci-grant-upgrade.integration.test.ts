import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ciGrantMigration } from '../src/infrastructure/ciGrantMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
beforeAll(async () => { database = await currentDatabase({ beforeMigration: ciGrantMigration.version }) }, 60_000)
afterAll(async () => { await database.close() }, 60_000)

describe('CI grant upgrade', () => {
  it('lets credentials that could start CI before the ci action keep starting CI, in the same scope', async () => {
    const access = new PostgresAccessService(database.pool)
    const expiresAt = new Date(Date.now() + 300_000)
    const scope = { workspaceIds: ['workspace-ci-upgrade'] }
    const runner = await access.issue({ name: 'Old CI caller', audience: 'operator', expiresAt, grants: [
      { actions: ['jobs:read'], scope: {} },
      { actions: ['sources:read', 'job_definitions:write', 'jobs:start', 'jobs:cancel'], scope },
    ] })
    const reader = await access.issue({ name: 'Old CI reader', audience: 'operator', expiresAt, grants: [
      { actions: ['jobs:read', 'job_logs:read'], scope: {} },
    ] })

    await applyApplicationMigrations(database.pool)
    await applyApplicationMigrations(database.pool)

    const upgraded = await access.authenticate(runner.token)
    expect(upgraded.grants).toEqual([
      { actions: ['jobs:read'], scope: {} },
      { actions: ['sources:read', 'job_definitions:write', 'jobs:start', 'jobs:cancel', 'ci'], scope },
    ])
    expect((await access.authenticate(reader.token)).grants.flatMap(grant => grant.actions)).not.toContain('ci')
  })
})
