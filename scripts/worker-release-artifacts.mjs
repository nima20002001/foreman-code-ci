import { execFileSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { artifactFiles, validateWorkerTarget, workerReleaseVersion, assertWorkerUpdateToolchain } from './worker-artifact-files.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const PUBLICATION_COMMAND_TIMEOUT_MS = 5 * 60_000
const PUBLICATION_RETRY_MS = 60_000
// WORKER_PUBLICATION_DEADLINE_MS in packages/contracts/src/workerUpdate.ts; installed scripts cannot import contracts.
const PUBLICATION_DEADLINE_MS = 2 * 60 * 60_000

/** Retries keep the pending publication's start and deadline until it succeeds. */
function publicationWindow(previous, now = Date.now()) {
  if (previous && previous.state !== 'published' && previous.startedAt && previous.deadlineAt) {
    return { startedAt: previous.startedAt, deadlineAt: previous.deadlineAt }
  }
  return { startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + PUBLICATION_DEADLINE_MS).toISOString() }
}

export function runWorkerPublicationCommand(command, args, { timeoutMs = PUBLICATION_COMMAND_TIMEOUT_MS,
  killGraceMs = 5000, captureOutput = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true,
      stdio: ['ignore', captureOutput ? 'pipe' : 'inherit', 'pipe'] })
    let stdout = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    let stderr = ''
    let expired = false
    let closed = false
    let forced = false
    let escalation
    const kill = signal => {
      try { process.kill(-child.pid, signal) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const failure = () => new Error(`WORKER_PUBLICATION_COMMAND_DEADLINE_EXCEEDED: ${command} exceeded ${timeoutMs} ms.`)
    const timer = setTimeout(() => {
      expired = true
      kill('SIGTERM')
      escalation = setTimeout(() => {
        kill('SIGKILL')
        forced = true
        if (closed) reject(failure())
      }, killGraceMs)
    }, timeoutMs)
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk)
      stderr = (stderr + chunk.toString()).slice(-1500)
    })
    child.once('error', error => {
      clearTimeout(timer)
      clearTimeout(escalation)
      reject(error)
    })
    child.once('close', code => {
      closed = true
      clearTimeout(timer)
      if (expired) {
        if (forced) reject(failure())
      } else if (code === 0) resolve({ stdout })
      else reject(new Error(`${command} failed (${code}): ${stderr.trim()}`))
    })
  })
}

function committedBytes(repository, commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function readCommittedWorkerTargets(repository, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid Worker build commit')
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'apps/worker/artifacts'],
    { cwd: repository, encoding: 'utf8' }).trim().split('\n')
  const targets = names.filter(path => /^apps\/worker\/artifacts\/[a-zA-Z0-9_.-]+-target\.json$/.test(path))
    .sort().map(path => ({ path, target: JSON.parse(committedBytes(repository, commit, path)) }))
  if (targets.length === 0) throw new Error('No reviewed Worker targets in the installed commit')
  const seen = new Set()
  for (const { target } of targets) {
    validateWorkerTarget(target)
    const key = [target.os, target.osRelease, target.arch, target.libc, target.node].join('/')
    if (seen.has(key)) throw new Error('Duplicate reviewed Worker target')
    seen.add(key)
  }
  return targets
}

async function verifyArtifact(directory, target, version, commit) {
  const { validateManifest } = await import('../apps/worker/src/installation.mjs')
  const { workerArtifactContentSha256 } = await import('../packages/contracts/src/workerArtifactContentNode.mjs')
  const bytes = await readFile(join(directory, 'manifest.json'))
  if (bytes.length > 1_048_576 - 4096) throw new Error('Worker manifest is too large for the device channel')
  const manifest = JSON.parse(bytes)
  validateManifest(manifest, { ...target, rootPersistent: true, homePersistent: true, storagePersistent: true },
    { protocolVersion: 1, identityFormat: 1 })
  if (manifest.version !== version || manifest.commit !== commit
    || !bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))) {
    throw new Error('Worker artifact differs from the installed release')
  }
  const files = (await artifactFiles(directory)).filter(file => file.path !== 'manifest.json')
  if (files.length !== manifest.files.length) throw new Error('Worker artifact file list differs from its manifest')
  for (const file of files) {
    const expected = manifest.files.find(entry => entry.path === file.path)
    if (!expected || expected.size !== file.size || expected.sha256 !== file.sha256) {
      throw new Error(`Worker artifact checksum mismatch: ${file.path}`)
    }
  }
  return { manifestSha256: sha256(bytes), contentSha256: workerArtifactContentSha256(manifest) }
}

async function readPreviousArtifacts(directory) {
  if (!directory) return []
  try {
    const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
    if (!Array.isArray(index.artifacts)) throw new Error('Worker artifact index is invalid')
    return index.artifacts.map(artifact => {
      const github = artifact.github ?? (index.publication?.state === 'published' ? index.github : undefined)
      return { ...artifact, ...(github ? { github } : {}) }
    })
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Worker artifact cache unavailable: ${error.message}`)
    return []
  }
}

const targetKey = target => [target.os, target.osRelease, target.arch, target.libc, target.node].join('/')

function committedBlobIds(repository, commit) {
  const tree = execFileSync('git', ['ls-tree', '-rz', commit], { cwd: repository, encoding: 'utf8' })
  return new Map(tree.split('\0').filter(Boolean).map(entry => {
    const [metadata, path] = entry.split('\t')
    return [path, metadata.split(' ')[2]]
  }))
}

function sameWorkerInputs({ repository, commit, manifest, blobs }) {
  return manifest.sourceSnapshot.files.every(file => {
    if (!blobs.has(file.path)) return false
    if (blobs.get(file.path) === file.gitBlobSha1) return true
    if (file.path !== 'package.json') return false
    const previous = JSON.parse(committedBytes(repository, manifest.commit, file.path))
    const product = JSON.parse(committedBytes(repository, commit, file.path))
    return isDeepStrictEqual({ ...previous, version: product.version }, product)
  })
}

async function reuseWorkerArtifact({ repository, previousDirectory, previousArtifacts, path, target, commit, blobs, staging }) {
  const retained = previousArtifacts.find(artifact => artifact.target && targetKey(artifact.target) === targetKey(target))
  if (!retained || !/^[a-f0-9]{64}$/.test(retained.manifestSha256)) return false
  try {
    const directory = join(previousDirectory, retained.manifestSha256)
    const bytes = await readFile(join(directory, 'manifest.json'))
    if (sha256(bytes) !== retained.manifestSha256) throw new Error('Worker manifest checksum mismatch')
    const manifest = JSON.parse(bytes)
    const snapshot = manifest.sourceSnapshot
    const required = ['package.json', 'pnpm-lock.yaml', 'scripts/build-worker-artifact.mjs', path]
    if (!snapshot || snapshot.commit !== manifest.commit || !Array.isArray(snapshot.files)
      || !required.every(path => snapshot.files.some(file => file.path === path))
      || !sameWorkerInputs({ repository, commit, manifest, blobs })) return false
    const identity = await verifyArtifact(directory, target, manifest.version, manifest.commit)
    if (identity.contentSha256 !== retained.contentSha256) throw new Error('Worker content identity mismatch')
    await cp(directory, staging, { recursive: true })
    console.log(JSON.stringify({ operation: 'reuse Worker artifact', target: targetKey(target) }))
    return { ...identity, ...(retained.github ? { github: retained.github } : {}) }
  } catch (error) {
    console.warn(`Worker artifact cache unavailable for ${targetKey(target)}: ${error.message}`)
    await rm(staging, { recursive: true, force: true })
    return false
  }
}

function githubErrorReason(error) {
  return `${error.message ?? ''} ${error.stderr ?? ''}`
}

function retryableGitHubError(error) {
  const reason = githubErrorReason(error)
  if (reason.includes('WORKER_PUBLICATION_COMMAND_DEADLINE_EXCEEDED')
    || reason.includes('GitHub Worker asset checksum mismatch')) return false
  return /HTTP (?:404|408|429|5\d\d)|release not found|release already exists|ReleaseAsset\.name already exists/iu.test(reason)
    || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|connection reset|broken pipe|socket hang up|\bEOF\b|timed out/iu.test(reason)
    || /TLS handshake timeout|i\/o timeout|temporary failure in name resolution/iu.test(reason)
    || /GitHub Worker asset not found/iu.test(reason)
}

async function readGitHubRelease({ name, tag, run, cwd }) {
  let result
  try {
    result = await run('gh', ['api', `repos/${name}/releases/tags/${tag}`], { cwd, captureOutput: true })
  } catch (error) {
    if (/HTTP 404/iu.test(githubErrorReason(error))) return null
    throw error
  }
  return JSON.parse(result.stdout)
}

function missingGitHubAssets(assets, release) {
  const digests = new Map((release?.assets ?? []).map(asset => [asset.name, asset.digest]))
  return assets.filter(asset => {
    if (!digests.has(asset.name)) return true
    if (digests.get(asset.name) !== asset.digest) {
      throw new Error(`GitHub Worker asset checksum mismatch: ${asset.name}`)
    }
    return false
  })
}

/** Uploads each artifact as <manifestSha256>.tar.gz to the GitHub release worker-<commit>, so paired Workers download
 * their update from GitHub with their own login instead of through Main. */
export async function publishWorkerArtifactsToGitHub({ repository, name: knownName, directory, commit, artifacts, run,
  sleep: wait = sleep }) {
  const origin = knownName ? '' : execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repository, encoding: 'utf8' }).trim()
  const name = knownName ?? /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(origin)?.[1]
  if (!name) throw new Error('Worker artifacts publish to GitHub: the repository origin is not a GitHub repository.')
  const tag = `worker-${commit}`
  const staging = await mkdtemp(join(directory, '.publish-'))
  try {
    const assets = []
    for (const { manifestSha256 } of artifacts) {
      const asset = join(staging, `${manifestSha256}.tar.gz`)
      await run('tar', ['-czf', asset, '--sort=name', '--format=gnu', '--mtime=@0',
        '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go-rwx',
        '-C', join(directory, manifestSha256), '.'], { cwd: repository ?? directory })
      assets.push({ path: asset, name: `${manifestSha256}.tar.gz`,
        digest: `sha256:${sha256(await readFile(asset))}` })
    }
    const backoff = [5000, 10000, 20000, 25000]
    for (let attempt = 0; ; attempt++) {
      try {
        const options = { name, tag, run, cwd: repository ?? directory }
        const release = await readGitHubRelease(options)
        if (!release) {
          await run('gh', ['release', 'create', tag, '--repo', name, '--prerelease',
            '--title', `Worker ${commit.slice(0, 12)}`,
            '--notes', `Foreman Code Worker artifacts built from ${commit}.`], { cwd: options.cwd })
        }
        const missing = missingGitHubAssets(assets, release)
        if (missing.length) {
          await run('gh', ['release', 'upload', tag, ...missing.map(asset => asset.path), '--repo', name],
            { cwd: options.cwd })
          const remaining = missingGitHubAssets(assets, await readGitHubRelease(options))
          if (remaining.length) throw new Error(`GitHub Worker asset not found: ${remaining[0].name}`)
        }
        return { repository: name, tag }
      } catch (error) {
        // Recheck remote assets after a lost response or a concurrent upload before writing again.
        if (attempt === backoff.length || !retryableGitHubError(error)) throw error
        console.warn(JSON.stringify({ operation: 'publish Worker release', attempt: attempt + 1,
          nextRetryMs: backoff[attempt], lastError: 'GITHUB_RELEASE_TEMPORARILY_UNAVAILABLE' }))
        await wait(backoff[attempt])
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function buildWorkerReleaseArtifacts({
  repository, directory, productManifestPath, run, publish, expectedCommit, previousDirectory,
}) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new Error('Worker source differs from the captured release commit.')
  }
  const productManifest = committedBytes(repository, commit, 'package.json')
  const product = JSON.parse(productManifest)
  assertWorkerUpdateToolchain(product)
  const version = workerReleaseVersion(product)
  const targets = readCommittedWorkerTargets(repository, commit)
  const previousArtifacts = await readPreviousArtifacts(previousDirectory)
  const blobs = previousArtifacts.length ? committedBlobIds(repository, commit) : undefined
  await mkdir(directory, { mode: 0o700 })
  try {
    // Targets build independently; all of them settle before a failure removes the shared storage.
    const builds = await Promise.allSettled(targets.map(async ({ path, target }) => {
      const staging = await mkdtemp(join(directory, '.build-'))
      // The builder requires a fresh directory that it creates itself.
      await rm(staging, { recursive: true })
      const reused = previousArtifacts.length && await reuseWorkerArtifact({ repository, previousDirectory, previousArtifacts,
        path, target, commit, blobs, staging })
      if (!reused) {
        await run(process.execPath, ['scripts/build-worker-artifact.mjs', path, staging], {
          cwd: repository,
          env: { ...process.env, FOREMAN_CODE_WORKER_BUILD_COMMIT: commit },
        })
      }
      const identity = reused || await verifyArtifact(staging, target, version, commit)
      await chmod(staging, 0o700)
      await rename(staging, join(directory, identity.manifestSha256))
      return { target, ...identity }
    }))
    const failed = builds.find(build => build.status === 'rejected')
    if (failed) throw failed.reason
    const artifacts = builds.map(build => build.value)
    const unpublished = artifacts.filter(artifact => !artifact.github)
    const github = unpublished.length
      ? publish && await publish({ repository, directory, commit, artifacts: unpublished, run })
      : artifacts[0].github
    const index = { format: 1, version, commit, ...(github ? { github } : {}), artifacts,
      publication: { state: github ? 'published' : 'pending', lastError: null,
        ...(!github ? publicationWindow() : {}) } }
    await writeFile(join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(productManifestPath, productManifest, { flag: 'wx', mode: 0o600 })
    return index
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function writeArtifactIndex(directory, index) {
  const temporary = join(directory, '.index.json.publishing')
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, join(directory, 'index.json'))
}

export async function recordWorkerPublicationFailure(directory, error) {
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
  const reason = error instanceof Error ? error.message : String(error)
  const { startedAt, deadlineAt } = index.publication ?? {}
  const overdue = deadlineAt && Date.now() > Date.parse(deadlineAt)
  const lastError = overdue
    ? `WORKER_PUBLICATION_DEADLINE_EXCEEDED: phase publishing, age ${Math.round((Date.now() - Date.parse(startedAt)) / 60_000)} min, `
      + `over the ${PUBLICATION_DEADLINE_MS / 60_000} min limit. Cause: ${reason}`
    : `WORKER_RELEASE_ASSET_UNAVAILABLE: ${reason}`
  const publication = { state: 'failed', lastError: lastError.slice(0, 2000),
    ...(startedAt && deadlineAt ? { startedAt, deadlineAt } : {}) }
  if (reason.includes('WORKER_PUBLICATION_COMMAND_DEADLINE_EXCEEDED')) {
    publication.nextRetryAt = new Date(Date.now() + PUBLICATION_RETRY_MS).toISOString()
  }
  await writeArtifactIndex(directory, { ...index, publication })
}

/** The device target advances only when all GitHub release asset digests match. */
export async function publishInstalledWorkerArtifacts({ directory, repositoryName, commit, run,
  publish = publishWorkerArtifactsToGitHub }) {
  const path = join(directory, 'index.json')
  const index = JSON.parse(await readFile(path, 'utf8'))
  if (index.github && index.publication?.state === 'published') return index
  try {
    await writeArtifactIndex(directory, { ...index,
      publication: { state: 'pending', lastError: null, ...publicationWindow(index.publication) } })
    const unpublished = index.artifacts.filter(artifact => !artifact.github)
    const github = await publish({ name: repositoryName, directory, commit, artifacts: unpublished,
      run: run ?? runWorkerPublicationCommand })
    const published = { ...index, github, publication: { state: 'published', lastError: null } }
    await writeArtifactIndex(directory, published)
    return published
  } catch (error) {
    await recordWorkerPublicationFailure(directory, error)
    throw error
  }
}

export async function recoverInstalledWorkerArtifacts({ release, run, publish }) {
  const directory = join(release, 'worker-artifacts')
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
  if (index.github && index.publication?.state === 'published') return index
  if (index.publication?.state === 'pending' && index.publication.startedAt) {
    await writeArtifactIndex(directory, { ...index, publicationRecovery: {
      abandonedAttempts: (index.publicationRecovery?.abandonedAttempts ?? 0) + 1,
      lastAbandonedAt: new Date().toISOString(),
    } })
  }
  const { repository, commit } = JSON.parse(await readFile(join(release, 'ci-smoke.json'), 'utf8'))
  return publishInstalledWorkerArtifacts({ directory, repositoryName: repository, commit, run, publish })
}

export function workerPublicationServiceTemplate() {
  return `[Unit]
Description=Foreman Code Worker artifact publication
StartLimitIntervalSec=0

[Service]
Type=exec
Environment=PATH=@PATH@
ExecStart=@NODE@ @APP@/current/scripts/worker-release-artifacts.mjs recover @APP@/current
Restart=on-failure
RestartSec=60
RuntimeMaxSec=1800
TimeoutStopSec=15
KillMode=control-group
ExecStopPost=@NODE@ @APP@/current/scripts/worker-release-artifacts.mjs stopped @APP@/current
UMask=0077
`
}

// The publication service starts this script through the current-release symlink; Node reports the real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  && ['publish', 'recover', 'stopped'].includes(process.argv[2])) {
  const [directory, repositoryName, commit] = process.argv.slice(3)
  try {
    if (process.argv[2] === 'stopped') {
      if (process.env.SERVICE_RESULT === 'timeout') {
        await recordWorkerPublicationFailure(join(directory, 'worker-artifacts'),
          new Error('WORKER_PUBLICATION_COMMAND_DEADLINE_EXCEEDED: publication unit exceeded 1800 seconds.'))
      }
    } else {
      const run = runWorkerPublicationCommand
      if (process.argv[2] === 'recover') await recoverInstalledWorkerArtifacts({ release: directory, run })
      else await publishInstalledWorkerArtifacts({ directory, repositoryName, commit, run })
      console.log('Worker artifacts published and verified on GitHub.')
    }
  } catch (error) {
    console.error(`WORKER_RELEASE_ASSET_UNAVAILABLE: Worker publication failed: ${error.message}`)
    process.exitCode = 1
  }
}
