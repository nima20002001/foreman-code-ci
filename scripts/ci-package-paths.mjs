import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertRequiredNativePayloads } from './ci-native-payloads.mjs'

export function writeCiPackagePaths(root, paths) {
  mkdirSync(join(root, '.logs'), { recursive: true })
  writeFileSync(join(root, '.logs/ci-package-paths.json'), JSON.stringify(paths))
}

export function readCiPackagePaths(root, environment = process.env) {
  if (environment.PNPM_CONFIG_STORE_DIR && environment.PNPM_CONFIG_CACHE_DIR) {
    return { storeDir: environment.PNPM_CONFIG_STORE_DIR, cacheDir: environment.PNPM_CONFIG_CACHE_DIR }
  }
  const record = join(root, '.logs/ci-package-paths.json')
  if (existsSync(record)) return JSON.parse(readFileSync(record, 'utf8'))
  const cacheDir = environment.PNPM_CONFIG_CACHE_DIR ?? environment.npm_config_cache_dir
  if (!cacheDir) throw new Error('CI package metadata cache is unavailable; repeat CI dependency setup.')
  const { parse } = createRequire(join(root, 'apps/api/package.json'))('yaml')
  const modules = parse(readFileSync(join(root, 'node_modules/.modules.yaml'), 'utf8'))
  const paths = { storeDir: environment.PNPM_CONFIG_STORE_DIR ?? environment.npm_config_store_dir ?? modules.storeDir,
    cacheDir }
  if (!isAbsolute(paths.storeDir) || !isAbsolute(paths.cacheDir)) throw new Error('CI package cache paths must be absolute.')
  return paths
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? process.cwd())
  assertRequiredNativePayloads(root)
  const paths = readCiPackagePaths(root)
  writeCiPackagePaths(root, paths)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  console.log(`export PNPM_CONFIG_STORE_DIR=${quote(paths.storeDir)} PNPM_CONFIG_CACHE_DIR=${quote(paths.cacheDir)}`)
}
