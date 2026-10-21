import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorkerArtifactManifestSchema } from '@foreman-code/contracts/computer-maintenance'
import { workerArtifactContentSha256 } from '@foreman-code/contracts/worker-artifact-content-node'
import { readWorkerReleasePublication } from '../../src/modules/computers/workerArtifacts.js'
import { readWorkerBundleReadiness } from '../../src/modules/computers/workerBundleReadiness.js'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './privateFixtureDirectory.js'
import { remoteReviewWorkerArtifacts } from './remoteReviewWorkerArtifacts.js'

it('makes the installed review Worker bundle ready for new work using its published fixture release', async () => {
  await withPrivateFixtureDirectories(async () => {
    const directory = await privateFixtureDirectory('review-worker-artifacts-')
    const release = join(directory, 'release')
    await mkdir(join(release, 'src'), { recursive: true, mode: 0o700 })
    const content = Buffer.from('// Worker fixture\n')
    const manifest = WorkerArtifactManifestSchema.parse({
      format: 1,
      version: '0.0.100',
      commit: 'a'.repeat(40),
      lockfileSha256: 'b'.repeat(64),
      packageManager: 'pnpm@11.27.0',
      protocolVersion: 1,
      identityFormat: 1,
      target: { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2' },
      files: [{ path: 'src/cli.mjs', sha256: createHash('sha256').update(content).digest('hex'), size: content.length }],
    })
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    const manifestSha256 = createHash('sha256').update(bytes).digest('hex')
    const contentSha256 = workerArtifactContentSha256(manifest)
    await writeFile(join(release, 'src/cli.mjs'), content)
    await writeFile(join(release, 'manifest.json'), bytes)
    const artifacts = await remoteReviewWorkerArtifacts(release, join(directory, 'cache'), { publication: 'published' })
    const options = { directory: artifacts, version: manifest.version }
    expect(await readWorkerReleasePublication(options)).toEqual({
      version: manifest.version, state: 'published', lastError: null,
    })
    const readiness = await readWorkerBundleReadiness(options, {
      currentVersion: manifest.version,
      targetVersion: null,
      target: manifest.target,
      manifestSha256,
      contentSha256,
      state: 'current',
      lastError: null,
    })
    expect(readiness).toMatchObject({ ready: true, code: null, publicationError: null })
    expect(readiness.expected).toEqual({ version: manifest.version, target: manifest.target,
      manifestSha256, contentSha256 })
    expect(readiness.running).toEqual(readiness.expected)
    expect(await remoteReviewWorkerArtifacts(release, join(directory, 'cache'), { publication: 'published' })).toBe(artifacts)
  })
})
