import { createServer } from 'node:net'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { readVerificationEnvironment } from '../../packages/contracts/src/verificationEnvironment.mjs'

export const BASE = '16b33373b3b2962dd0d0c57ad0b2f2c93198c400'
export const HELP = `ENG07-C isolated local acceptance (PostgreSQL 17; non-root Linux; macOS setup smoke only)
Usage: node scripts/acceptance/local.mjs [options]
  --api-port N       Loopback API port (default 3307)
  --web-port N       Loopback web port (default 5307)
  --codex-model ID   Also seed a Codex branch, using this authenticated model
  --smoke           Migrate, seed, verify HTTP/MCP and shut down; no native Runs
  --help            Print help without creating resources
No database URL, existing cluster, state directory or destructive-reset option.
Interactive commands: restart-api, crash-api, parity, parity RUN_ID, quit.
Run corepack pnpm db:up first. Native authentication uses FOREMAN_CODE_TEST_* credentials.
Quit/Ctrl-C removes only this invocation's state after orderly shutdown.
`
export function options(args) {
  const result = { apiPort: 3307, webPort: 5307, smoke: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (seen.has(key)) throw new Error('Duplicate option.')
    seen.add(key)
    if (key === '--help') { result.help = true; continue }
    if (key === '--smoke') { result.smoke = true; continue }
    if (!['--api-port', '--web-port', '--codex-model'].includes(key)) throw new Error('Unknown option.')
    const value = args[++i]
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Missing or invalid option value.')
    if (key.endsWith('-port')) {
      if (!/^[0-9]+$/.test(value) || +value < 1024 || +value > 65535) throw new Error('Ports must be integers from 1024 through 65535.')
      result[key === '--api-port' ? 'apiPort' : 'webPort'] = +value
    } else {
      if (!/^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)) throw new Error('Invalid Codex model identifier.')
      result.codexModel = value
    }
  }
  if (result.apiPort === result.webPort) throw new Error('API and web ports must differ.')
  return result
}

// Deliberately do not spread process.env. No ambient PG*, DATABASE_URL, .env,
// NODE_OPTIONS, proxy, dev principal, rollout flag or Vite configuration survives.
export function environment(source) {
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_BINARY',
    'FILE_STORAGE_ROOT', 'HARNESS_WORKSPACE_ROOT', 'LOG_DIR', 'COREPACK_HOME',
    'FOREMAN_CODE_TEST_ROOT', 'FOREMAN_CODE_TEST_OWNER', 'TEST_DATABASE_URL',
    'FOREMAN_CODE_CI_TEST_ADMIN_URL', 'FOREMAN_CODE_CI_HOST_RUN_ID',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

/** Build/identity probes may read the Job's fixed Git mount; API processes still use the smaller allowlist. */
export function verificationToolEnvironment(source) {
  if (!readVerificationEnvironment(source)) return {}
  return {
    FOREMAN_CODE_VERIFICATION_ENVIRONMENT: source.FOREMAN_CODE_VERIFICATION_ENVIRONMENT,
    GIT_DIR: '/graphql-job-git', GIT_WORK_TREE: '/workspace',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
  }
}
export async function freePort(port) {
  await new Promise((yes, no) => {
    const server = createServer()
    server.once('error', () => no(new Error('A selected loopback port is occupied. No service will be reused.')))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(yes))
  })
}
export async function assertOwned(state, owner) {
  if (!isAbsolute(state) || !/^eng07-[A-Za-z0-9]+$/.test(basename(state))) throw new Error('Unsafe state path.')
  const stat = await lstat(state)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || stat.uid !== process.getuid() || await realpath(state) !== state) throw new Error('State ownership changed.')
  const markerPath = join(state, 'owner.json')
  const markerStat = await lstat(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0
    || markerStat.uid !== process.getuid()) throw new Error('Unsafe ownership marker.')
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  if (marker.owner !== owner || marker.base !== BASE) throw new Error('Task ownership marker mismatch.')
}
export function publicError(error) {
  // Do not forward SQL, URLs, credentials, native output or arbitrary messages.
  const code = error?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(code) ? code : 'ACCEPTANCE_STEP_FAILED'
}
