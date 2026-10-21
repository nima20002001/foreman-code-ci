import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Content identities are independent of checkout paths and change on an in-place rebuild.
 * @param {string} root
 * @returns {{ version: 1, buildId: string, contractsId: string }}
 */
export function createRuntimeBuildIdentity(root) {
  const build = createHash('sha256')
  const contracts = createHash('sha256')
  /** @param {string} path */
  function add(path) {
    const bytes = readFileSync(join(root, path))
    // Length framing keeps names and bytes unambiguous without canonicalizing source content.
    const header = `${Buffer.byteLength(path)}:${path}:${bytes.length}:`
    build.update(header).update(bytes)
    if (path.startsWith('packages/contracts/')) contracts.update(header).update(bytes)
  }
  /** @param {string} directory */
  function walk(directory) {
    const entries = readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => {
      if (a.name === b.name) return 0
      return a.name < b.name ? -1 : 1
    })
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) add(path)
    }
  }
  for (const directory of ['apps/api/src', 'apps/web/src', 'apps/web/public', 'packages/contracts/src']) walk(directory)
  for (const path of ['package.json', 'pnpm-lock.yaml', 'apps/web/index.html', 'apps/web/vite.config.ts',
    'apps/api/package.json', 'apps/web/package.json', 'packages/contracts/package.json', 'scripts/copy-api-runtime.mjs']) {
    if (existsSync(join(root, path))) add(path)
  }
  return { version: 1, buildId: build.digest('hex'), contractsId: contracts.digest('hex') }
}
