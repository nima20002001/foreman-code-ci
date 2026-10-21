import { chmod, cp, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'

async function copyOptional(source, destination) {
  try {
    await lstat(source)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(source, destination, { recursive: true, dereference: true })
}

async function copyPluginCache(source, destination) {
  let root
  try {
    root = await realpath(source)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(root, destination, {
    recursive: true,
    dereference: false,
    filter: async (entry, target) => {
      if (!(await lstat(entry)).isSymbolicLink()) return true
      const resolved = resolve(dirname(entry), await readlink(entry))
      const suffix = relative(root, resolved)
      const internal = suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
      if (internal) {
        // Mirror internal aliases, including missing versions, inside the owned cache.
        const owned = join(destination, suffix)
        await symlink(relative(dirname(target), owned), target)
      } else {
        // Native writes through an external alias must never reach the source profile.
        await cp(resolved, target, { recursive: true, dereference: true })
      }
      return false
    },
  })
}

/** Keep native credentials/configuration, while owning every test-created history and cache. */
export async function withNativeAcceptanceStorage(source, execute) {
  const originalHome = source.HOME ?? homedir()
  const sourceMcpDirectory = readProductEnvironment(source, 'APP_MCP_DIRECTORY')
    ?? join(originalHome, '.local', 'share', 'graphql', 'mcp')
  const root = await mkdtemp(join(source.TMPDIR ?? tmpdir(), 'foreman-code-native-'))
  const environment = {
    ...source,
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    TMPDIR: join(root, 'tmp'),
    FOREMAN_CODE_NATIVE_TEST_ROOT: root,
    FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY: sourceMcpDirectory,
    FOREMAN_CODE_APP_MCP_DIRECTORY: join(root, 'app-mcp'),
  }
  delete environment.GRAPHQL_APP_MCP_DIRECTORY
  try {
    for (const name of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
      await mkdir(environment[name], { recursive: true, mode: 0o700 })
    }
    const codex = source.CODEX_HOME ?? join(originalHome, '.codex')
    for (const name of ['auth.json', 'config.toml', 'models_cache.json', 'skills']) {
      await copyOptional(join(codex, name), join(environment.CODEX_HOME, name))
    }
    await copyPluginCache(join(codex, 'plugins'), join(environment.CODEX_HOME, 'plugins'))
    try {
      await writeFile(join(environment.CODEX_HOME, 'config.toml'), '', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    try {
      await chmod(join(environment.CODEX_HOME, 'auth.json'), 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return await execute(environment)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
