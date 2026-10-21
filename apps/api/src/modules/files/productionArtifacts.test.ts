import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { ApiConfig } from '../../config.js'
import type { TemporaryFileService } from './service.js'
import type { ArtifactPublicationAuthority, VerifiedArtifactReader } from './distributed/publication.js'
import type { AcceptedArtifactAttemptFence } from './distributed/authorization.js'
vi.mock('../../routes/files.js', () => ({ registerFileRoutes: vi.fn() }))
vi.mock('../../routes/fileReferences.js', () => ({ registerFileReferenceRoutes: vi.fn() }))
vi.mock('./tools/production.js', () => ({ registerProductionFileTools: vi.fn() }))
import { registerProductionFileStorage, createProductionDistributedArtifacts } from './production.js'
function ports() {
  // No hooks, database calls or native process are run by this composition test.
  const pool = {} as pg.Pool
  return { pool, mainId: randomUUID(), authority: {} as ArtifactPublicationAuthority,
    attempts: {} as AcceptedArtifactAttemptFence, transfers: {} as VerifiedArtifactReader }
}
it('requires the original registered production store', () => {
  expect(() => createProductionDistributedArtifacts({ ...ports(), files: {} as TemporaryFileService }))
    .toThrow('The original production file store is required.')
})
it('shares the original repository, bytes, authority and publication ledger with output and edge services', () => {
  const input = ports(), app = { decorate: vi.fn(), addHook: vi.fn(), log: { warn: vi.fn() } } as unknown as FastifyInstance
  const config = { fileStorageRoot: '/original/files', workspaceStorageRoot: '/original/projects',
    harnesses: { workspaceRoot: '/original/runtime' } } as ApiConfig
  const files = registerProductionFileStorage(app, input.pool, config)
  const mounted = createProductionDistributedArtifacts({ ...input, files })
  const store = files as unknown as { repository: unknown; bytes: unknown }
  expect(mounted.publications).toMatchObject({ files, authority: input.authority, transfers: input.transfers })
  expect(mounted.results).toMatchObject({ files, authority: input.authority,
    ledger: (mounted.publications as unknown as { ledger: unknown }).ledger })
  expect(mounted.edges).toMatchObject({ files: store.repository, bytes: store.bytes })
  expect(mounted.outputs).toMatchObject({ results: mounted.results, authority: input.authority, edges: mounted.edges })
  expect(app.addHook).toHaveBeenCalledTimes(2)
})
