import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as artifacts from './worker-release-artifacts.mjs'
import { apiServiceTemplate } from './local-production-runtime.mjs'
import { WorkerArtifactIndexSchema } from '../packages/contracts/dist/workerUpdate.js'

test('recovers an abandoned publication at startup and retains its recovery count', async t => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const release = await mkdtemp(join(cache, 'publication-recovery-'))
  t.after(() => rm(release, { recursive: true, force: true }))
  const directory = join(release, 'worker-artifacts')
  await mkdir(directory)
  const commit = 'a'.repeat(40)
  await writeFile(join(release, 'ci-smoke.json'), JSON.stringify({ commit, repository: 'example/project' }))
  const pending = { format: 1, version: '1.0.0', artifacts: [],
    publication: { state: 'pending', lastError: null, startedAt: '2026-10-01T00:00:00.000Z' } }
  assert.deepEqual(WorkerArtifactIndexSchema.parse(pending), pending)
  await writeFile(join(directory, 'index.json'), JSON.stringify(pending))
  let calls = 0
  const publish = async options => {
    calls++
    assert.equal(options.commit, commit)
    assert.equal(options.name, 'example/project')
    return { repository: 'example/project', tag: `worker-${commit}` }
  }
  await artifacts.recoverInstalledWorkerArtifacts({ release, publish })
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
  assert.equal(index.publication.state, 'published')
  assert.equal(index.publicationRecovery.abandonedAttempts, 1)
  assert.deepEqual(WorkerArtifactIndexSchema.parse(index), index)
  await artifacts.recoverInstalledWorkerArtifacts({ release, publish })
  assert.equal(calls, 1)
})

test('starts a persistent publication service with the API and retries publication failures', () => {
  const api = apiServiceTemplate('database.service')
  assert.match(api, /ExecStartPost=.*systemctl.*--no-block.*restart.*foreman-worker-publish.service/)
  const service = artifacts.workerPublicationServiceTemplate()
  assert.match(service, /ExecStart=@NODE@ .*worker-release-artifacts.mjs recover @APP@\/current/)
  assert.match(service, /Restart=on-failure/)
  assert.match(service, /RestartSec=60/)
})
