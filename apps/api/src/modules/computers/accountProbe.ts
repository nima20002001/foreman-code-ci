import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ComputerAccountsSchema, type ComputerAccount, type ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import { fallbackOnMissing } from '../diagnostics/ignoredError.js'
import { DomainError } from '../errors.js'
import { executableUnavailable } from './executableError.js'

export interface AccountProbePorts {
  /** Absolute executable path, or null when the tool is not installed. */
  find(name: string): Promise<string | null>
  run(binary: string, args: string[], signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }>
  readText(path: string): Promise<string | null>
  probeIdentity?(tool: 'codex' | 'claude' | 'github', binary: string): Promise<string>
  environment: NodeJS.ProcessEnv
}

const ansi = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')
const plain = (value: string) => value.replace(ansi, '')

/** Passive sign-in facts for this computer. Reads identity only; tokens never leave the probe. */
export async function probeComputerAccounts(ports: AccountProbePorts = systemPorts(), signal = AbortSignal.timeout(20_000),
  options: { refresh?: boolean } = {}): Promise<ComputerAccounts> {
  const accounts = await Promise.all([
    inspectAccount('codex', () => codex(ports)).then(account => ({ account, observedAt: Date.now() })),
    inspectAccount('claude', () => cachedAccount(ports, 'claude', signal, options)),
    inspectAccount('github', () => cachedAccount(ports, 'github', signal, options)),
  ])
  const observedAt = Math.min(Date.now(), ...accounts.map(value => value.observedAt))
  return ComputerAccountsSchema.parse({ observedAt: new Date(observedAt).toISOString(),
    accounts: accounts.map(value => value.account) })
}

async function inspectAccount<T>(tool: ComputerAccount['tool'], read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof DomainError) throw error
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error
    const code = tool === 'github' ? 'GITHUB_STATUS_UNKNOWN' : 'COMPUTER_ACCOUNT_UNAVAILABLE'
    const failure = new DomainError(code, `${tool} account state could not be checked. Retry account inspection.`,
      502, { tool, retryable: true })
    failure.cause = error
    throw failure
  }
}

const unknown = (tool: ComputerAccount['tool']): ComputerAccount => ({ tool, installed: true, signedIn: null, account: null, details: [] })
const missing = (tool: ComputerAccount['tool']): ComputerAccount => ({ tool, installed: false, signedIn: null, account: null, details: [] })

interface AccountObservation { account: ComputerAccount; observedAt: number }
const accountProbes = new Map<string, { at: number; value: Promise<AccountObservation> }>()
async function cachedAccount(ports: AccountProbePorts, tool: 'claude' | 'github', signal: AbortSignal,
  options: { refresh?: boolean }): Promise<AccountObservation> {
  signal.throwIfAborted()
  const read = async () => {
    const account = await (tool === 'claude' ? claude(ports, signal) : probeGitHubAccount(ports, signal))
    return { account, observedAt: Date.now() }
  }
  if (!ports.probeIdentity) return read()
  const binary = await ports.find(tool === 'github' ? 'gh' : tool)
  if (!binary) return { account: missing(tool), observedAt: Date.now() }
  const identity = await ports.probeIdentity(tool, binary)
  const key = `${tool}:${identity}`
  const cached = accountProbes.get(key)
  const now = Date.now()
  if (!options.refresh && cached && now >= cached.at && now - cached.at < 30_000) {
    const account = await cached.value
    signal.throwIfAborted()
    return structuredClone(account)
  }
  const value = read()
  const entry = { at: now, value }
  if (accountProbes.size >= 64) accountProbes.delete(accountProbes.keys().next().value!)
  accountProbes.set(key, entry)
  try {
    const account = await value
    signal.throwIfAborted()
    // Keyring-backed sign-ins can change without a file, so keep a bounded lifetime.
    if (await ports.probeIdentity(tool, binary) !== identity && accountProbes.get(key) === entry) {
      accountProbes.delete(key)
    }
    return structuredClone(account)
  } catch (error) {
    if (accountProbes.get(key) === entry) accountProbes.delete(key)
    throw error
  }
}

async function codex(ports: AccountProbePorts): Promise<ComputerAccount> {
  if (!await ports.find('codex')) return missing('codex')
  const home = ports.environment.CODEX_HOME ?? join(ports.environment.HOME ?? homedir(), '.codex')
  const text = await ports.readText(join(home, 'auth.json'))
  // Codex can store credentials in the keyring without an auth.json file.
  if (text === null) return unknown('codex')
  const auth = JSON.parse(text) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown } | null }
  const email = typeof auth.tokens?.id_token === 'string' ? jwtEmail(auth.tokens.id_token) : null
  const apiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0
  return { tool: 'codex', installed: true, signedIn: Boolean(email || auth.tokens || apiKey), account: email,
    details: [apiKey && !auth.tokens ? 'API key' : auth.tokens ? 'ChatGPT' : null].filter((value): value is string => Boolean(value)) }
}

function jwtEmail(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
  return typeof claims.email === 'string' ? claims.email.slice(0, 320) : null
}

async function claude(ports: AccountProbePorts, signal: AbortSignal): Promise<ComputerAccount> {
  const binary = await ports.find('claude')
  if (!binary) return missing('claude')
  const result = await ports.run(binary, ['auth', 'status'], signal)
  // An install whose executable cannot start (for example a missing loader) says nothing at all.
  if (result.code === null && !result.stdout && !result.stderr) {
    throw new Error('Claude account inspection could not start.')
  }
  let status: { loggedIn?: unknown; email?: unknown; authMethod?: unknown }
  try { status = JSON.parse(result.stdout) as typeof status } catch {
    // Signed-out releases print a login prompt instead of JSON.
    if (result.code !== 0 && /\/login|not logged in|invalid api key/iu.test(`${result.stdout}\n${result.stderr}`)) {
      return { tool: 'claude', installed: true, signedIn: false, account: null, details: [] }
    }
    throw new Error('Unreadable Claude sign-in status.')
  }
  if (!status || typeof status.loggedIn !== 'boolean' || result.code !== 0 && status.loggedIn !== false) {
    throw new Error(`Claude account inspection failed (exit ${result.code}).`)
  }
  return { tool: 'claude', installed: true, signedIn: status.loggedIn,
    account: typeof status.email === 'string' ? status.email.slice(0, 320) : null,
    details: typeof status.authMethod === 'string' ? [status.authMethod.slice(0, 200)] : [] }
}

const githubStatusSchema = z.object({
  hosts: z.record(z.string(), z.array(z.object({
    active: z.boolean(), login: z.string().min(1).max(320), state: z.enum(['success', 'error', 'timeout']),
  }))),
})
const githubSignedOut = /You are not logged into (?:any GitHub hosts|any accounts on github\.com)/iu

export function probeGitHubAccount(ports: AccountProbePorts, signal = AbortSignal.timeout(20_000)): Promise<ComputerAccount> {
  return inspectAccount('github', () => readGitHubAccount(ports, signal))
}

async function readGitHubAccount(ports: AccountProbePorts, signal: AbortSignal): Promise<ComputerAccount> {
  const binary = await ports.find('gh')
  if (!binary) return missing('github')
  const args = ['auth', 'status', '--active', '--hostname', 'github.com']
  let result = await ports.run(binary, [...args, '--json', 'hosts'], signal)
  const unsupported = (flag: string) => new RegExp(`unknown flag: --${flag}\\b`, 'u').test(result.stderr)
  if (!unsupported('json') && !unsupported('active')) {
    if (result.code === 1 && githubSignedOut.test(result.stderr)) return { ...unknown('github'), signedIn: false }
    if (result.code !== 0) throw new Error(`GitHub account inspection failed (exit ${result.code}).`)
    const parsed = githubStatusSchema.safeParse(parseJson(result.stdout))
    if (parsed.success) {
      const entries = parsed.data.hosts['github.com'] ?? []
      if (!entries.length) return { ...unknown('github'), signedIn: false }
      const active = entries.filter(entry => entry.active)
      if (active.length !== 1 || active[0]!.state !== 'success') {
        throw new Error('GitHub account inspection did not establish an active account.')
      }
      return { ...unknown('github'), signedIn: true, account: active[0]!.login }
    }
    throw new Error('GitHub account inspection returned invalid output.')
  }
  result = await ports.run(binary, args, signal)
  if (unsupported('active')) result = await ports.run(binary, ['auth', 'status', '--hostname', 'github.com'], signal)
  const output = plain(`${result.stdout}\n${result.stderr}`)
  if (result.code === 1 && githubSignedOut.test(output)) {
    return { ...unknown('github'), signedIn: false }
  }
  const accounts = [...output.matchAll(/Logged in to github\.com account (\S+)([\s\S]*?)(?=Logged in to github\.com account|$)/gu)]
  const active = accounts.filter(match => /Active account:\s*true/u.test(match[2]!))
  let user = active.length === 1 ? active[0]?.[1] : undefined
  if (active.length === 0 && accounts.length === 1 && !/Active account:\s*false/u.test(output)) user = accounts[0]?.[1]
  if (result.code !== 0 || !user) throw new Error(`GitHub account inspection failed (exit ${result.code}).`)
  return { ...unknown('github'), signedIn: true, account: user }
}

function parseJson(value: string): unknown {
  return JSON.parse(value)
}

/** Explicit installer selections must be usable; PATH discovery applies only to unconfigured commands. */
export function systemPorts(environment: NodeJS.ProcessEnv = process.env,
  binaries: Readonly<Partial<Record<string, string>>> = {}): AccountProbePorts {
  const home = environment.HOME ?? homedir()
  const directories = [...(environment.PATH ?? '').split(delimiter), join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((value, index, all) => value.startsWith('/') && all.indexOf(value) === index)
  return {
    environment,
    async probeIdentity(tool, binary) {
      const selected = await realpath(binary)
      const executable = await stat(selected, { bigint: true })
      const config = environment.XDG_CONFIG_HOME ?? join(home, '.config')
      let files: string[]
      if (tool === 'codex') {
        files = ['auth.json', 'config.toml'].map(name => join(environment.CODEX_HOME ?? join(home, '.codex'), name))
      } else if (tool === 'claude') {
        files = [join(environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json'), join(home, '.claude.json')]
      } else {
        files = ['hosts.yml', 'config.yml'].map(name => join(environment.GH_CONFIG_DIR ?? join(config, 'gh'), name))
      }
      const metadata = await Promise.all(files.map(async path => {
        try {
          const value = await stat(path, { bigint: true })
          return [path, value.dev, value.ino, value.size, value.mode, value.mtimeNs, value.ctimeNs].join(':')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${path}:missing`
          throw error
        }
      }))
      const hash = createHash('sha256')
      hash.update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
      hash.update([selected, executable.dev, executable.ino, executable.size, executable.mode,
        executable.mtimeNs, executable.ctimeNs, ...metadata].join(':'))
      return hash.digest('hex')
    },
    async find(name) {
      const selected = binaries[name]
      if (selected) {
        try {
          await access(selected, constants.X_OK)
          return selected
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? 'ACCESS_FAILED'
          throw executableUnavailable(name, selected, home, code)
        }
      }
      for (const directory of directories) {
        const candidate = join(directory, name)
        try { await access(candidate, constants.X_OK); return candidate }
        catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
      return null
    },
    run: (binary, args, signal) => new Promise((resolve, reject) => {
      execFile(binary, args, { signal, timeout: 15_000, maxBuffer: 256 * 1024, encoding: 'utf8',
        env: { ...environment, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') { reject(error); return }
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0
        resolve({ code, stdout, stderr })
      })
    }),
    readText: path => readFile(path, 'utf8').catch(fallbackOnMissing(null)),
  }
}
