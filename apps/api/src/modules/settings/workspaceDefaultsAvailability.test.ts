import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { DEFAULT_WORKSPACE_DEFAULTS } from '@foreman-code/contracts/management'
import { PostgresFoundationSettingsRepository } from './foundation.js'

vi.mock('node:fs/promises', () => ({ realpath: vi.fn(async (path: string) => {
  if (path === '/fixture/missing-storage') throw Object.assign(new Error('Storage unavailable'), { code: 'ENOENT' })
  return path
}) }))

it('reports an unavailable saved parent instead of replacing it with the project root', async () => {
  const record = { ...DEFAULT_WORKSPACE_DEFAULTS, parentPath: '/fixture/missing-storage' }
  const query = vi.fn(async () => ({ rows: [{ record, revision: '7', current_version_id: 'saved-version' }] }))
  const repository = new PostgresFoundationSettingsRepository({ query } as unknown as pg.Pool, '/fixture/project')
  await expect(repository.getWorkspaceDefaults()).rejects.toMatchObject({
    code: 'WORKSPACE_DEFAULT_UNAVAILABLE', status: 503,
    details: { parentPath: record.parentPath, revision: 7, versionId: 'saved-version' },
  })
  expect(record.parentPath).toBe('/fixture/missing-storage')
  expect(query).toHaveBeenCalledOnce()
})

it('uses the project root when no parent setting was saved', async () => {
  const query = vi.fn(async () => ({ rows: [] }))
  const repository = new PostgresFoundationSettingsRepository({ query } as unknown as pg.Pool, '/fixture/project')
  expect(await repository.getWorkspaceDefaults()).toMatchObject({
    value: { parentPath: '/fixture/project' }, revision: 0, versionId: null,
  })
})
