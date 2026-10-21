import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkerArtifactManifestSchema } from '@foreman-code/contracts/computer-maintenance'
import { cachedTestFixture, testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'

/** Fixture publication metadata is isolated from real Worker releases. */
export async function remoteReviewWorkerArtifacts(release: string, cacheRoot = testFixtureCacheRoot(),
  options: { publication?: 'pending' | 'published' } = {}) {
  const source = await realpath(release)
  const bytes = await readFile(join(source, 'manifest.json'))
  const manifest = WorkerArtifactManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex')
  const publication = options.publication ?? 'pending'
  return cachedTestFixture(cacheRoot, 'worker-update-artifacts', [bytes, publication], async directory => {
    await cp(source, join(directory, manifestSha256), {
      recursive: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false,
    })
    await writeFile(join(directory, 'index.json'), `${JSON.stringify({
      format: 1, version: manifest.version, artifacts: [{ target: manifest.target, manifestSha256 }],
      publication: { state: publication, lastError: null },
      ...(publication === 'published'
        ? { github: { repository: 'example/worker', tag: `worker-${manifest.commit}` } } : {}),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  })
}
