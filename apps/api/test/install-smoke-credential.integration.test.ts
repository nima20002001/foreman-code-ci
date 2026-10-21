import { afterAll, beforeAll, expect, it } from 'vitest'
import { withInstallSmokeCredential } from '../src/cli/installSmokeCredential.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it.each(['success', 'failure'] as const)('revokes and audits the narrow install credential after smoke %s', async outcome => {
  const access = new PostgresAccessService(database.pool)
  const authority = new RunCiAuthority(database.pool)
  let token = ''
  let principalId = ''
  const started = Date.now()
  const smoke = withInstallSmokeCredential(database.pool, async credential => {
    token = credential
    const principal = await access.authenticate(token)
    principalId = principal.id
    expect(principal.audience).toBe('operator')
    expect(Date.parse(principal.expiresAt)).toBeGreaterThan(started)
    expect(Date.parse(principal.expiresAt)).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
    requireAuthorization(principal, 'workspaces:read', {})
    const actions = [...new Set(principal.grants.flatMap(grant => grant.actions))].sort()
    expect(actions).toEqual([...new Set(['workspaces:read', ...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])].sort())
    await authority.resolve(principal, 'workspace', CI_RUN_ACTIONS)
    await authority.resolve(principal, 'workspace', CI_GET_ACTIONS)
    expect(() => requireAuthorization(principal, 'settings:update', {})).toThrow()
    expect(() => requireAuthorization(principal, 'runs:start', { workspaceId: 'workspace' })).toThrow()
    if (outcome === 'failure') throw new Error('Smoke executor failed')
    return 'passed'
  })
  if (outcome === 'failure') await expect(smoke).rejects.toThrow('Smoke executor failed')
  else await expect(smoke).resolves.toBe('passed')
  await expect(access.authenticate(token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  const audit = (await database.pool.query<{ action: string; outcome: string; details: unknown }>(
    'select action, outcome, details from management_audit where target_key=$1 order by sequence',
    [`credential:${principalId}`],
  )).rows
  expect(audit.map(row => [row.action, row.outcome])).toEqual([
    ['credential.issue', 'succeeded'], ['credential.revoke', 'succeeded'],
  ])
  expect(JSON.stringify(audit)).not.toContain(token)
})
