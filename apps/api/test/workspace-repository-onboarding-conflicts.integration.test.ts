import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { REPOSITORY_ADD_ACTIONS } from '../src/modules/workspaces/repositoryService.js'
import { fixtureGit, workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, httpAdd, add, get, clones } from './helpers/workspaceRepositoryOnboarding.js'

describe('workspace repository onboarding: conflicts', () => {
  it('rejects a substituted published clone origin on retry and preserves its files', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(new Error('Capture interrupted before approval'))
      expect((await httpAdd(f, input)).status).toBe(500)
      const partial = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      const location = partial.location!
      if (location.evidence !== 'bound') throw new Error('Expected a published project.')
      fixtureGit(location.executionLocation.rootPath, 'config', '--local', 'remote.origin.url', 'https://github.com/other/site.git')
      const fetched = f.gitCalls.filter(args => args.includes('fetch')).length
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'REPOSITORY_ORIGIN_CHANGED', newCommandRequired: true } } })
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      expect(f.gitCalls.filter(args => args.includes('fetch'))).toHaveLength(fetched)
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('rechecks revoked grants between phases and resumes the same journal after grants are restored', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const update = f.services.workspaces.update.bind(f.services.workspaces)
      vi.spyOn(f.services.workspaces, 'update').mockImplementationOnce(async (...args) => {
        const saved = await update(...args)
        await f.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.owner.principal.id,
          JSON.stringify([{ actions: REPOSITORY_ADD_ACTIONS.filter(action => action !== 'sources:approve'), scope: {} }])])
        return saved
      })
      expect((await httpAdd(f, input)).status).toBe(403)
      const failed = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      expect(failed).toMatchObject({ state: 'failed', operation: { phase: 'metadata', failure: { code: 'ACCESS_DENIED' } } })
      await f.pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [f.owner.principal.id, JSON.stringify([{ actions: [...ManagementActionSchema.options], scope: {} }])])
      expect((await add(f, input)).value.state).toBe('ready')
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('persists a numeric process exit as a string failure and supports the same-command retry', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const processError = Object.assign(new Error('Git inspection exited unsuccessfully'), { code: 128 })
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(processError)
      expect((await httpAdd(f, input)).status).toBe(500)
      f.services.workspaceRepositories = f.recreate()
      const failed = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      expect(failed).toMatchObject({ state: 'failed', operation: { retryInput: input,
        failure: { code: 'INTERNAL_ERROR', message: processError.message, retryable: true, newCommandRequired: false } } })
      expect((await add(f, input)).value.state).toBe('ready')
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('treats a missing Git origin as a persisted repository conflict', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(new Error('Capture interrupted before approval'))
      expect((await httpAdd(f, input)).status).toBe(500)
      const partial = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      const location = partial.location!
      if (location.evidence !== 'bound') throw new Error('Expected a published project.')
      fixtureGit(location.executionLocation.rootPath, 'config', '--local', '--unset-all', 'remote.origin.url')
      expect((await httpAdd(f, input)).status).toBe(409)
      f.services.workspaceRepositories = f.recreate()
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'REPOSITORY_ORIGIN_CHANGED', newCommandRequired: true, retryable: false } } })
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)


})
