import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { publishInstalledWorkerArtifacts, publishWorkerArtifactsToGitHub } from './worker-release-artifacts.mjs'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./worker-release-artifacts.mjs', import.meta.url))
const repositoryName = 'example/worker'
const commit = 'c'.repeat(40)

// A local gh executable persists release assets and can fail before or after storing an upload.
const githubStub = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
const args = process.argv.slice(2)
const path = process.env.ARTIFACT_TEST_STATE
const state = JSON.parse(readFileSync(path, 'utf8'))
const operation = args[0] === 'api' ? 'api' : args[1]
state.calls.push({ operation, args })
const save = () => writeFileSync(path, JSON.stringify(state))
const fail = message => { save(); console.error(message); process.exit(1) }
const apiReads = state.calls.filter(call => call.operation === 'api').length
const shouldFail = state.failure?.operation === operation && (!state.failed || state.failure.always)
  && apiReads > (state.failure.afterReads ?? -1)
if (shouldFail && !state.failure.afterUpload) {
  state.failed = true
  fail(state.failure.message)
}
if (operation === 'api') {
  if (!state.exists) fail('HTTP 404: release not found')
  const assets = Object.entries(state.assets).map(([name, bytes]) => ({ name,
    digest: 'sha256:' + createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex') }))
  console.log(JSON.stringify({ assets }))
}
if (operation === 'create') state.exists = true
if (operation === 'upload') {
  for (const asset of args.slice(3, args.indexOf('--repo'))) {
    const name = basename(asset)
    if (state.assets[name]) fail('HTTP 422: Validation Failed\\nReleaseAsset.name already exists')
    state.assets[name] = readFileSync(asset).toString('base64')
    if (state.failSecondUpload && Object.keys(state.assets).length === 2 && !state.failed) {
      delete state.assets[name]
      state.failed = true
      fail('HTTP 403: upload forbidden')
    }
  }
  if (shouldFail) {
    state.failed = true
    fail(state.failure.message)
  }
}
save()
`

async function fixture(t, overrides = {}) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-publication-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'gh'), githubStub, { mode: 0o700 })
  const artifacts = ['a', 'b', 'c', 'd'].map(letter => ({ manifestSha256: letter.repeat(64) }))
  for (const artifact of artifacts) {
    const source = join(directory, artifact.manifestSha256)
    await mkdir(source)
    await writeFile(join(source, 'worker.txt'), artifact.manifestSha256)
  }
  const statePath = join(directory, 'remote.json')
  await writeFile(statePath, JSON.stringify({ exists: true, assets: {}, calls: [], ...overrides }))
  await writeFile(join(directory, 'index.json'), JSON.stringify({ artifacts,
    publication: { state: 'pending', lastError: null } }))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACT_TEST_STATE: statePath }
  const run = (command, args, options) => execute(command, args, { ...options, env })
  const waits = []
  const options = { directory, name: repositoryName, commit, artifacts, run,
    sleep: async ms => { waits.push(ms) } }
  return { directory, artifacts, options, waits,
    remote: async () => JSON.parse(await readFile(statePath, 'utf8')),
    index: async () => JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')),
    cli: () => execute(process.execPath, [script, 'publish', directory, repositoryName, commit], { env }),
    publish: () => publishInstalledWorkerArtifacts({ directory, repositoryName, commit, run,
      publish: supplied => publishWorkerArtifactsToGitHub({ ...supplied, sleep: options.sleep }) }) }
}

test('publish CLI resumes a partial release and reuses verified assets without overwriting them', async t => {
  const f = await fixture(t, { failSecondUpload: true })
  await assert.rejects(f.cli(), /upload forbidden/)
  const partial = await f.remote()
  assert.equal(Object.keys(partial.assets).length, 1)
  assert.equal((await f.index()).publication.state, 'failed')
  const { stdout } = await f.cli()
  assert.match(stdout, /published and verified/)
  const remote = await f.remote()
  assert.deepEqual(remote.assets[`${f.artifacts[0].manifestSha256}.tar.gz`],
    partial.assets[`${f.artifacts[0].manifestSha256}.tar.gz`])
  const repeatedCalls = remote.calls.slice(partial.calls.length)
  const uploads = repeatedCalls.filter(call => call.operation === 'upload')
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].args.some(arg => arg.endsWith(`${f.artifacts[0].manifestSha256}.tar.gz`)), false)
  assert.equal(uploads[0].args.includes('--clobber'), false)
  assert.equal(Object.keys(remote.assets).length, f.artifacts.length)
  assert.deepEqual((await f.index()).github, { repository: repositoryName, tag: `worker-${commit}` })
  assert.deepEqual((await f.index()).publication, { state: 'published', lastError: null })
  const calls = remote.calls.length
  await f.cli()
  assert.equal((await f.remote()).calls.length, calls)
})

test('republication accepts identical bundle bytes after filesystem metadata changes', async t => {
  const f = await fixture(t)
  await publishWorkerArtifactsToGitHub(f.options)
  const first = await f.remote()
  for (const { manifestSha256 } of f.artifacts) {
    const directory = join(f.directory, manifestSha256)
    const file = join(directory, 'worker.txt')
    await chmod(file, 0o400)
    await utimes(file, 123456789, 123456789)
    await utimes(directory, 123456789, 123456789)
  }
  await publishWorkerArtifactsToGitHub(f.options)
  const second = await f.remote()
  assert.deepEqual(second.assets, first.assets)
  assert.equal(second.calls.filter(call => call.operation === 'upload').length, 1)
})

test('publish CLI retries connection reset by peer and records a verified publication', async t => {
  const f = await fixture(t, { failure: { operation: 'upload', afterUpload: true,
    message: 'read tcp: read: connection reset by peer' } })
  const { stdout, stderr } = await f.cli()
  assert.match(stdout, /published and verified/)
  assert.match(stderr, /nextRetryMs/)
  assert.equal((await f.index()).publication.state, 'published')
  const uploads = (await f.remote()).calls.filter(call => call.operation === 'upload')
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].args.slice(3, uploads[0].args.indexOf('--repo')).length, f.artifacts.length)
})

for (const failure of [{ operation: 'api' }, { operation: 'create' },
  { operation: 'upload', afterUpload: true }, { operation: 'api', afterReads: 1 }]) {
  test(`retries a transient ${failure.operation} failure after ${failure.afterReads ?? 0} reads`, async t => {
    const f = await fixture(t, { exists: failure.operation !== 'create', failure: { ...failure,
      message: 'read: connection reset by peer' } })
    const published = await f.publish()
    assert.equal(published.publication.state, 'published')
    assert.deepEqual(f.waits, [5000])
    assert.equal(Object.keys((await f.remote()).assets).length, f.artifacts.length)
    const uploads = (await f.remote()).calls.filter(call => call.operation === 'upload')
    assert.equal(uploads.length, 1)
  })
}

test('verifies and reuses an asset when an upload races with another publisher', async t => {
  const f = await fixture(t, { failure: { operation: 'upload', afterUpload: true,
    message: 'HTTP 422: Validation Failed\nReleaseAsset.name already exists' } })
  assert.equal((await f.publish()).publication.state, 'published')
  assert.deepEqual(f.waits, [5000])
  assert.equal((await f.remote()).calls.filter(call => call.operation === 'upload').length, 1)
})

test('rejects a mismatched existing asset without replacing it or advancing the target', async t => {
  const filename = `${'a'.repeat(64)}.tar.gz`
  const assets = { [filename]: Buffer.from('different bytes').toString('base64') }
  const f = await fixture(t, { assets })
  await assert.rejects(f.publish(), /checksum mismatch/)
  assert.deepEqual((await f.remote()).assets, assets)
  assert.equal((await f.remote()).calls.some(call => call.operation === 'upload'), false)
  assert.equal((await f.index()).github, undefined)
  assert.equal((await f.index()).publication.state, 'failed')
  assert.deepEqual(f.waits, [])
})

test('bounds network retries and retains the unpublished target after exhaustion', async t => {
  const f = await fixture(t, { failure: { operation: 'api', always: true,
    message: 'read: connection reset by peer' } })
  await assert.rejects(f.publish(), /connection reset by peer/)
  assert.deepEqual(f.waits, [5000, 10000, 20000, 25000])
  assert.equal((await f.remote()).calls.filter(call => call.operation === 'api').length, 5)
  assert.equal((await f.index()).github, undefined)
  assert.equal((await f.index()).publication.state, 'failed')
})

test('does not retry an unrelated validation failure', async t => {
  const f = await fixture(t, { failure: { operation: 'upload', message: 'HTTP 422: invalid asset' } })
  await assert.rejects(f.publish(), /invalid asset/)
  assert.deepEqual(f.waits, [])
  assert.equal((await f.index()).publication.state, 'failed')
})

test('uploads all missing assets in one call and verifies digests without downloading', async t => {
  const f = await fixture(t)
  await f.publish()
  const remote = await f.remote()
  assert.deepEqual(remote.calls.map(call => call.operation), ['api', 'upload', 'api'])
  for (const call of remote.calls.filter(call => call.operation === 'api')) {
    assert.deepEqual(call.args, ['api', `repos/${repositoryName}/releases/tags/worker-${commit}`])
  }
  const upload = remote.calls.find(call => call.operation === 'upload')
  assert.deepEqual(upload.args.slice(3, upload.args.indexOf('--repo')).map(path => path.split('/').at(-1)),
    f.artifacts.map(artifact => `${artifact.manifestSha256}.tar.gz`))
  assert.equal(upload.args.includes('--clobber'), false)
})
