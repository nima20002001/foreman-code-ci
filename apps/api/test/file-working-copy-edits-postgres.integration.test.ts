import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileToolsMigration } from '../src/modules/files/tools/migration.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import type { ArtifactSnapshot, FileToolArtifact } from '../src/modules/files/tools/types.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `fil05b_${randomUUID().replaceAll('-', '')}`
const binding = 'a'.repeat(64), now = '2026-01-01T00:00:00.000Z'
function snapshot(artifactId: string, text = ''): ArtifactSnapshot {
  return { storageKey: randomUUID(), revision: { fileId: artifactId, revisionId: randomUUID(),
    filename: 'copy.md', mediaType: 'text/markdown', byteSize: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'), origin: 'agent_output', createdAt: now } }
}

describe.skipIf(!databaseUrl)('FIL-05b PostgreSQL snapshot guards', () => {
  let admin: pg.Pool | undefined, pool: pg.Pool | undefined
  let first: PostgresFileToolRepository, second: PostgresFileToolRepository
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/test/i.test(url.pathname)) throw new Error('Use an explicit loopback TEST_DATABASE_URL whose database name includes test.')
    admin = new pg.Pool({ connectionString: databaseUrl })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c statement_timeout=5000` })
    // Same minimal FIL-03 foreign-key boundary as file-tools-postgres.integration.test.ts.
    await pool.query(`create table files(file_id text primary key,owner_principal_id text not null,unique(file_id,owner_principal_id));
      create table file_revisions(revision_id text primary key,file_id text not null references files(file_id),unique(file_id,revision_id));
      create table file_allocations(owner_principal_id text not null,request_id text not null,file_id text not null,
        revision_id text not null,state text not null,primary key(owner_principal_id,request_id));`)
    await pool.query(fileToolsMigration.sql)
    first = new PostgresFileToolRepository(pool)
    second = new PostgresFileToolRepository(pool)
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await dropFixtureSchema(admin, schema) } finally { await admin.end() } }
  })
  async function copy(): Promise<FileToolArtifact & { snapshot: ArtifactSnapshot }> {
    const artifactId = randomUUID()
    const artifact = { artifactId, binding, writeId: randomUUID(), state: 'complete' as const,
      filename: 'copy.md', mediaType: 'text/markdown' as const, createdAt: now, snapshot: snapshot(artifactId) }
    await first.createArtifact(artifact)
    return artifact
  }

  it('lets only one independent writer acquire the same base revision', async () => {
    const artifact = await copy(), a = randomUUID(), b = randomUUID()
    const results = await Promise.all([
      first.beginWrite(binding, artifact.artifactId, a, artifact.snapshot.revision.revisionId),
      second.beginWrite(binding, artifact.artifactId, b, artifact.snapshot.revision.revisionId),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] ? a : b, loser = results[0] ? b : a
    const edited = snapshot(artifact.artifactId, 'winner')
    expect(await second.finishWrite(binding, artifact.artifactId, loser, snapshot(artifact.artifactId, 'loser'))).toBe(false)
    expect(await first.finishWrite(binding, artifact.artifactId, winner, edited)).toBe(true)
    expect((await second.artifact(binding, artifact.artifactId))?.snapshot).toEqual(edited)
  })

  it('rejects a stale snapshot after a competing commit and repository reconstruction, without starting a writer', async () => {
    const artifact = await copy(), writer = randomUUID()
    const observed = await first.artifact(binding, artifact.artifactId)
    expect(await second.beginWrite(binding, artifact.artifactId, writer, artifact.snapshot.revision.revisionId)).toBe(true)
    const edited = snapshot(artifact.artifactId, 'new bytes')
    expect(await second.finishWrite(binding, artifact.artifactId, writer, edited)).toBe(true)
    const restarted = new PostgresFileToolRepository(pool!)
    expect(await restarted.beginWrite(binding, artifact.artifactId, randomUUID(), observed!.snapshot!.revision.revisionId)).toBe(false)
    expect(await restarted.artifact(binding, artifact.artifactId)).toMatchObject({ state: 'complete', writeId: writer, snapshot: edited })
  })

  it('rejects a foreign binding even with exact artifact and revision IDs', async () => {
    const artifact = await copy()
    expect(await second.beginWrite('b'.repeat(64), artifact.artifactId, randomUUID(), artifact.snapshot.revision.revisionId)).toBe(false)
    expect(await first.artifact(binding, artifact.artifactId)).toEqual(artifact)
  })

  it('preserves legacy unguarded beginWrite and guarded recovery of a failed writer', async () => {
    const artifact = await copy(), abandoned = randomUUID()
    expect(await first.beginWrite(binding, artifact.artifactId, abandoned)).toBe(true)
    await first.failWrite(binding, artifact.artifactId, abandoned)
    const recovered = randomUUID()
    expect(await second.beginWrite(binding, artifact.artifactId, recovered, artifact.snapshot.revision.revisionId)).toBe(true)
    expect(await first.finishWrite(binding, artifact.artifactId, abandoned, snapshot(artifact.artifactId, 'stale'))).toBe(false)
    const complete = snapshot(artifact.artifactId, 'recovered')
    expect(await second.finishWrite(binding, artifact.artifactId, recovered, complete)).toBe(true)
    expect((await first.artifact(binding, artifact.artifactId))?.snapshot).toEqual(complete)
  })
})
