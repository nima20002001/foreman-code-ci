import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BrowserProfileSchema, BrowserProfileSyncJobSchema } from '@foreman-code/contracts/browser-profiles'
import { browserProfilesMigration } from '../src/infrastructure/browserProfilesMigration.js'
import { createBrowserProfileRepository } from '../src/modules/browser-profiles/repository.js'
import { endpointFixture } from '../src/modules/browser-runtime/endpoints.test-support.js'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl } from './helpers/testResources.js'

let admin: pg.Pool
let pool: pg.Pool
let schema: string
const fixtures: Awaited<ReturnType<typeof endpointFixture>>[] = []

beforeEach(async () => {
  const connectionString = ownedTestDatabaseUrl()
  admin = new pg.Pool({ connectionString, max: 1 })
  schema = `browser_profiles_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 })
  await pool.query(browserProfilesMigration.sql)
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  await pool?.end()
  if (admin) {
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
  vi.restoreAllMocks()
})

async function fixture(computers = [{ id: 'main', online: true }, { id: 'replica', online: true }]) {
  const value = await endpointFixture({ repository: createBrowserProfileRepository(pool), computers })
  fixtures.push(value)
  return value
}

it('paginates every authorized computer and persists MCP profile edits while denying read-only writes', async () => {
  const f = await fixture()
  const client = await f.connect()
  const input = { name: 'Shared sign-in', computerId: 'main', commandId: 'create' }
  const created = await client.callTool({ name: 'browser_profile_create', arguments: f.reference('browser_profile_create', input) })
  expect(created.isError).not.toBe(true)
  const profile = BrowserProfileSchema.parse((decodeMcpToolResult(created) as { value: unknown }).value)
  const first = await client.callTool({ name: 'browser_profiles_list', arguments: f.reference('browser_profiles_list', { limit: 1 }) })
  expect(first.isError).not.toBe(true)
  const page = decodeMcpToolResult(first) as { profiles: unknown[]; nextCursor: string | null }
  expect(page.profiles).toEqual([profile])
  expect(page.nextCursor).toEqual(expect.any(String))
  const second = await client.callTool({ name: 'browser_profiles_list', arguments: f.reference('browser_profiles_list', {
    limit: 1, cursor: page.nextCursor!,
  }) })
  expect(decodeMcpToolResult(second)).toMatchObject({ profiles: [profile], replicas: [], nextCursor: null })

  f.addCaller('reader', { readOnly: true })
  const reader = await f.connect('reader')
  const update = { intent: 'metadata' as const, profileId: profile.id, patch: { name: 'Renamed' } }
  await expect(reader.callTool({ name: 'browser_profile_update', arguments: f.reference('browser_profile_update', update) }))
    .rejects.toMatchObject({ message: 'Tool browser_profile_update not found' })
  expect((await f.profiles.get(f.owner, profile.id)).profile).toEqual(profile)
  const saved = await client.callTool({ name: 'browser_profile_update', arguments: f.reference('browser_profile_update', update) })
  expect(saved.isError).not.toBe(true)
  const replacement = await fixture()
  expect((await replacement.profiles.get(replacement.owner, profile.id)).profile)
    .toMatchObject({ name: 'Renamed', revision: profile.revision + 1 })
})

it('returns no catalog rows when none of the computers are visible', async () => {
  const f = await fixture()
  await f.profiles.create(f.owner, { name: 'Shared sign-in', computerId: 'main' })
  const hidden = await fixture([])
  const client = await hidden.connect()
  const result = await client.callTool({ name: 'browser_profiles_list', arguments: hidden.reference('browser_profiles_list', {}) })
  expect(result.isError).not.toBe(true)
  expect(decodeMcpToolResult(result)).toMatchObject({ profiles: [], replicas: [], nextCursor: null })
})

it('persists a completed one-computer sync with an explained source exclusion and replay', async () => {
  const f = await fixture([{ id: 'main', online: true }])
  const created = await f.profiles.create(f.owner, { name: 'Shared sign-in', computerId: 'main' })
  const client = await f.connect()
  const input = { profileIds: [created.value.id], commandId: 'sync' }
  const result = await client.callTool({ name: 'browser_profiles_sync', arguments: f.reference('browser_profiles_sync', input) })
  expect(result.isError).not.toBe(true)
  const job = BrowserProfileSyncJobSchema.parse((decodeMcpToolResult(result) as { value: unknown }).value)
  expect(job).toMatchObject({ state: 'completed', profiles: [{ state: 'excluded', reason: expect.any(String) }],
    targets: [{ state: 'excluded', exclusion: 'source' }] })
  const replay = await client.callTool({ name: 'browser_profiles_sync', arguments: f.reference('browser_profiles_sync', input) })
  expect(decodeMcpToolResult(replay)).toMatchObject({ replayed: true, value: job })
  const read = await client.callTool({ name: 'browser_profile_sync_get', arguments: f.reference('browser_profile_sync_get', { jobId: job.id }) })
  expect(decodeMcpToolResult(read)).toMatchObject({ job })
})
