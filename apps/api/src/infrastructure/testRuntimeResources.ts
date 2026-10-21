import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { testResourcesIdentity } from '@foreman-code/contracts/runtime-identity-node'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { ApiConfig } from '../config.js'
import { defaultFileStorageRoot } from '../modules/files/storage.js'
import { workspaceStorageRoot } from '../modules/workspaces/storage.js'
import { logFilePath } from './logger.js'

function assertTestRoot(resource: { directory: string; token: string }): void {
  if (!resource.directory || !/^[0-9a-f-]{36}$/.test(resource.token)) throw new Error('Test root ownership is required')
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Owned test resources require Unix file ownership support')
  const stat = lstatSync(resource.directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resource.directory) !== resolve(resource.directory)
    || (stat.mode & 0o077) !== 0 || stat.uid !== uid) throw new Error('Test root is not privately owned')
  const marker = join(resource.directory, '.graphql-test-owner.json')
  const markerStat = lstatSync(marker)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0
    || markerStat.uid !== uid) throw new Error('Test root ownership marker is unsafe')
  const owner = JSON.parse(readFileSync(marker, 'utf8')) as { directory?: unknown; token?: unknown }
  if (owner.directory !== resource.directory || owner.token !== resource.token) throw new Error('Test root ownership mismatch')
}

// The compiled API must validate ownership without importing source-checkout test scripts.
function assertTestPath(root: string, path: string): void {
  if (!isAbsolute(path)) throw new Error('Test path must be absolute')
  const target = resolve(path)
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Test path must remain inside its owned root')
  let ancestor = target
  for (;;) {
    try {
      const stat = lstatSync(ancestor)
      if (ancestor === target && stat.isSymbolicLink()) throw new Error('Test path must not be a symlink')
      const canonical = realpathSync(ancestor)
      if (canonical !== root && !canonical.startsWith(`${root}/`)) throw new Error('Test path escapes its owned root')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ancestor = dirname(ancestor)
    }
  }
}

export function readTestResourcesIdentity(config: ApiConfig): string | undefined {
  const environment = resolveProductEnvironment(process.env)
  if (!environment.FOREMAN_CODE_TEST_ROOT && !environment.FOREMAN_CODE_TEST_OWNER) return undefined
  const resource = { directory: environment.FOREMAN_CODE_TEST_ROOT!, token: environment.FOREMAN_CODE_TEST_OWNER! }
  assertTestRoot(resource)
  const home = environment.HOME ?? homedir()
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, '.config')
  const logFile = logFilePath(environment)
  const paths = [
    home, configHome,
    environment.XDG_DATA_HOME ?? join(home, '.local/share'),
    environment.XDG_CACHE_HOME ?? join(home, '.cache'),
    environment.XDG_STATE_HOME ?? join(home, '.local/state'),
    environment.XDG_RUNTIME_DIR,
    environment.CODEX_HOME ?? join(home, '.codex'),
    environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    environment.FOREMAN_CODE_APP_MCP_DIRECTORY ?? join(home, '.local/share/graphql/mcp'),
    environment.TMPDIR ?? tmpdir(),
    config.fileStorageRoot ?? defaultFileStorageRoot(),
    config.workspaceStorageRoot ?? workspaceStorageRoot(),
    config.harnesses.workspaceRoot,
    environment.FOREMAN_CODE_API_ENV_FILE,
    ...(logFile ? [dirname(logFile)] : []),
  ]
  for (const path of paths) {
    if (!path) throw new Error('Test API resource paths must be explicitly owned by the invocation')
    assertTestPath(resource.directory, path)
  }
  return testResourcesIdentity(resource.directory, resource.token)
}
