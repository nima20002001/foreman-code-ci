import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWorkerArtifactExtension, readWorkerBundleIdentity } from '../src/modules/computers/workerArtifacts.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { remoteReviewWorkerArtifacts } from './helpers/remoteReviewWorkerArtifacts.js'

it('retains cached Worker manifests through symlinked cache ancestors without advertising unpublished bundles', async () => {
  const root = await privateFixtureDirectory('remote-review-artifacts-')
  try {
    const fixture = join(root, 'fixture')
    const release = join(fixture, 'release')
    const cache = join(root, 'storage')
    const alias = join(root, 'cache')
    await mkdir(join(release, 'src'), { recursive: true, mode: 0o700 })
    await mkdir(cache, { mode: 0o700 })
    await symlink(cache, alias)
    const content = Buffer.from('export const worker = true\n')
    const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }
    const manifest = {
      format: 1, version: '0.0.57', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
      packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
      files: [{ path: 'src/cli.mjs', size: content.length,
        sha256: createHash('sha256').update(content).digest('hex') }],
    }
    await writeFile(join(release, 'src/cli.mjs'), content, { mode: 0o600 })
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(release, 'manifest.json'), bytes, { mode: 0o600 })
    const [directory, reused] = await Promise.all([
      remoteReviewWorkerArtifacts(release, alias), remoteReviewWorkerArtifacts(release, cache),
    ])
    expect(directory).toBe(reused)
    expect(directory).toBe(await realpath(directory))
    const published = await remoteReviewWorkerArtifacts(release, cache, { publication: 'published' })
    await expect(readWorkerBundleIdentity({ directory: published, version: manifest.version }, target))
      .resolves.toMatchObject({ version: manifest.version, target,
        manifestSha256: createHash('sha256').update(bytes).digest('hex') })
    await rm(fixture, { recursive: true })
    const extension = createWorkerArtifactExtension({ directory, version: manifest.version })
    const context = {
      binding: {
        mainId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        workerInstallationId: '33333333-3333-4333-8333-333333333333',
        bootId: '44444444-4444-4444-8444-444444444444',
        connectionEpoch: '55555555-5555-4555-8555-555555555555',
        keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1,
      },
      signal: new AbortController().signal,
    }
    const manifestSha256 = createHash('sha256').update(bytes).digest('hex')
    await expect(extension.handle!({ operation: 'release', target }, context))
      .rejects.toMatchObject({ code: 'WORKER_RELEASE_ASSET_UNAVAILABLE' })
    await expect(extension.handle!({ operation: 'chunk', manifestSha256, path: 'src/cli.mjs', offset: 0 }, context))
      .rejects.toThrow()
    expect(await readFile(join(directory, manifestSha256, 'manifest.json'))).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
