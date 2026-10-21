import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function pnpmFetchRecord(cache: string): string {
  return join(cache, 'locks', 'pnpm-fetch-key')
}

async function dependencyInputs(source: string) {
  const files = new Set(['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs']
    .filter(file => existsSync(join(source, file))))
  const addFile = (path: string) => {
    const file = relative(source, resolve(source, path))
    if (isAbsolute(file) || file === '..' || file.startsWith('..' + sep)) {
      throw new Error('CI prefetch requires dependency inputs inside the repository.')
    }
    files.add(file)
  }
  type PatchConfig = { patchedDependencies?: Record<string, string | { path: string }> }
  const lock = parse(await readFile(join(source, 'pnpm-lock.yaml'), 'utf8')) as PatchConfig & {
    packages?: Record<string, { resolution?: { tarball?: unknown } }>
  } | null
  for (const dependency of Object.values(lock?.packages ?? {})) {
    const tarball = dependency?.resolution?.tarball
    if (typeof tarball !== 'string' || !tarball.startsWith('file:')) continue
    addFile(tarball.slice('file:'.length))
  }
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { pnpm?: PatchConfig }
  const workspace = files.has('pnpm-workspace.yaml')
    ? parse(await readFile(join(source, 'pnpm-workspace.yaml'), 'utf8')) as PatchConfig | null : null
  for (const config of [manifest.pnpm, workspace]) {
    for (const patch of Object.values(config?.patchedDependencies ?? {})) {
      addFile(typeof patch === 'string' ? patch : patch.path)
    }
  }
  for (const patch of Object.values(lock?.patchedDependencies ?? {})) {
    if (typeof patch !== 'string') addFile(patch.path)
  }
  const directories = existsSync(join(source, 'patches')) ? ['patches'] : []
  while (directories.length) {
    const directory = directories.pop()!
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(file)
      else files.add(file)
    }
  }
  const hash = createHash('sha256').update(process.version).update('\0').update(process.platform)
    .update('\0').update(process.arch)
  const inputs = [...files].sort()
  for (const file of inputs) {
    hash.update(file).update('\0')
    for await (const bytes of createReadStream(join(source, file))) hash.update(bytes)
    hash.update('\0')
  }
  return { key: hash.digest('hex'), files: inputs }
}

/** Prefetches in an isolated tree so pnpm fetch cannot purge a live checkout's modules or hoist settings. */
export async function pnpmInstall(source: string, cache: string, messageFile: string,
  options: { offlineOnly?: boolean } = {}): Promise<string[]> {
  // Repository hooks can import arbitrary files that are absent from a dependency-only snapshot.
  const repositoryHook = existsSync(join(source, '.pnpmfile.cjs'))
  const inputs = repositoryHook ? undefined : await dependencyInputs(source)
  const staging = inputs ? join(cache, 'pnpm-fetch', inputs.key) : undefined
  const complete = pnpmFetchRecord(cache)
  const store = ` --store-dir ${shellQuote(join(cache, 'pnpm-store'))}`
    + ` --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
  const fetch = `corepack pnpm fetch --frozen-lockfile --config.confirm-modules-purge=false${store}`
  const installCommand = `corepack pnpm install --frozen-lockfile --config.confirm-modules-purge=false`
    + store
  const validator = join(source, 'scripts/ci-native-payloads.mjs')
  const validateNative = existsSync(validator)
  const install = validateNative ? 'install_ci_dependencies' : installCommand
  const ready = inputs
    ? `[ -f ${shellQuote(complete)} ] && [ "$(< ${shellQuote(complete)})" = ${shellQuote(inputs.key)} ]` : 'true'
  // pnpm can fetch tarballs concurrently with policy verification. Complete verification before provisioning.
  const verify = `${installCommand} --lockfile-only --ignore-scripts`
  const fetchOffline = validateNative ? `${verify} --offline && ${fetch} --offline` : `${fetch} --offline`
  const fetchOnline = validateNative ? `${verify} --prefer-offline && ${fetch} --prefer-offline`
    : `${fetch} --prefer-offline`
  const prefetch = options.offlineOnly ? fetchOffline
    : `${fetchOffline} || { echo '[ci-cache] filling store online'; ${fetchOnline}; }`
  return [
    `export npm_config_cache_dir=${shellQuote(join(cache, 'pnpm-metadata'))}`,
    `export npm_config_store_dir=${shellQuote(join(cache, 'pnpm-store'))}`,
    ...(validateNative ? [
      'native_store_offline=--offline',
      'install_ci_dependencies() {',
      `  ${installCommand} "$@" || return $?`,
      `  ${shellQuote(process.execPath)} ${shellQuote(validator)} ${shellQuote(source)} --repair $native_store_offline || {`,
      `    rm -f -- ${shellQuote(complete)}`,
      '    return 1',
      '  }',
      '}',
    ] : []),
    ...(repositoryHook ? [
      "echo '[ci-cache] prefetch unsupported for this layout (.pnpmfile.cjs); using normal install' >&2",
    ] : []),
    `${ready} && ${install} --offline || {`,
    `mkdir -p ${shellQuote(join(cache, 'locks'))}`,
    `exec {cache_lock}>${shellQuote(join(cache, 'locks', 'install.lock'))}`,
    'flock --wait 600 "$cache_lock" || {',
    `  printf '%s\\n' ${shellQuote(JSON.stringify({ message:
      'CI_INSTALL_LOCK_DEADLINE_EXCEEDED: install lock unavailable after 600 seconds.' }))} > ${shellQuote(messageFile)}`,
    '  finish 124',
    '}',
    // Dependency snapshots from the previous per-run copy scheme are no longer read.
    `rm -rf ${shellQuote(join(cache, 'modules'))}`,
    // Another request may have filled these inputs while this checkout waited for the lock.
    ...(!options.offlineOnly && validateNative ? ['native_store_offline='] : []),
    `${ready} && ${install} --offline || {`,
    ...(inputs && staging ? [
      '(',
      `rm -rf -- ${shellQuote(staging)} ${shellQuote(complete)} || exit $?`,
      `mkdir -p ${shellQuote(staging)} || exit $?`,
      ...inputs.files.flatMap(file => [
        `mkdir -p ${shellQuote(join(staging, dirname(file)))} || exit $?`,
        `cp -- ${shellQuote(join(source, file))} ${shellQuote(join(staging, file))} || exit $?`,
      ]),
      `(cd ${shellQuote(staging)} && { ${prefetch}; }) || exit $?`,
      `rm -rf -- ${shellQuote(staging)} || exit $?`,
      ')',
      'prefetch_code=$?',
      'if [ "$prefetch_code" != 0 ]; then',
      `rm -rf -- ${shellQuote(staging)}`
        + " || echo '[ci-cache] failed to remove prefetch staging directory' >&2",
      'echo "[ci-cache] full lockfile prefetch failed (exit $prefetch_code); suite will not run" >&2',
      'finish "$prefetch_code"',
      'fi',
      `${install} --offline || finish $?`,
      `printf '%s\\n' ${shellQuote(inputs.key)} > ${shellQuote(complete + '.pending')} || finish $?`,
      `mv -- ${shellQuote(complete + '.pending')} ${shellQuote(complete)} || finish $?`,
    ] : [
      // Both offline attempts failed; only the refill remains under the shared lock.
      ...(options.offlineOnly ? ['finish $?'] : [
        "echo '[ci-cache] filling store with normal install'",
        `${install} --prefer-offline || finish $?`,
      ]),
    ]),
    '}',
    'flock -u "$cache_lock"',
    'exec {cache_lock}>&-',
    '}',
    ...(existsSync(join(source, 'scripts/ci-package-paths.mjs')) ? [
      `mkdir -p ${shellQuote(join(source, '.logs'))} || finish $?`,
      `printf '%s\\n' ${shellQuote(JSON.stringify({ storeDir: join(cache, 'pnpm-store'),
        cacheDir: join(cache, 'pnpm-metadata') }))} > ${shellQuote(join(source, '.logs/ci-package-paths.json'))} || finish $?`,
    ] : []),
  ]
}
