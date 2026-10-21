import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repairRequiredNativePayloads } from './ci-store-prefetch.mjs'
import { assertRequiredNativePayloads } from './ci-native-payloads.mjs'
import { writeCiPackagePaths } from './ci-package-paths.mjs'

function nativePayloadsReady(root, options) {
  try {
    repairRequiredNativePayloads(root, options)
    return true
  } catch (error) {
    console.error(error.message)
    return false
  }
}

function workspaceDirectories(root) {
  const directories = []
  for (const parent of ['apps', 'packages']) {
    if (!existsSync(join(root, parent))) continue
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${entry.name}`
      if (entry.isDirectory() && existsSync(join(root, directory, 'package.json'))) directories.push(directory)
    }
  }
  return directories.sort()
}

export function packagesCacheKey(root) {
  const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'scripts/require-pnpm.mjs',
    ...workspaceDirectories(root).map(directory => `${directory}/package.json`)]
  const hash = createHash('sha256').update(process.version).update(process.platform).update(process.arch)
  for (const input of inputs) {
    if (existsSync(join(root, input))) hash.update(input).update('\0').update(readFileSync(join(root, input))).update('\0')
  }
  return hash.digest('hex')
}

function install(root) {
  const key = packagesCacheKey(root)
  const stamp = join(root, 'node_modules/.ci-packages-key')
  const restored = join(root, '.logs/ci-packages-restored')
  const paths = { storeDir: join(root, 'node_modules/.pnpm-store'), cacheDir: join(root, '.logs/pnpm-metadata') }
  const args = ['install', '--frozen-lockfile', '--store-dir', paths.storeDir,
    '--cache-dir', paths.cacheDir, '--package-import-method=hardlink']
  const run = (argumentsList, cwd = root) => {
    const result = spawnSync('corepack', ['pnpm', ...argumentsList], { cwd, env: process.env, stdio: 'inherit' })
    if (result.error) throw result.error
    return result.status ?? 1
  }
  const nativeOptions = { ...paths, run, installArgs: args, validate: assertRequiredNativePayloads }
  rmSync(restored, { force: true })
  const complete = ['node_modules/.pnpm', 'node_modules/.modules.yaml',
    ...workspaceDirectories(root).map(directory => `${directory}/node_modules`)]
    .every(path => existsSync(join(root, path)))
  if (complete && existsSync(stamp) && readFileSync(stamp, 'utf8') === key) {
    if (!nativePayloadsReady(root, nativeOptions)) {
      rmSync(stamp, { force: true })
      return 1
    }
    mkdirSync(join(root, '.logs'), { recursive: true })
    writeFileSync(restored, key)
    writeCiPackagePaths(root, paths)
    console.log('[ci-cache] installed packages reused')
    return 0
  }
  rmSync(stamp, { force: true })
  let status = run([...args, '--offline'])
  if (status !== 0 && process.env.CI_PNPM_STORE_CACHE_HIT !== 'true') status = run(args)
  if (status === 0) {
    if (!nativePayloadsReady(root, nativeOptions)) return 1
    writeFileSync(stamp, key)
    writeCiPackagePaths(root, paths)
  }
  return status
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, root = process.cwd()] = process.argv.slice(2)
  if (action === 'key') console.log(packagesCacheKey(root))
  else if (action === 'install') process.exitCode = install(root)
  else throw new Error('Usage: ci-packages.mjs key|install [root]')
}
