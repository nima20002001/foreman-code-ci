import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildWorkerReleaseArtifacts, publishInstalledWorkerArtifacts, publishWorkerArtifactsToGitHub,
  readCommittedWorkerTargets, runWorkerPublicationCommand, workerPublicationServiceTemplate } from './worker-release-artifacts.mjs'
import { WorkerArtifactIndexSchema } from '../packages/contracts/src/workerUpdate.ts'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }

test('persists the publication deadline as soon as built artifacts become pending', async t => {
  const f = await fixture(t)
  const before = Date.now()
  await buildWorkerReleaseArtifacts(f)
  const after = Date.now()
  const index = WorkerArtifactIndexSchema.parse(JSON.parse(await readFile(join(f.directory, 'index.json'), 'utf8')))
  assert.equal(index.publication.state, 'pending')
  const startedAt = Date.parse(index.publication.startedAt)
  assert.ok(startedAt >= before && startedAt <= after)
  assert.equal(Date.parse(index.publication.deadlineAt), startedAt + 2 * 60 * 60_000)
  let attempted = false
  await assert.rejects(publishInstalledWorkerArtifacts({ directory: f.directory,
    repositoryName: 'example/worker', commit: f.commit, publish: async () => {
      attempted = true
      const pending = JSON.parse(await readFile(join(f.directory, 'index.json'), 'utf8')).publication
      assert.equal(pending.startedAt, index.publication.startedAt)
      assert.equal(pending.deadlineAt, index.publication.deadlineAt)
      throw new Error('Publication unavailable')
    } }), /Publication unavailable/)
  assert.equal(attempted, true)
})

test('a hung publication command persists its timeout and a retry time, then recovers', async t => {
  const f = await fixture(t)
  await buildWorkerReleaseArtifacts(f)
  const bin = join(f.repository, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
process.on('SIGTERM', () => {})
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(join(f.repository, 'orphan'))}, 'still running'), 400); setTimeout(() => process.exit(0), 800);`
  )}], { stdio: 'inherit' })
setTimeout(() => process.exit(9), 800)
setInterval(() => {}, 100)
`, { mode: 0o700 })
  const timers = 'const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms >= 1000 ? 100 : ms, ...args);'
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(timers)}`,
    new URL('./worker-release-artifacts.mjs', import.meta.url).pathname, 'publish', f.directory,
    'example/worker', f.commit], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  assert.equal(await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }), 1)
  const retained = WorkerArtifactIndexSchema.parse(JSON.parse(await readFile(join(f.directory, 'index.json'))))
  assert.equal(retained.publication.state, 'failed')
  assert.match(retained.publication.lastError, /WORKER_PUBLICATION_COMMAND_DEADLINE_EXCEEDED/)
  assert.ok(Date.parse(retained.publication.nextRetryAt) > Date.now())
  assert.equal(retained.github, undefined)
  await assert.rejects(stat(join(f.repository, 'orphan')), { code: 'ENOENT' })
  const github = { repository: 'example/worker', tag: `worker-${f.commit}` }
  const recovered = await publishInstalledWorkerArtifacts({ directory: f.directory,
    repositoryName: 'example/worker', commit: f.commit, run: f.run, publish: async () => github })
  assert.deepEqual(recovered.github, github)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'index.json'))).publication.state, 'published')
})

test('publication timeout kills TERM-ignoring parent and descendant before completing', async t => {
  const root = await mkdtemp(join(homedir(), '.cache', 'foreman-tmp', 'publication-processes-'))
  const pids = join(root, 'pids.json')
  t.after(async () => {
    try {
      for (const pid of JSON.parse(await readFile(pids, 'utf8'))) {
        try { process.kill(pid, 'SIGKILL') }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  const descendant = `process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.ppid, process.pid]));
    setInterval(() => {}, 100);`
  const parent = `process.on('SIGTERM', () => {});
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'});
    setInterval(() => {}, 100);`
  await assert.rejects(runWorkerPublicationCommand(process.execPath, ['-e', parent],
    { timeoutMs: 1000, killGraceMs: 100 }), /WORKER_PUBLICATION_COMMAND_DEADLINE_EXCEEDED/)
  const processes = JSON.parse(await readFile(pids, 'utf8'))
  assert.equal(processes.length, 2)
  for (const pid of processes) {
    try {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8')
      assert.equal(status.slice(status.lastIndexOf(') ') + 2).split(' ')[0], 'Z')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
})

test('publication unit timeouts retain a failure and restart after a bounded delay', async t => {
  const f = await fixture(t)
  await buildWorkerReleaseArtifacts(f)
  const unit = workerPublicationServiceTemplate()
  const runtime = Number(/^RuntimeMaxSec=(\d+)$/m.exec(unit)?.[1])
  assert.ok(runtime > 0 && runtime <= 1800)
  assert.match(unit, /^TimeoutStopSec=\d+$/m)
  assert.match(unit, /^Restart=on-failure$/m)
  assert.match(unit, /^RestartSec=60$/m)
  const child = spawn(process.execPath, [new URL('./worker-release-artifacts.mjs', import.meta.url).pathname,
    'stopped', f.repository], { env: { ...process.env, SERVICE_RESULT: 'timeout' }, stdio: 'ignore' })
  assert.equal(await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }), 0)
  const retained = WorkerArtifactIndexSchema.parse(JSON.parse(await readFile(join(f.directory, 'index.json'))))
  assert.equal(retained.publication.state, 'failed')
  assert.match(retained.publication.lastError, /DEADLINE_EXCEEDED/)
  assert.ok(Date.parse(retained.publication.nextRetryAt) > Date.now())
})

test('does not publish the target until every GitHub asset digest is verified', async t => {
  const f = await fixture(t)
  const original = await buildWorkerReleaseArtifacts(f)
  let reads = 0
  const waits = []
  const run = async (command, args) => {
    if (command === 'tar') execFileSync(command, args)
    if (command === 'gh' && args[0] === 'api') {
      reads++
      assert.equal(JSON.parse(await readFile(join(f.directory, 'index.json'))).github, undefined)
      return { stdout: JSON.stringify({ assets: [] }) }
    }
  }
  const publish = options => publishWorkerArtifactsToGitHub({ ...options, run, sleep: async delay => { waits.push(delay) } })
  await assert.rejects(publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/worker',
    commit: f.commit, run, publish }), /GitHub Worker asset not found/)
  assert.equal(reads, 10)
  assert.deepEqual(waits, [5000, 10000, 20000, 25000])
  const retained = JSON.parse(await readFile(join(f.directory, 'index.json')))
  assert.equal(retained.github, undefined)
  assert.deepEqual(retained.artifacts, original.artifacts)
  assert.equal(retained.publication.state, 'failed')
  assert.match(retained.publication.lastError, /GitHub Worker asset not found/)
})

test('rejects a GitHub asset with different bytes after a successful upload', async t => {
  const f = await fixture(t)
  await buildWorkerReleaseArtifacts(f)
  let uploaded = false
  const waits = []
  const calls = []
  const run = async (command, args) => {
    if (command === 'tar') execFileSync(command, args)
    if (command === 'gh') calls.push(args[0] === 'api' ? 'api' : args[1])
    if (command === 'gh' && args[1] === 'upload') uploaded = true
    if (command === 'gh' && args[0] === 'api') {
      const artifacts = JSON.parse(await readFile(join(f.directory, 'index.json'))).artifacts
      const assets = uploaded ? artifacts.map(artifact => ({ name: `${artifact.manifestSha256}.tar.gz`,
        digest: `sha256:${sha256('corrupted archive')}` })) : []
      return { stdout: JSON.stringify({ assets }) }
    }
  }
  await assert.rejects(publishWorkerArtifactsToGitHub({ name: 'example/worker', directory: f.directory,
    commit: f.commit, artifacts: JSON.parse(await readFile(join(f.directory, 'index.json'))).artifacts,
    run, sleep: async delay => { waits.push(delay) } }), /GitHub Worker asset checksum mismatch/)
  assert.deepEqual(waits, [])
  assert.deepEqual(calls, ['api', 'upload', 'api'])
})

test('retries asset upload when an existing empty release is not yet visible', async t => {
  const f = await fixture(t)
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
  await mkdir(f.directory)
  const manifestSha256 = 'a'.repeat(64)
  const calls = []
  const waits = []
  let uploads = 0
  const simulate = assetSimulator()
  const run = async (command, args) => {
    calls.push({ command, args })
    if (command === 'gh' && args[1] === 'upload' && ++uploads === 1) {
      throw new Error('release not found')
    }
    return simulate(command, args)
  }
  const result = await publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256 }], run,
    sleep: async milliseconds => { waits.push(milliseconds) } })
  assert.deepEqual(result, { repository: 'example/worker', tag: `worker-${f.commit}` })
  assert.equal(uploads, 2)
  assert.deepEqual(waits, [5000])
  assert.equal(calls.filter(call => call.command === 'tar').length, 1)
  assert.equal(calls.filter(call => call.command === 'gh' && call.args[1] === 'create').length, 0)
  const upload = calls.find(call => call.command === 'gh' && call.args[1] === 'upload')
  assert.equal(upload.args.includes('--clobber'), false)
  await assert.rejects(stat(upload.args[3]), { code: 'ENOENT' })
})

for (const failure of ['api', 'create', 'upload']) {
  test(`recovers a created release after a temporary ${failure} failure`, async t => {
    const f = await fixture(t)
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
    await mkdir(f.directory)
    const calls = []
    const waits = []
    let exists = failure === 'api'
    let failed = false
    const simulate = assetSimulator()
    const run = async (command, args) => {
      if (command !== 'gh') return simulate(command, args)
      const operation = args[0] === 'api' ? 'api' : args[1]
      calls.push(operation)
      if (operation === failure && !failed) {
        failed = true
        if (operation === 'create') exists = true
        throw new Error('connection reset by peer')
      }
      if (operation === 'api' && !exists) throw new Error('HTTP 404: release not found')
      if (operation === 'create') {
        if (exists) throw new Error('release already exists')
        exists = true
        assert.equal(args.some(arg => arg.endsWith('.tar.gz')), false)
      }
      return simulate(command, args)
    }
    const result = await publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
      sleep: async milliseconds => { waits.push(milliseconds) } })
    assert.equal(result.tag, `worker-${f.commit}`)
    assert.deepEqual(waits, [5000])
    const expectedCalls = {
      api: ['api', 'api', 'upload', 'api'],
      create: ['api', 'create', 'api', 'upload', 'api'],
      upload: ['api', 'create', 'upload', 'api', 'upload', 'api'],
    }
    assert.deepEqual(calls, expectedCalls[failure])
  })
}

test('stops retrying after one minute of backoff and cleans up staged assets', async t => {
  const f = await fixture(t)
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
  await mkdir(f.directory)
  const error = new Error('release not found')
  const waits = []
  let uploads = 0
  let asset
  const simulate = assetSimulator()
  const run = async (command, args) => {
    if (command === 'gh' && args[1] === 'upload') {
      uploads++
      asset = args[3]
      throw error
    }
    return simulate(command, args)
  }
  await assert.rejects(publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
    sleep: async milliseconds => { waits.push(milliseconds) } }), thrown => thrown === error)
  assert.equal(uploads, 5)
  assert.deepEqual(waits, [5000, 10000, 20000, 25000])
  await assert.rejects(stat(asset), { code: 'ENOENT' })
})

function assetSimulator() {
  const assets = new Map()
  return async (command, args) => {
    if (command === 'tar') await writeFile(args[1], 'archive')
    if (command === 'gh' && args[1] === 'upload') {
      for (const path of args.slice(3, args.indexOf('--repo'))) {
        assets.set(path.slice(path.lastIndexOf('/') + 1), await readFile(path))
      }
    }
    if (command === 'gh' && args[0] === 'api') {
      const releaseAssets = [...assets].map(([name, bytes]) => ({ name, digest: `sha256:${sha256(bytes)}` }))
      return { stdout: JSON.stringify({ assets: releaseAssets }) }
    }
  }
}

async function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const repository = await mkdtemp(join(cache, 'worker-release-artifacts-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  await mkdir(join(repository, 'apps/worker/artifacts'), { recursive: true })
  await mkdir(join(repository, 'apps/api'), { recursive: true })
  await mkdir(join(repository, 'apps/worker/src'), { recursive: true })
  await mkdir(join(repository, 'scripts'), { recursive: true })
  await writeFile(join(repository, 'apps/worker/src/cli.mjs'), 'export const worker = true\n')
  await writeFile(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(repository, 'scripts/build-worker-artifact.mjs'), '// artifact builder\n')
  await writeFile(join(repository, 'package.json'), JSON.stringify({ version: '0.0.57', packageManager: 'pnpm@11.27.0' }))
  await writeFile(join(repository, 'apps/api/package.json'), JSON.stringify({ version: '0.1.0' }))
  const targets = [target, { ...target, node: 'v22.23.2' },
    { ...target, osRelease: '26.04', libc: 'glibc-2.43' },
    { ...target, osRelease: '26.04', libc: 'glibc-2.43', node: 'v22.23.2' }]
  for (const [index, value] of targets.entries()) {
    await writeFile(join(repository, `apps/worker/artifacts/ubuntu-${index}-target.json`), JSON.stringify(value))
  }
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.invalid', 'commit', '-qm', 'reviewed targets'])
  const commit = git(['rev-parse', 'HEAD']).toString().trim()
  const directory = join(repository, 'worker-artifacts')
  const productManifestPath = join(repository, 'installed-product.json')
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, commit: options.env.FOREMAN_CODE_WORKER_BUILD_COMMIT })
    const selected = JSON.parse(git(['show', `${options.env.FOREMAN_CODE_WORKER_BUILD_COMMIT}:${args[1]}`]))
    const output = args[2]
    await mkdir(join(output, 'src'), { recursive: true, mode: 0o700 })
    const bytes = Buffer.from('export const worker = true\n')
    await writeFile(join(output, 'src/cli.mjs'), bytes)
    const buildCommit = options.env.FOREMAN_CODE_WORKER_BUILD_COMMIT
    const product = JSON.parse(git(['show', `${buildCommit}:package.json`]))
    const manifest = { format: 1, version: product.version, commit: buildCommit, lockfileSha256: 'b'.repeat(64),
      packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target: selected,
      sourceSnapshot: { commit: buildCommit, files: ['package.json', 'pnpm-lock.yaml',
        'scripts/build-worker-artifact.mjs', 'apps/worker/src/cli.mjs', args[1]].map(path => ({ path,
        gitBlobSha1: git(['rev-parse', `${buildCommit}:${path}`]).toString().trim(),
        sha256: sha256(git(['show', `${buildCommit}:${path}`])) })) },
      files: [{ path: 'src/cli.mjs', sha256: sha256(bytes), size: bytes.length }] }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { repository, commit, directory, productManifestPath, run, calls }
}

function commitFixture(repository) {
  execFileSync('git', ['add', '-u'], { cwd: repository })
  execFileSync('git', ['add', 'apps/api'], { cwd: repository })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'update build inputs'], { cwd: repository })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
}

function laterBuild(f) {
  return { ...f, previousDirectory: f.directory, directory: join(f.repository, 'later-artifacts'),
    productManifestPath: join(f.repository, 'later-product.json') }
}

test('reuses verified Worker payloads across unrelated API changes with release provenance in the index', async t => {
  const f = await fixture(t)
  const first = await buildWorkerReleaseArtifacts(f)
  await writeFile(join(f.repository, 'apps/api/unrelated.ts'), 'export const api = true\n')
  const commit = commitFixture(f.repository)
  const next = laterBuild(f)
  const second = await buildWorkerReleaseArtifacts({ ...next, expectedCommit: commit })
  assert.equal(f.calls.length, 4, 'unchanged snapshots must not invoke the artifact builder')
  assert.equal(second.commit, commit)
  for (const [index, artifact] of second.artifacts.entries()) {
    assert.equal(artifact.contentSha256, first.artifacts[index].contentSha256)
    assert.equal(artifact.manifestSha256, first.artifacts[index].manifestSha256)
    const manifest = JSON.parse(await readFile(join(next.directory, artifact.manifestSha256, 'manifest.json')))
    assert.equal(manifest.commit, f.commit)
    assert.equal(manifest.sourceSnapshot.commit, f.commit)
    assert.equal(sha256(await readFile(join(next.directory, artifact.manifestSha256, 'manifest.json'))), artifact.manifestSha256)
  }
  assert.equal(second.github, undefined)
  assert.equal(second.publication.state, 'pending')
})

test('retains verified GitHub references without publishing or downloading unchanged bundles', async t => {
  const f = await fixture(t)
  const github = { repository: 'example/worker', tag: `worker-${f.commit}` }
  const first = await buildWorkerReleaseArtifacts({ ...f, publish: async () => github })
  await writeFile(join(f.repository, 'apps/api/unrelated.ts'), 'export const api = true\n')
  commitFixture(f.repository)
  const next = laterBuild(f)
  const publish = async () => assert.fail('Unchanged bundles must retain their verified GitHub publication')
  const second = await buildWorkerReleaseArtifacts({ ...next, publish })
  assert.equal(second.publication.state, 'published')
  assert.deepEqual(second.github, github)
  assert.deepEqual(second.artifacts.map(artifact => artifact.manifestSha256),
    first.artifacts.map(artifact => artifact.manifestSha256))
  await publishInstalledWorkerArtifacts({ directory: next.directory, repositoryName: github.repository,
    commit: second.commit, publish })
})

test('publishes only the changed target when other targets have verified GitHub bundles', async t => {
  const f = await fixture(t)
  const github = { repository: 'example/worker', tag: `worker-${f.commit}` }
  const first = await buildWorkerReleaseArtifacts({ ...f, publish: async () => github })
  await writeFile(join(f.repository, 'apps/worker/artifacts/ubuntu-0-target.json'),
    JSON.stringify({ ...target, node: 'v22.23.4' }))
  const commit = commitFixture(f.repository)
  const calls = []
  const next = laterBuild(f)
  const second = await buildWorkerReleaseArtifacts({ ...next, publish: async options => {
    calls.push(options)
    return { ...github, tag: `worker-${commit}` }
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].artifacts.length, 1)
  assert.equal(calls[0].artifacts[0].target.node, 'v22.23.4')
  for (let index = 1; index < second.artifacts.length; index++) {
    assert.equal(second.artifacts[index].manifestSha256, first.artifacts[index].manifestSha256)
    assert.deepEqual(second.artifacts[index].github, github)
  }
})

test('reuses Worker builds across product version bumps but rebuilds for other manifest changes', async t => {
  const f = await fixture(t)
  const first = await buildWorkerReleaseArtifacts(f)
  const product = { version: '0.0.58', packageManager: 'pnpm@11.27.0' }
  await writeFile(join(f.repository, 'package.json'), JSON.stringify(product, null, 2))
  const commit = commitFixture(f.repository)
  const next = laterBuild(f)
  const second = await buildWorkerReleaseArtifacts(next)
  assert.equal(f.calls.length, 4, 'a product version bump must not rebuild Worker payloads')
  assert.equal(second.version, '0.0.58')
  assert.equal(second.commit, commit)
  assert.deepEqual(second.artifacts, first.artifacts)
  await writeFile(join(f.repository, 'package.json'), JSON.stringify({ ...product, engines: { node: '>=22' } }))
  commitFixture(f.repository)
  await buildWorkerReleaseArtifacts({ ...next, previousDirectory: next.directory,
    directory: join(f.repository, 'third-artifacts'), productManifestPath: join(f.repository, 'third-product.json') })
  assert.equal(f.calls.length, 8, 'other root manifest changes must invalidate reuse')
})

for (const input of ['apps/worker/src/cli.mjs', 'scripts/build-worker-artifact.mjs', 'pnpm-lock.yaml']) {
  test(`rebuilds Worker artifacts when snapshotted input ${input} changes`, async t => {
    const f = await fixture(t)
    await buildWorkerReleaseArtifacts(f)
    await writeFile(join(f.repository, input), 'changed input\n')
    commitFixture(f.repository)
    await buildWorkerReleaseArtifacts(laterBuild(f))
    assert.equal(f.calls.length, 8)
  })
}

test('a changed target rebuilds only that target and corrupted payloads are rebuilt', async t => {
  const f = await fixture(t)
  const first = await buildWorkerReleaseArtifacts(f)
  await writeFile(join(f.repository, 'apps/worker/artifacts/ubuntu-0-target.json'),
    JSON.stringify({ ...target, node: 'v22.23.4' }))
  await writeFile(join(f.directory, first.artifacts[1].manifestSha256, 'src/cli.mjs'), 'corrupted')
  commitFixture(f.repository)
  const next = laterBuild(f)
  const second = await buildWorkerReleaseArtifacts(next)
  assert.equal(f.calls.length, 6)
  assert.equal(second.artifacts[0].target.node, 'v22.23.4')
  assert.equal(second.artifacts[1].contentSha256, first.artifacts[1].contentSha256)
})

test('two builds differing only by commit publish the same Worker content identity', async t => {
  const f = await fixture(t)
  const first = await buildWorkerReleaseArtifacts(f)
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'metadata only'], { cwd: f.repository })
  const second = await buildWorkerReleaseArtifacts({ ...f, directory: join(f.repository, 'second-artifacts'),
    productManifestPath: join(f.repository, 'second-product.json') })
  for (const [index, artifact] of first.artifacts.entries()) {
    assert.match(artifact.contentSha256, /^[a-f0-9]{64}$/)
    assert.equal(artifact.contentSha256, second.artifacts[index].contentSha256)
    assert.notEqual(artifact.manifestSha256, second.artifacts[index].manifestSha256)
  }
})

test('packages every reviewed target from one committed release in private storage', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'apps/worker/artifacts/ubuntu-0-target.json'), JSON.stringify({ ...target, node: 'bad' }))
  const index = await buildWorkerReleaseArtifacts(f)
  assert.equal(index.version, '0.0.57')
  assert.equal(JSON.parse(await readFile(f.productManifestPath)).version, '0.0.57')
  assert.equal(JSON.parse(await readFile(join(f.repository, 'apps/api/package.json'))).version, '0.1.0')
  assert.equal((await stat(f.productManifestPath)).mode & 0o077, 0)
  assert.equal(index.artifacts.length, 4)
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.every(call => call.commit === f.commit))
  assert.equal((await stat(f.directory)).mode & 0o077, 0)
  assert.equal((await stat(join(f.directory, 'index.json'))).mode & 0o077, 0)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), index)
  for (const artifact of index.artifacts) {
    const bytes = await readFile(join(f.directory, artifact.manifestSha256, 'manifest.json'))
    assert.equal(sha256(bytes), artifact.manifestSha256)
    assert.deepEqual(JSON.parse(bytes).target, artifact.target)
  }
})

test('builds every reviewed target at once and keeps the reviewed order in the index', async t => {
  const f = await fixture(t)
  let active = 0
  let peak = 0
  const run = async (...args) => {
    active++
    peak = Math.max(peak, active)
    // Each target takes ~10 s on a build computer; one after another made deploys wait for all of them.
    await new Promise(resolve => setTimeout(resolve, 50))
    await f.run(...args)
    active--
  }
  const index = await buildWorkerReleaseArtifacts({ ...f, run })
  assert.equal(peak, 4)
  // Builds finish in any order; the index lists targets in their reviewed (path) order.
  const reviewed = readCommittedWorkerTargets(f.repository, f.commit).map(({ target }) => target)
  assert.deepEqual(index.artifacts.map(artifact => artifact.target), reviewed)
})

test('a failed target build waits for the others before removing artifact storage', async t => {
  const f = await fixture(t)
  let finished = 0
  const run = async (...args) => {
    if (args[1][1].includes('ubuntu-0')) throw new Error('Artifact build failed')
    await new Promise(resolve => setTimeout(resolve, 50))
    await f.run(...args)
    finished++
  }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run }), /Artifact build failed/)
  assert.equal(finished, 3)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
})

test('rejects corrupted build output and removes incomplete artifact storage', async t => {
  const f = await fixture(t)
  const run = async (...args) => {
    await f.run(...args)
    await writeFile(join(args[1][2], 'src/cli.mjs'), 'changed after building')
  }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run }), /checksum mismatch/)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
})

test('keeps failed builds from publishing an index', async t => {
  const f = await fixture(t)
  const run = async () => { throw new Error('Artifact build failed') }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run }), /Artifact build failed/)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
})

test('rejects unsupported reviewed targets before building', async t => {
  const f = await fixture(t)
  const path = join(f.repository, 'apps/worker/artifacts/ubuntu-0-target.json')
  await writeFile(path, JSON.stringify({ ...target, arch: 'arm64' }))
  execFileSync('git', ['add', '.'], { cwd: f.repository })
  execFileSync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.invalid',
    'commit', '-qm', 'unsupported target'], { cwd: f.repository })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.repository, encoding: 'utf8' }).trim()
  assert.throws(() => readCommittedWorkerTargets(f.repository, commit), /linux-x64/)
})

test('blocks a toolchain pin change before publishing updates to format-one workers', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'package.json'), JSON.stringify({ version: '0.0.57', packageManager: 'pnpm@11.28.0' }))
  execFileSync('git', ['add', 'package.json'], { cwd: f.repository })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'change toolchain'], { cwd: f.repository })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.repository, encoding: 'utf8' }).trim()
  const run = async (...args) => {
    await f.run(...args)
    const path = join(args[1][2], 'manifest.json')
    const manifest = JSON.parse(await readFile(path))
    await writeFile(path, `${JSON.stringify({ ...manifest, commit }, null, 2)}\n`)
  }
  const publish = async () => { throw new Error('Incompatible release reached publication') }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run, publish }), /bridge release/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(stat(f.productManifestPath), { code: 'ENOENT' })
})

test('an installed release advances its target only after the publisher succeeds', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  assert.equal(index.github, undefined)
  const calls = []
  const publish = async options => { calls.push(options); return { repository: 'example/fixture', tag: `worker-${f.commit}` } }
  const published = await publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'example/fixture')
  assert.deepEqual(calls[0].artifacts, index.artifacts)
  assert.deepEqual(published, { ...index, github: { repository: 'example/fixture', tag: `worker-${f.commit}` },
    publication: { state: 'published', lastError: null } })
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), published)
  assert.equal((await stat(join(f.directory, 'index.json'))).mode & 0o077, 0)
  await publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  assert.equal(calls.length, 1)
})

test('a failed background upload keeps the target unpublished and records its reason', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  const publish = async () => { throw new Error('GitHub unavailable') }
  await assert.rejects(publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish }), /GitHub unavailable/)
  const retained = JSON.parse(await readFile(join(f.directory, 'index.json')))
  assert.deepEqual(retained, { ...index, publication: { state: 'failed',
    lastError: 'WORKER_RELEASE_ASSET_UNAVAILABLE: GitHub unavailable',
    startedAt: retained.publication.startedAt, deadlineAt: retained.publication.deadlineAt } })
})

test('publication retries keep the first attempt deadline and fail with its code once it passes', async t => {
  const f = await fixture(t)
  await buildWorkerReleaseArtifacts(f)
  const path = join(f.directory, 'index.json')
  const attempt = publish => publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  const unavailable = async () => { throw new Error('GitHub unavailable') }
  await assert.rejects(attempt(unavailable), /GitHub unavailable/)
  const first = JSON.parse(await readFile(path)).publication
  assert.equal(Date.parse(first.deadlineAt) - Date.parse(first.startedAt), 2 * 60 * 60_000)
  await assert.rejects(attempt(unavailable), /GitHub unavailable/)
  const retry = JSON.parse(await readFile(path)).publication
  assert.equal(retry.startedAt, first.startedAt)
  assert.equal(retry.deadlineAt, first.deadlineAt)
  assert.match(retry.lastError, /^WORKER_RELEASE_ASSET_UNAVAILABLE: GitHub unavailable$/)

  const startedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
  const deadlineAt = new Date(Date.now() - 60 * 60_000).toISOString()
  const index = JSON.parse(await readFile(path))
  await writeFile(path, JSON.stringify({ ...index, publication: { ...retry, startedAt, deadlineAt } }))
  await assert.rejects(attempt(unavailable), /GitHub unavailable/)
  const overdue = JSON.parse(await readFile(path)).publication
  assert.equal(overdue.state, 'failed')
  assert.equal(overdue.startedAt, startedAt)
  assert.match(overdue.lastError,
    /^WORKER_PUBLICATION_DEADLINE_EXCEEDED: phase publishing, age 180 min, over the 120 min limit\. Cause: GitHub unavailable$/)

  const github = { repository: 'example/fixture', tag: `worker-${f.commit}` }
  const published = await attempt(async () => github)
  assert.deepEqual(published.publication, { state: 'published', lastError: null })
})

test('the installed background publisher loads without build-only source modules', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  const scripts = join(f.repository, 'installed/scripts')
  await mkdir(scripts, { recursive: true })
  for (const name of ['worker-release-artifacts.mjs', 'worker-artifact-files.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(scripts, name))
  }
  const installed = await import(pathToFileURL(join(scripts, 'worker-release-artifacts.mjs')).href)
  const github = { repository: 'example/worker', tag: `worker-${f.commit}` }
  const published = await installed.publishInstalledWorkerArtifacts({ directory: f.directory,
    repositoryName: github.repository, commit: f.commit, run: f.run, publish: async () => github })
  assert.deepEqual(published, { ...index, github, publication: { state: 'published', lastError: null } })
})

test('retries a conflicting create after a stale missing release read without uploading twice', async t => {
  const f = await fixture(t)
  await mkdir(f.directory)
  const calls = []
  const waits = []
  let reads = 0
  const simulate = assetSimulator()
  const run = async (command, args) => {
    if (command !== 'gh') return simulate(command, args)
    calls.push(args[0] === 'api' ? 'api' : args[1])
    if (args[0] === 'api' && reads++ === 0) throw new Error('HTTP 404: release not found')
    if (args[1] === 'create') throw new Error('release already exists')
    return simulate(command, args)
  }
  const result = await publishWorkerArtifactsToGitHub({ ...f, name: 'example/worker',
    artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
    sleep: async delay => { waits.push(delay) } })
  assert.equal(result.tag, `worker-${f.commit}`)
  assert.deepEqual(waits, [5000])
  assert.deepEqual(calls, ['api', 'create', 'api', 'upload', 'api'])
})

test('runs recovery when the service starts the script through the current release symlink', async t => {
  const root = await mkdtemp(join(homedir(), '.cache', 'foreman-tmp', 'worker-publish-symlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await symlink(join(import.meta.dirname, '..'), join(root, 'current'))
  const release = join(root, 'release')
  await mkdir(join(release, 'worker-artifacts'), { recursive: true })
  await writeFile(join(release, 'worker-artifacts', 'index.json'), JSON.stringify({ format: 1, version: '0.0.0',
    github: { repository: 'owner/repo', tag: 'v0.0.0' }, publication: { state: 'published', lastError: null } }))
  const output = execFileSync(process.execPath, [join(root, 'current', 'scripts', 'worker-release-artifacts.mjs'),
    'recover', release], { encoding: 'utf8' })
  assert.match(output, /Worker artifacts published and verified on GitHub/)
})
