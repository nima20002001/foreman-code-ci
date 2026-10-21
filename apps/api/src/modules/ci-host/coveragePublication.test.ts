import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it('reuses the coverage snapshot prepared before the cloud start', async () => {
  const f = await fixture()
  const integrationCoverage = { changedFiles: [], map: gzipSync(JSON.stringify({
    version: 1, commit: f.commit, testFiles: ['apps/api/test/a.integration.test.ts'],
    coverage: { 'apps/api/test/a.integration.test.ts': [] },
  })).toString('base64') }
  const calls = vi.spyOn(f.git, 'git')
  await f.cloud.publishMirror({ repository: 'octo/site', mirror: 'octo/site-ci', commit: f.commit,
    defaultBranch: 'main', durations: {}, integrationCoverage })
  await f.cloud.handle({ operation: 'start', runId: randomUUID(), workspaceId: 'ci-workspace',
    repository: 'octo/site', ciMirror: 'octo/site-ci', commit: f.commit, suite: 'integration', scope: 'affected',
    defaultBranch: 'main', durations: {}, integrationCoverage })
  const pushes = calls.mock.calls.filter(([args]) => args[0] === 'push'
    && args.some(argument => argument.endsWith(`:refs/heads/ci/${f.commit}`)))
  expect(pushes).toHaveLength(1)
  const checkout = await f.checkoutMirror(`ci/${f.commit}`)
  expect(JSON.parse(await readFile(join(checkout, 'ci-integration-coverage.json'), 'utf8'))).toEqual(integrationCoverage)
})
