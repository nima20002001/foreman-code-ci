import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type pg from 'pg'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerArtifactReplySchema } from '@foreman-code/contracts/computer-maintenance'
import { createWorkerArtifactExtension, readWorkerBundleIdentity } from './workerArtifacts.js'
import { createProductionWorkerArtifactExtension } from './workerArtifactsProduction.js'

const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }
const context = { binding: {
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '33333333-3333-4333-8333-333333333333', bootId: '44444444-4444-4444-8444-444444444444',
  connectionEpoch: '55555555-5555-4555-8555-555555555555', keyRevision: 1,
  authorizationRevision: 1, connectionGeneration: 1,
}, signal: new AbortController().signal }
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function release() {
  const storage = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const directory = await mkdtemp(join(storage, 'worker-production-release-'))
  directories.push(directory)
  const artifacts = join(directory, 'worker-artifacts')
  await mkdir(artifacts, { mode: 0o700 })
  await mkdir(join(directory, 'apps/api'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'foreman-code', version: '0.0.56' }))
  await writeFile(join(directory, 'apps/api/package.json'), JSON.stringify({ name: '@foreman-code/api', version: '0.1.0' }))
  const content = Buffer.from('export {}\n')
  const manifest = { format: 1, version: '0.0.56', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
    sourceSnapshot: { commit: 'a'.repeat(40), files: [] },
    files: [{ path: 'src/cli.mjs', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  await mkdir(join(artifacts, manifestSha256, 'src'), { mode: 0o700, recursive: true })
  await writeFile(join(artifacts, manifestSha256, 'src/cli.mjs'), content)
  await writeFile(join(artifacts, manifestSha256, 'manifest.json'), manifestBytes)
  const index = { format: 1, version: manifest.version, artifacts: [{ target, manifestSha256 }],
    github: { repository: 'example/worker', tag: `worker-${manifest.commit}` },
    publication: { state: 'published', lastError: null } }
  await writeFile(join(artifacts, 'index.json'), JSON.stringify(index))
  return { directory, artifacts, manifest, manifestSha256, index }
}

describe('production Worker artifact composition', () => {
  it('serves product release 0.0.56 while the API package uses version 0.1.0', async () => {
    const f = await release()
    const extension = createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory })
    const reply = WorkerArtifactReplySchema.parse((await extension.handle!({ operation: 'release', target }, context)).payload)
    expect(reply).toEqual({ operation: 'release', release: {
      version: '0.0.56', manifestSha256: f.manifestSha256, manifest: f.manifest, github: f.index.github,
    } })
  })

  it('rejects artifacts for another product release instead of accepting the API package version', async () => {
    const f = await release()
    await writeFile(join(f.artifacts, 'index.json'), JSON.stringify({ ...f.index, version: '0.1.0' }))
    const extension = createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory })
    await expect(extension.handle!({ operation: 'release', target }, context)).rejects.toThrow()
  })

  it('uses the configured artifact directory while keeping the installed product version check', async () => {
    const f = await release()
    const other = await release()
    await writeFile(join(other.artifacts, 'index.json'), JSON.stringify({ ...other.index, version: '0.0.57' }))
    const extension = createProductionWorkerArtifactExtension({
      environment: { FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY: other.artifacts }, releaseDirectory: f.directory,
    })
    await expect(extension.handle!({ operation: 'release', target }, context)).rejects.toThrow()
  })

  it('requires the root product manifest and rejects invalid release metadata', async () => {
    const f = await release()
    await rm(join(f.directory, 'package.json'))
    expect(() => createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory })).toThrow()
    await writeFile(join(f.directory, 'package.json'), JSON.stringify({ name: '@foreman-code/api', version: '0.1.0' }))
    expect(() => createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory })).toThrow()
  })
})

it('only includes CI smoke for an enabled authenticated build computer and pins the artifact commit', async () => {
  const f = await release()
  const github = { repository: 'octo/project', tag: 'worker-' + 'a'.repeat(12) }
  await writeFile(join(f.artifacts, 'index.json'), JSON.stringify({ ...f.index, github }))
  for (const enabled of [false, true]) {
    const extension = createWorkerArtifactExtension({ directory: f.artifacts, version: f.manifest.version,
      buildEnabled: async binding => {
        expect(binding).toEqual(context.binding)
        return enabled
      } })
    const reply = WorkerArtifactReplySchema.parse((await extension.handle!({ operation: 'ci-smoke',
      manifestSha256: f.manifestSha256 }, context)).payload)
    expect(reply.operation).toBe('ci-smoke')
    if (reply.operation !== 'ci-smoke') throw new Error('Expected smoke configuration')
    expect(reply.ciSmoke).toEqual(enabled ? { repository: github.repository, commit: f.manifest.commit } : null)
  }
})

it('keeps release announcements readable by retained Workers before updating them', async () => {
  const f = await release()
  const github = { repository: 'octo/project', tag: 'worker-' + 'a'.repeat(12) }
  await writeFile(join(f.artifacts, 'index.json'), JSON.stringify({ ...f.index, github }))
  const extension = createWorkerArtifactExtension({ directory: f.artifacts, version: f.manifest.version,
    buildEnabled: async () => true })
  const payload = (await extension.handle!({ operation: 'release', target }, context)).payload
  expect(payload).toEqual({ operation: 'release', release: {
    version: f.manifest.version, manifestSha256: f.manifestSha256, manifest: f.manifest, github,
  } })
})


it('withholds release and CI smoke while the GitHub asset remains unpublished', async () => {
  const f = await release()
  await writeFile(join(f.artifacts, 'index.json'), JSON.stringify({ ...f.index, github: undefined,
    publication: { state: 'pending', lastError: null } }))
  const smoke = { repository: 'example/product', commit: f.manifest.commit }
  await writeFile(join(f.directory, 'ci-smoke.json'), JSON.stringify(smoke))
  const pool = { query: async () => ({ rows: [{}] }) } as unknown as pg.Pool
  const extension = createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory, pool })
  for (const request of [{ operation: 'release', target },
    { operation: 'ci-smoke', manifestSha256: f.manifestSha256 }]) {
    await expect(extension.handle!(request, context))
      .rejects.toMatchObject({ code: 'WORKER_RELEASE_ASSET_UNAVAILABLE' })
  }
})

it('reports missing smoke configuration concretely and never skips smoke for enabled build computers', async () => {
  const f = await release()
  const pool = { query: async () => ({ rows: [{}] }) } as unknown as pg.Pool
  const extension = createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory, pool })
  await expect(extension.handle!({ operation: 'ci-smoke', manifestSha256: f.manifestSha256 }, context))
    .rejects.toMatchObject({ code: 'WORKER_UPDATE_SMOKE_UNAVAILABLE' })
  await writeFile(join(f.directory, 'ci-smoke.json'), JSON.stringify({ repository: 'example/product', commit: 'c'.repeat(40) }))
  await expect(extension.handle!({ operation: 'ci-smoke', manifestSha256: f.manifestSha256 }, context))
    .rejects.toMatchObject({ code: 'WORKER_UPDATE_SMOKE_UNAVAILABLE' })
})

it('serves retained GitHub bundles with their original manifest and smoke for the installed release', async () => {
  const f = await release()
  const version = '0.0.57'
  const commit = 'c'.repeat(40)
  await writeFile(join(f.directory, 'package.json'), JSON.stringify({ name: 'foreman-code', version }))
  const github = { repository: 'example/worker', tag: `worker-${commit}` }
  const index = { ...f.index, version, commit, github,
    artifacts: [{ target, manifestSha256: f.manifestSha256, github: f.index.github }] }
  await writeFile(join(f.artifacts, 'index.json'), JSON.stringify(index))
  const ciSmoke = { repository: github.repository, commit }
  await writeFile(join(f.directory, 'ci-smoke.json'), JSON.stringify(ciSmoke))
  const pool = { query: async () => ({ rows: [{}] }) } as unknown as pg.Pool
  const extension = createProductionWorkerArtifactExtension({ environment: {}, releaseDirectory: f.directory, pool })
  const reply = WorkerArtifactReplySchema.parse((await extension.handle!({ operation: 'release', target }, context)).payload)
  expect(reply).toEqual({ operation: 'release', release: {
    version: f.manifest.version, manifest: f.manifest, manifestSha256: f.manifestSha256, github: f.index.github,
  } })
  expect(await readWorkerBundleIdentity({ directory: f.artifacts, version }, target))
    .toMatchObject({ version: f.manifest.version, manifestSha256: f.manifestSha256 })
  expect((await extension.handle!({ operation: 'ci-smoke', manifestSha256: f.manifestSha256 }, context)).payload)
    .toEqual({ operation: 'ci-smoke', ciSmoke })
})
