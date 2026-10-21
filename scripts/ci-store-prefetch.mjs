import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

function nativeDependency(root, parse) {
  const api = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'))
  const version = api.dependencies['@openai/codex']
  const platform = process.platform === 'android' ? 'linux' : process.platform
  const name = `@openai/codex-${platform}-${process.arch}`
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const reference = lock.snapshots?.[`@openai/codex@${version}`]?.optionalDependencies?.[name]
  const expected = `@openai/codex@${version}-${platform}-${process.arch}`
  if (reference !== expected || !lock.packages?.[reference]?.resolution?.integrity || !lock.snapshots?.[reference]) {
    throw new Error(`The frozen lockfile does not pin the required platform package ${name}.`)
  }
  return { name, reference, specifier: `npm:${reference}`, lock }
}

/** Make the host payload required in an isolated frozen install so pnpm cannot silently omit it. */
function provisionNativeStore(root, options) {
  const { parse, stringify } = createRequire(new URL('../apps/api/package.json', import.meta.url))('yaml')
  const dependency = nativeDependency(root, parse)
  const { name, reference, specifier, lock } = dependency
  mkdirSync(options.cacheDir, { recursive: true })
  const staging = mkdtempSync(join(options.cacheDir, 'ci-store-prefetch-'))
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const workspacePath = join(root, 'pnpm-workspace.yaml')
    const workspace = existsSync(workspacePath) ? parse(readFileSync(workspacePath, 'utf8')) : {}
    writeFileSync(join(staging, 'package.json'), JSON.stringify({ private: true,
      packageManager: manifest.packageManager, dependencies: { [name]: specifier } }))
    // This tree installs only an unpatched native payload; retain all registry and release-age settings.
    writeFileSync(join(staging, 'pnpm-workspace.yaml'), stringify({ ...workspace,
      packages: [], patchedDependencies: {} }))
    if (existsSync(join(root, '.npmrc'))) {
      writeFileSync(join(staging, '.npmrc'), readFileSync(join(root, '.npmrc')))
    }
    const nativeSnapshot = { ...lock.snapshots[reference] }
    delete nativeSnapshot.optional
    writeFileSync(join(staging, 'pnpm-lock.yaml'), stringify({
      lockfileVersion: lock.lockfileVersion, settings: lock.settings,
      importers: { '.': { dependencies: { [name]: { specifier, version: reference } } } },
      packages: { [reference]: lock.packages[reference] },
      snapshots: { [reference]: nativeSnapshot },
    }))
    const args = ['install', '--frozen-lockfile', '--ignore-scripts', '--config.confirm-modules-purge=false',
      '--store-dir', options.storeDir, '--cache-dir', options.cacheDir, '--package-import-method=hardlink']
    let verified = options.run([...args, '--lockfile-only', '--offline'], staging)
    if (verified !== 0 && !options.offlineOnly) {
      verified = options.run([...args, '--lockfile-only', '--prefer-offline'], staging)
    }
    if (verified !== 0) throw new Error(`Required native release-age verification failed (exit ${verified}).`)
    let status = options.run([...args, '--offline'], staging)
    if (status !== 0 && !options.offlineOnly) {
      console.log(`[ci-cache] downloading the required native package ${reference} into the shared store`)
      rmSync(join(staging, 'node_modules'), { recursive: true, force: true })
      status = options.run([...args, '--prefer-offline'], staging)
    }
    if (status !== 0) throw new Error(`Required native store provisioning failed (exit ${status}).`)
    return reference
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function repairRequiredNativePayloads(root, options) {
  const apiManifest = join(root, 'apps/api/package.json')
  if (!existsSync(apiManifest) || !JSON.parse(readFileSync(apiManifest, 'utf8')).dependencies?.['@openai/codex']) return
  let payloadError
  try {
    options.validate(root)
  } catch (error) {
    payloadError = error
  }
  try {
    const reference = provisionNativeStore(root, options)
    if (!payloadError) return
    console.log('[ci-cache] repairing the required native virtual-store package')
    rmSync(join(root, 'node_modules/.pnpm', reference.replaceAll('/', '+')), { recursive: true, force: true })
    // Reimport the missing package while retaining the unchanged installed dependencies.
    const status = options.run([...options.installArgs, '--offline',
      '--config.optimistic-repeat-install=false'], root)
    if (status !== 0) throw new Error(`Native payload reinstall failed (exit ${status}).`)
    // Module resolution may retain the pre-repair lookup during this process's module evaluation.
    const validation = spawnSync(process.execPath,
      [fileURLToPath(new URL('./ci-native-payloads.mjs', import.meta.url)), root], { stdio: 'inherit' })
    if (validation.error) throw validation.error
    if (validation.status !== 0) throw new Error('The repaired native payload failed executable validation.')
  } catch (error) {
    const name = `@openai/codex-${process.platform === 'android' ? 'linux' : process.platform}-${process.arch}`
    throw new Error(`CI_NATIVE_PAYLOAD_UNAVAILABLE: ${name}. ${error.message}`, { cause: error })
  }
}
