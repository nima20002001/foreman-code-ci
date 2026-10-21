import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { buildCiRuntimeContext, ciRuntimeInputDigest, parseCiLock } from './ciRuntimeContext.mjs'
import { expectedPortions } from '../../../../../scripts/verification-runner.mjs'
import type { CiCacheStatus, PreparedCiRuntime } from '@foreman-code/contracts'
import { JobVerificationQuotaPoolSchema } from '@foreman-code/contracts/job-verification-runtime'
import { z } from 'zod'
import { pruneCiRuntimeCache, readCiRuntimeCache, writeCiRuntimeCache } from './ciRuntimeCache.js'
import { readJobProjectQuota } from './quotaOwnership.js'
import { readProtectedRuntimeConfiguration, readProtectedRuntimeFile } from './installedRuntimeConfiguration.js'
import { MAX_VERIFICATION_CONFIGURATION_BYTES } from './installedVerificationConfiguration.js'
import { closeCiRuntimeCommand, runCiRuntimeCommand } from './ciRuntimeCommands.js'
import { pruneCiImages } from './ciRuntimeImages.js'
import { ciPreparationBuildArgs, ciPreparationLimits, ciPreparationResourceArgs } from './ciPreparationLimits.js'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u

const quotaConfiguration = z.object({
  schemaVersion: z.literal(2),
  descriptor: z.object({ quotaPool: JobVerificationQuotaPoolSchema }).passthrough(),
}).passthrough()

/** `stateDirectory` holds the computer's protected runtime configuration, whose quota pool reports usage when
 * preparation runs out of CI storage. */
export async function prepareCiRuntime({ stateDirectory, ...input }: Parameters<typeof prepareRuntime>[0]
  & { stateDirectory?: string }): Promise<PreparedCiRuntime> {
  try {
    return await prepareRuntime(input)
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown; stderr?: unknown } | null
    const diagnostics = `${failure?.code ?? ''} ${failure?.message ?? ''} ${failure?.stderr ?? ''}`
    if (!/\b(?:ENOSPC|EDQUOT)\b|disk quota exceeded|no space left on device/iu.test(diagnostics)) throw error

    let quota = 'Control quota readback unavailable: this computer did not supply its protected runtime state.'
    if (stateDirectory) try {
      const configuration = await readProtectedRuntimeConfiguration({
        path: join(stateDirectory, 'job-runtime.json'), ownerUid: process.getuid!(),
      }, quotaConfiguration, MAX_VERIFICATION_CONFIGURATION_BYTES)
      const observed = await readJobProjectQuota(configuration.descriptor.quotaPool, input.installer,
        AbortSignal.timeout(5000))
      quota = `Control quota (project ${observed.projectId}): bytes used=${observed.usedBytes} `
        + `hard=${observed.hardLimitBytes}; inodes used=${observed.usedInodes} hard=${observed.hardInodes}.`
    } catch (readError) {
      const reason = readError instanceof Error ? readError.message : String(readError)
      quota = `Control quota readback unavailable: ${reason.slice(-300)}`
    }
    throw new Error(`CI storage is full on this build computer. ${quota}`, { cause: error })
  }
}

/** Prepares this build computer for one commit's dependencies, with no human step:
 * a checkout of the commit, an offline package seed fetched with network, the verification
 * image built without network, and the qualification source tree. Returns the facts Main
 * needs to capture and qualify the new runtime. Everything stays inside `installer`. */
export interface CiRuntimeReview { reviewedByPrincipalId: string; decisionDigest: string }
async function prepareRuntime({ repository, commit, installer, review, keepImages = [], keepPaths = [],
  environment = process.env, signal, log = () => {}, onCacheStatus }: {
  repository: string; commit: string; installer: string; review: CiRuntimeReview
  /** Image ids referenced by protected configurations and retained execution records. */
  keepImages?: readonly string[]
  /** Installer paths the current protected runtime still uses (its qualification source). */
  keepPaths?: readonly string[]
  environment?: NodeJS.ProcessEnv; log?: (stage: string) => void
  onCacheStatus?: (status: CiCacheStatus) => void
  signal?: AbortSignal
}): Promise<PreparedCiRuntime> {
  signal?.throwIfAborted()
  const stage = (name: string) => {
    signal?.throwIfAborted()
    log(name)
  }
  if (!COMMIT.test(commit)) throw new Error('A full commit id is required.')
  if (!review?.reviewedByPrincipalId || !/^[a-f0-9]{64}$/u.test(review.decisionDigest ?? '')) throw new Error('Owner decision is required.')
  const short = commit.slice(0, 12)
  const buildLimits = ciPreparationBuildArgs(ciPreparationLimits())
  const env = {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_TERMINAL_PROMPT: '0',
  }
  const sh = async (file: string, args: string[], options: { cwd?: string } = {}) => {
    const result = await runCiRuntimeCommand(file, args, { env, signal, ...options })
    return result.stdout
  }
  if ((await runCiRuntimeCommand('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`],
    { env, signal }).then(() => true, (error: unknown) => {
      signal?.throwIfAborted()
      const failure = error as { code?: unknown; stderr?: unknown }
      if (failure.code === 128 && typeof failure.stderr === 'string'
        && /^fatal: Not a valid object name [a-f0-9]+\^\{commit\}\s*$/u.test(failure.stderr)) return false
      throw error
    })) === false) {
    await sh('git', ['-C', repository, 'fetch', '--no-tags', 'origin', commit])
  }
  stage('reclaim-interrupted-preparation')
  await reclaimInterruptedPreparation({ repository, installer, keepPaths, env, signal })
  stage('checking-runtime-cache')
  const inputDigest = await ciRuntimeInputDigest({ repository, commit })
  const imageExists = async (imageId: string) => {
    try {
      await podman(['image', 'exists', imageId], env, signal)
      return true
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false
      throw error
    }
  }
  const cache: CiCacheStatus = { status: 'miss', lastError: null, missCount: 1, rebuildCount: 1 }
  const cached = await readCiRuntimeCache({ installer, inputDigest, imageExists, onInvalid: reason => {
    cache.status = 'invalid'
    cache.lastError = reason
  } })
  if (cached) Object.assign(cache, { status: 'hit', missCount: 0, rebuildCount: 0 })
  onCacheStatus?.(cache)
  if (cached) {
    stage('prune-images')
    await pruneCiImages({ keep: [...keepImages, cached.imageId], env, installer, signal })
    await pruneCiRuntimeCache({ installer, imageExists, keepPaths: [...keepPaths,
      cached.seedReceiptPath, cached.contextReceiptPath, ...(cached.unitCodex ? [cached.unitCodex.sourceExecutable] : [])] })
    stage('reusing-runtime-image')
    const qualificationSource = await extractQualificationSource(repository, commit,
      join(installer, `qualification-source-${short}`), env, signal)
    return { ...cached, commit, qualificationSource, reusedImage: true, cache }
  }
  const source = join(installer, `source-${short}`)
  if (!await exists(source)) {
    stage('checkout')
    await sh('git', ['-C', repository, 'worktree', 'add', '--detach', source, commit])
  }
  const head = (await sh('git', ['-C', source, 'rev-parse', 'HEAD'])).trim()
  if (head !== commit) throw new Error('The prepared checkout is not at the requested commit.')

  stage('prune-images')
  // Other preparations and recovery records may still own older installer files.
  await pruneCiImages({ keep: keepImages, env, installer, signal })
  await pruneCiRuntimeCache({ installer, imageExists, keepPaths })
  // 1. The build stage fetches the frozen lockfile's packages with network into its own store.
  const buildContext = join(installer, `build-context-${short}`)
  await rm(buildContext, { recursive: true, force: true })
  await buildCiRuntimeContext({ repository: source, commit, output: buildContext })
  const buildTag = `localhost/foreman-code-ci-build:${short}`
  stage('fetch-packages')
  // Host networking needs no rootless network helper; only this package-fetch stage has network.
  await podman(['build', ...buildLimits, '--pull=missing', '--network=host', '--target', 'build', '--layers=true', '--force-rm',
    '--label', `io.foreman-code.installation=${hash(installer)}`, '-t', buildTag, buildContext], env, signal)
  const seedRoot = join(installer, `seed-${short}`)
  const seed = join(seedRoot, 'seed')
  await rm(seedRoot, { recursive: true, force: true })
  await mkdir(seed, { recursive: true, mode: 0o700 })
  const container = `foreman-ci-seed-${randomUUID()}`
  try {
    await podman(['create', '--name', container,
      '--label', `io.foreman-code.installation=${hash(installer)}`,
      '--label', 'io.foreman-code.ci-preparation=seed', buildTag, 'true'], env, signal)
    for (const name of ['pnpm-store', 'corepack-cache']) {
      await podman(['cp', `${container}:/opt/graphql-ci/${name}`, join(seed, name)], env, signal)
    }
  } finally {
    await podman(['rm', '--force', '--ignore', container], env, AbortSignal.timeout(30_000))
  }

  // 2. Registry release evidence for the strict 48-hour policy, and the Codex binary the unit suite needs.
  stage('seed-receipt')
  const needsCodex = expectedPortions(source, 'unit').some(portion => portion.key === 'root:worker-artifact')
  const unitCodex = needsCodex ? await codexBinary(buildTag, seedRoot, env, signal) : undefined
  // pnpm records each project that installed from the store as a symlink; they are not package content.
  for (const version of await readdir(join(seed, 'pnpm-store'))) {
    await rm(join(seed, 'pnpm-store', version, 'projects'), { recursive: true, force: true })
  }
  const receipt = await createSeedReceipt({ repository: source, seed, review, signal })
  const receiptPath = join(seedRoot, 'seed-receipt.json')
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  const offlineSeed: NonNullable<Parameters<typeof buildCiRuntimeContext>[0]['offlineSeed']> = { directory: seed, receiptPath }
  if (unitCodex) {
    offlineSeed.unitCodex = { path: unitCodex.path, binarySha256: unitCodex.sha256, version: unitCodex.version,
      review: receipt.review }
  }

  // 3. The verification image runs Jobs without network.
  const context = join(installer, `context-${short}`)
  await rm(context, { recursive: true, force: true })
  await buildCiRuntimeContext({ repository: source, commit, output: context, offlineSeed })
  // The verified build context now owns the seed copy needed by the image.
  await rm(seed, { recursive: true, force: true })
  const tag = `localhost/foreman-code-verification:${short}`
  stage('build-image')
  // The image's own pnpm check runs through the verification policy, which needs a finite memory reservation.
  // Its toolchain layer (with PostgreSQL) is the one the networked package build just cached.
  await podman(['build', ...buildLimits, '--pull=never', '--network=none', '--target', 'verification', '--layers=true', '--force-rm',
    '--label', `io.foreman-code.installation=${hash(installer)}`, '-t', tag, context], env, signal)
  const image = (JSON.parse(await podmanOut(['image', 'inspect', tag], env, signal)) as { Id: string; Digest: string }[])[0]!
  await podman(['rmi', '--no-prune', buildTag], env, signal).catch(error => {
    if (error.code !== 2) throw error
  })

  // 4. The exact tracked tree Main approved for this commit, which qualification verifies byte for byte.
  const qualificationSource = await extractQualificationSource(repository, commit,
    join(installer, `qualification-source-${short}`), env, signal)
  // The image holds the seed and context; keep only their receipts and drop the multi-gigabyte build inputs.
  const seedReceiptPath = await writeRuntimeReceipt(installer, 'seed', await readFile(join(context, 'seed-receipt.json')))
  const contextReceiptPath = await writeRuntimeReceipt(installer, 'context', await readFile(join(context, 'context-receipt.json')))
  // The refresh captures the unit suite's Codex from this copy; the checkout it came from is removed.
  const codex = join(installer, `codex-${short}`)
  if (unitCodex) await writeFile(codex, await readFile(unitCodex.path), { mode: 0o700 })
  for (const path of [context, buildContext, seedRoot]) {
    if (!keepPaths.includes(path)) await rm(path, { recursive: true, force: true })
  }
  await runCiRuntimeCommand('git', ['-C', repository, 'worktree', 'remove', '--force', source], { env, signal })
  const prepared: PreparedCiRuntime = {
    commit, imageId: `sha256:${image.Id.replace(/^sha256:/u, '')}`, imageManifestDigest: image.Digest,
    seedReceiptPath, contextReceiptPath, qualificationSource, cache,
  }
  if (unitCodex) {
    prepared.unitCodex = { executable: '/opt/graphql-ci/tools/codex', sourceExecutable: codex,
      version: unitCodex.version, binarySha256: unitCodex.sha256 }
  }
  signal?.throwIfAborted()
  await writeCiRuntimeCache({ installer, inputDigest, prepared })
  stage('prune-images')
  await pruneCiImages({ keep: [...keepImages, prepared.imageId], env, installer, signal })
  return prepared
}

async function writeRuntimeReceipt(installer: string, kind: 'seed' | 'context', bytes: Buffer): Promise<string> {
  // Rebuilding the same commit can change review and package metadata held by an older configuration.
  const path = join(installer, `${kind}-receipt-${hash(bytes)}.json`)
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readProtectedRuntimeFile({ path, ownerUid: process.getuid!() }, 16 * 1024 * 1024)
    if (!existing.equals(bytes)) throw new Error('A retained CI receipt changed.', { cause: error })
  }
  return path
}

export const CODEX_CAPTURE_MEMORY_BYTES = 3 * 2 ** 30

export async function codexBinary(image: string, output: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  signal?.throwIfAborted()
  // No host paths or credentials are mounted into the package/tool execution boundary.
  const script = `
    const { cpSync, readFileSync } = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const { createRequire } = require('node:module');
    const { dirname, join } = require('node:path');
    cpSync('/opt/graphql-ci/source-lock', '/tmp/source', { recursive: true });
    cpSync('/opt/graphql-ci/pnpm-store', '/tmp/store', { recursive: true });
    cpSync('/opt/graphql-ci/corepack-cache', '/tmp/corepack', { recursive: true });
    execFileSync('/usr/local/bin/node', ['/usr/local/lib/node_modules/corepack/dist/corepack.js',
      'pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/tmp/store'],
      // CI: this disposable copy may carry a node_modules layout from another lockfile; pnpm purges it only non-interactively.
      { cwd: '/tmp/source', env: { ...process.env, CI: 'true', COREPACK_HOME: '/tmp/corepack', COREPACK_ENABLE_NETWORK: '0' },
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const api = createRequire('/tmp/source/apps/api/package.json');
    const launcher = api.resolve('@openai/codex/bin/codex.js');
    const native = createRequire(launcher).resolve('@openai/codex-linux-x64/package.json');
    const binary = join(dirname(native), 'vendor/x86_64-unknown-linux-musl/bin/codex');
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    process.stderr.write(JSON.stringify({ version }));
    process.stdout.write(readFileSync(binary));
  `
  // The binary (hundreds of MB) streams raw to the file; its version arrives on stderr.
  const path = join(output, 'unit-codex')
  await rm(path, { force: true })
  const container = `foreman-ci-codex-${randomUUID()}`
  // The copied store and its install live in the tmpfs, which counts against the container's memory. With the
  // 1 GiB Foreman Code store the capture peaks at 2.6 GiB (measured on Laptop), so it gets 3 GiB, not 2.
  const limits = ciPreparationLimits()
  const captureMemoryBytes = Math.min(CODEX_CAPTURE_MEMORY_BYTES, limits.memoryBytes)
  const captureLimits = ciPreparationResourceArgs({ cpuCount: Math.min(2, limits.cpuCount), memoryBytes: captureMemoryBytes })
  const child = spawn('podman', ['--remote=false', 'run', '--name', container, '--rm', '--pull=never', '--network=none', '--read-only',
    '--cap-drop=all', '--security-opt=no-new-privileges', ...captureLimits, '--pids-limit=256',
    `--tmpfs=/tmp:rw,exec,nosuid,nodev,size=${captureMemoryBytes}`, '--entrypoint=node', image, '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stderr!.on('data', (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-65_536) })
  const tasks = [pipeline(child.stdout!, createWriteStream(path, { mode: 0o700, flags: 'wx' })),
    closeCiRuntimeCommand(child, 'Codex capture', signal)]
  try {
    await Promise.all(tasks)
  } catch (error) {
    child.kill('SIGKILL')
    await Promise.allSettled(tasks)
    await podman(['rm', '--force', '--ignore', container], env, AbortSignal.timeout(30_000))
    await rm(path, { force: true })
    throw error
  }
  const version = (() => { try { return (JSON.parse(diagnostics.slice(diagnostics.lastIndexOf('{'))) as { version?: unknown }).version } catch { return undefined } })()
  const bytes = await readFile(path)
  if (typeof version !== 'string' || !version || !bytes.length) throw new Error('The isolated Codex capture is incomplete.')
  return { path, version, sha256: hash(bytes) }
}

/** Same receipt the CI image policy verifies: every locked release with its registry publish time. */
export async function createSeedReceipt({ repository, seed, review, signal }: {
  repository: string; seed: string; review: CiRuntimeReview; signal?: AbortSignal | undefined
}) {
  signal?.throwIfAborted()
  const lock = parseCiLock(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  const packages = Object.entries(lock.packages ?? {}).map(([key, value]) => {
    const at = key.lastIndexOf('@')
    return { name: key.slice(0, at), version: key.slice(at + 1), integrity: value.resolution.integrity }
  })
  const names = [...new Set(packages.map(value => value.name))]
  const captured = new Map<string, { metadataPath: string; metadata: { time: Record<string, string> } }>()
  await mkdir(join(seed, 'metadata'), { recursive: true, mode: 0o700 })
  let cursor = 0
  const capture = async () => {
    while (cursor < names.length) {
      signal?.throwIfAborted()
      const name = names[cursor++]!
      const metadataPath = `metadata/${encodeURIComponent(name)}.json`
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) })
      if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`)
      const metadata = await response.json() as { versions?: Record<string, { dist?: { integrity?: string } }>; time?: Record<string, string>; modified?: string }
      const selected = { name, time: {} as Record<string, string>, versions: {} as Record<string, unknown> }
      for (const pkg of packages.filter(value => value.name === name)) {
        const entry = metadata.versions?.[pkg.version]
        if (!entry || entry.dist?.integrity !== pkg.integrity || !metadata.time?.[pkg.version]) {
          throw new Error(`Registry release differs from the frozen lockfile: ${name}@${pkg.version}`)
        }
        selected.time[pkg.version] = metadata.time[pkg.version]!
        selected.versions[pkg.version] = entry
      }
      await writeFile(join(seed, metadataPath), JSON.stringify(selected), { mode: 0o600 })
      for (const kind of ['metadata', 'metadata-full']) {
        const destination = join(seed, 'registry-cache/v11', kind, 'https%3A+registry.npmjs.org', `${name}.jsonl`)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, `${JSON.stringify({ etag: response.headers.get('etag'), modified: metadata.modified })}\n${JSON.stringify(metadata)}\n`, { mode: 0o600 })
      }
      captured.set(name, { metadataPath, metadata: selected })
    }
  }
  const captures = await Promise.allSettled(Array.from({ length: 4 }, capture))
  const failed = captures.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  signal?.throwIfAborted()
  const tracked = (await runCiRuntimeCommand('git', ['-C', repository, 'ls-tree', '-r', '--name-only', 'HEAD'],
    { env: process.env, signal })).stdout
  const inputPaths = tracked.trim().split('\n').filter(path => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path)).sort()
  const dependencyInputs = await Promise.all(inputPaths.map(async path => ({ path, sha256: hash(await readFile(join(repository, path))) })))
  const files: { path: string; bytes: number; sha256: string }[] = []
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else {
        const file = join(directory, entry.name)
        const info = await lstat(file)
        if (!info.isFile() || info.nlink !== 1) throw new Error(`Nonregular seed entry: ${path}`)
        const bytes = await readFile(file)
        files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
      }
    }
  }
  await walk(seed)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const capturedAt = new Date().toISOString()
  const releases = packages.map(pkg => ({ ...pkg, publishedAt: captured.get(pkg.name)!.metadata.time[pkg.version],
    metadataPath: captured.get(pkg.name)!.metadataPath }))
  return { schemaVersion: 1, packageManager: 'pnpm@11.27.0', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
    minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false, capturedAt,
    provenanceDigest: hash(JSON.stringify({ dependencyInputs, releases, inventory: files })),
    review: { ...review, reviewedAt: capturedAt }, maxBytes: 20 * 2 ** 30, maxInodes: 1_000_000, dependencyInputs, files, packages: releases }
}

const podman = (args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) =>
  runCiRuntimeCommand('podman', ['--remote=false', ...args], { env, signal })
const podmanOut = async (args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) =>
  (await podman(args, env, signal)).stdout
const exists = (path: string) => stat(path).then(() => true, () => false)

/** Preparations run one at a time per computer and this installation's container store is theirs alone, so
 * Buildah working containers and build inputs present when one starts were left by an earlier preparation
 * that a Worker restart or an exhausted quota interrupted. Qualification sources still used stay in `keepPaths`. */
export async function reclaimInterruptedPreparation({ repository, installer, keepPaths, env, signal }: {
  repository: string; installer: string; keepPaths: readonly string[]; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined
}) {
  const containers = JSON.parse(await podmanOut(['ps', '--all', '--external', '--format', 'json'], env, signal) || '[]') as
    { Id: string; State?: string; Command?: string[] | null; Labels?: Record<string, string> }[]
  const installation = hash(installer)
  for (const container of containers) {
    // Libpod Job containers are not external; Buildah's are reported in storage state only.
    if (container.State === 'storage' && container.Command?.[0] === 'buildah') {
      await podman(['rm', '--force', container.Id], env, signal)
    } else if (container.Labels?.['io.foreman-code.installation'] === installation
      && container.Labels['io.foreman-code.ci-preparation'] === 'seed') {
      await podman(['rm', '--force', container.Id], env, signal)
    }
  }
  const kept = new Set(keepPaths)
  const names = await readdir(installer).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  for (const name of names) {
    signal?.throwIfAborted()
    const path = join(installer, name)
    if (kept.has(path)) continue
    if (/^source-[a-f0-9]{12}$/u.test(name)) {
      // Another workspace's clone may own the worktree; its own next preparation prunes that record.
      await runCiRuntimeCommand('git', ['-C', repository, 'worktree', 'remove', '--force', path], { env, signal })
        .catch(error => {
          signal?.throwIfAborted()
          if (!/is not a working tree/iu.test(String(error.stderr))) throw error
        })
      await rm(path, { recursive: true, force: true })
    } else if (/^(?:build-context|context|seed)-[a-f0-9]{12}$|^qualification-source-[a-f0-9]{12}(?:-[A-Za-z0-9]{6})?$/u.test(name)) {
      await rm(path, { recursive: true, force: true })
    }
  }
  await runCiRuntimeCommand('git', ['-C', repository, 'worktree', 'prune'], { env, signal })
}

export async function extractQualificationSource(repository: string, commit: string, qualificationSource: string,
  env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const directory = await mkdtemp(`${qualificationSource}-`)
  const archive = spawn('git', ['-C', repository, 'archive', '--format=tar', commit], { env })
  const extract = spawn('/bin/sh', ['-c', 'umask 077 && exec tar -x -C "$1"', 'sh', directory], { env })
  // tar may stop reading at the end-of-archive marker before git writes its trailing padding; both exit
  // codes still decide success, so only that early close of the pipe is not a failure.
  const copy = pipeline(archive.stdout, extract.stdin).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  })
  const tasks = [copy, closeCiRuntimeCommand(archive, 'git archive', signal),
    closeCiRuntimeCommand(extract, 'tar', signal)]
  try {
    await Promise.all(tasks)
    return directory
  } catch (error) {
    archive.kill('SIGKILL')
    extract.kill('SIGKILL')
    await Promise.allSettled(tasks)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
