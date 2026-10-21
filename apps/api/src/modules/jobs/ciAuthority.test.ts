import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import * as credentials from '../interactions/wave25/credentialAuthority.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { DomainError } from '../errors.js'
import { CI_RUN_ACTIONS, RunCiAuthority } from './ciAuthority.js'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const ci = ciFixture()
  const readingAuthority = deferred()
  const admitted = deferred()
  let bindingLocked = false
  let live = true
  vi.spyOn(credentials, 'assertWave25WorkerBinding').mockImplementation(async () => {
    if (!live) throw new DomainError('AUTH_REVOKED', 'Worker credential revoked.', 403)
  })
  const sql = { async query(text: string) {
    if (text === 'commit' || text === 'rollback') bindingLocked = false
    if (text.startsWith('select r.id')) throw new Error('CI authority queued behind the Run writer.')
    if (text.includes('as authorization_principal_id')) {
      if (text.includes('for share of b')) bindingLocked = true
      if (text.includes('for share of b,r')) throw new Error('CI authority queued behind the Run writer.')
      return { rows: live ? [{ workspace_id: ci.workspaceId, workflow_id: 'workflow', run_id: 'run',
        execution_id: 'execution', authorization_principal_id: ci.operator.id }] : [] }
    }
    if (text.includes('from management_principals')) {
      readingAuthority.resolve()
      await admitted.promise
      return { rows: [{ ...ci.operator, audience: 'operator',
        expires_at: new Date(ci.operator.expiresAt), revoked_at: null, delegated_from: null }] }
    }
    return { rows: [] }
  }, release() {} }
  const pool = { connect: async () => sql } as unknown as pg.Pool
  const admitCredentials = async () => {
    if (bindingLocked) throw Object.assign(new Error('Credential admission deadlocked with CI read.'), { code: '40P01' })
    admitted.resolve()
  }
  return { ci, authority: new RunCiAuthority(pool), admitCredentials, readingAuthority: readingAuthority.promise,
    release: () => admitted.resolve(),
    revoke: () => { live = false } }
}

it('allows a CI run and Run-first credential admission to finish concurrently', async () => {
  const f = fixture()
  const pending = f.authority.resolve(f.ci.worker, undefined, CI_RUN_ACTIONS)
  try {
    await f.readingAuthority
    await f.admitCredentials()
    expect(await pending).toMatchObject({ workspaceId: f.ci.workspaceId, principal: { id: f.ci.operator.id },
      executionId: 'execution', initiatingAgent: { runId: 'run', executionId: 'execution' } })
  } finally {
    f.release()
    await Promise.allSettled([pending])
  }
})

it('denies a binding revoked before the CI authority snapshot', async () => {
  const f = fixture()
  f.revoke()
  await expect(f.authority.resolve(f.ci.worker, undefined, CI_RUN_ACTIONS))
    .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
})
