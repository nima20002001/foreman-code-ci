import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { LOCAL_CLIENT_UNAVAILABLE, type ApiErrorResponse } from './index.js'
import { APP_MCP_TOKEN_NAMES } from './product.js'

const inspectSockets = promisify(execFile)
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const browserExecutables = [
  /^\/opt\/google\/chrome[^/]*\/chrome$/,
  /^\/opt\/microsoft\/msedge\/msedge$/,
  /^\/opt\/brave.com\/brave\/brave$/,
  /^\/usr\/lib\/chromium[^/]*\/(?:chrome|chromium)$/,
  /^\/usr\/lib\/firefox\/firefox$/,
]
const agentExecutable = /^(?:codex(?:-code-mode|-linux-sandbox)?|claude)(?:\.exe)?$/

export class LocalClientUnavailableError extends Error {
  readonly code = LOCAL_CLIENT_UNAVAILABLE

  constructor(options?: ErrorOptions) {
    super('Could not verify the local browser connection. Try again in a moment.', options)
    this.name = 'LocalClientUnavailableError'
  }
}

function agentCommand(executable: string, arguments_: readonly string[]): boolean {
  const commands = [executable, ...arguments_.slice(0, 2)]
  if (commands.some(command => agentExecutable.test(basename(command.replace(/ \(deleted\)$/, ''))))) return true
  return arguments_.slice(0, 3).some(argument =>
    /(?:^|\/)(?:@openai\/codex|@anthropic-ai\/claude-code)(?:\/|$)/.test(argument)
    || /(?:^|\/)(?:graphql-mcp\.mjs|graphql\/mcp\/launcher\.mjs)$/.test(argument))
}

async function inspectable<T>(read: Promise<T>): Promise<T | undefined> {
  try { return await read }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return undefined
    throw error
  }
}

interface ClientProcess {
  parent: number
  executable: string | undefined
  arguments: string[]
  credential: boolean
  hidden: boolean
}

function hasAppCredential(environment: readonly string[]): boolean {
  return environment.some(value => APP_MCP_TOKEN_NAMES.some(name =>
    value.startsWith(`${name}=`) && value.length > name.length + 1))
}

async function clientProcess(pid: number): Promise<ClientProcess> {
  if (process.platform === 'linux') {
    const [stat, executable, command, environment] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'), inspectable(readlink(`/proc/${pid}/exe`)),
      readFile(`/proc/${pid}/cmdline`, 'utf8'), inspectable(readFile(`/proc/${pid}/environ`, 'utf8')),
    ])
    return {
      parent: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
      executable,
      arguments: command.split('\0'),
      credential: environment !== undefined && hasAppCredential(environment.split('\0')),
      hidden: executable === undefined || environment === undefined,
    }
  }
  const [metadata, command] = await Promise.all([
    inspectSockets('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='],
      { timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { LC_ALL: 'C' } }),
    inspectSockets('/bin/ps', ['eww', '-p', String(pid), '-o', 'args='],
      { timeout: 2_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { LC_ALL: 'C' } })
      // The environment can contain credentials; discard command error output.
      .catch(() => { throw new LocalClientUnavailableError() }),
  ])
  const fields = metadata.stdout.trim().match(/^(\d+)\s+([\s\S]+)$/)
  if (!fields) throw new LocalClientUnavailableError()
  return {
    parent: Number(fields[1]), executable: fields[2], arguments: command.stdout.trim().split(/\s+/),
    credential: hasAppCredential(command.stdout.split(/\s+/)), hidden: false,
  }
}

async function runtimeParents(): Promise<Set<number>> {
  const parents = new Set<number>()
  const seen = new Set<number>()
  let pid = process.ppid
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid)
    const parent = await clientProcess(pid)
    if (parent.credential || agentCommand(parent.executable ?? '', parent.arguments)) break
    // The API and development proxy share a Node startup coordinator. Its own
    // setup probes remain local human requests; agent children are checked first.
    if (parent.executable === process.execPath) parents.add(pid)
    pid = parent.parent
  }
  return parents
}

async function agentAncestor(pid: number, parents: ReadonlySet<number>): Promise<boolean> {
  const seen = new Set<number>()
  let hiddenProcess = false
  let browserProcess = false
  while (pid > 1 && pid !== process.pid) {
    if (seen.has(pid)) return true
    seen.add(pid)
    const client = await clientProcess(pid)
    if (client.credential || agentCommand(client.executable ?? '', client.arguments)) return true
    hiddenProcess ||= client.hidden
    browserProcess ||= client.executable !== undefined
      && browserExecutables.some(pattern => pattern.test(client.executable!.replace(/ \(deleted\)$/, '')))
    if (parents.has(pid)) break
    pid = client.parent
    if (!Number.isInteger(pid) || pid < 0) return true
  }
  return hiddenProcess && !browserProcess
}

async function linuxClient(remoteAddress: string, remotePort: number,
  localAddress: string, localPort: number, parents: ReadonlySet<number>): Promise<boolean> {
  const filter = `( src ${remoteAddress} and sport = :${remotePort}`
    + ` and dst ${localAddress} and dport = :${localPort} )`
  const { stdout } = await inspectSockets('/usr/bin/ss',
    ['--tcp', '--no-header', '--numeric', '--extended', '--processes', filter], {
      timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { LC_ALL: 'C' },
    })
  const rows = stdout.trim().split('\n').filter(Boolean)
  if (rows.length !== 1 || !/\bcgroup:\S+/.test(rows[0]!)) throw new LocalClientUnavailableError()
  if (/(?:^|\/)graphql-native-[0-9a-f-]{36}(?:\/|\s|$)/.test(rows[0]!)) return false
  let pids = [...new Set([...rows[0]!.matchAll(/\bpid=(\d+)/g)].map(match => Number(match[1])))]
  if (!pids.length) {
    // Sandboxed browser network processes hide their FDs. Inspect the kernel's
    // entire socket cgroup so an agent in that boundary still prevents human access.
    const cgroup = rows[0]!.match(/\bcgroup:(\/\S*)/)?.[1]
    if (!cgroup || cgroup.split('/').includes('..')) throw new LocalClientUnavailableError()
    const members = await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')
    pids = members.trim().split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)
  }
  if (!pids.length) throw new LocalClientUnavailableError()
  return !(await Promise.all(pids.map(pid => agentAncestor(pid, parents)))).some(Boolean)
}

async function macClient(remoteAddress: string, remotePort: number,
  localAddress: string, localPort: number, parents: ReadonlySet<number>): Promise<boolean> {
  const { stdout } = await inspectSockets('/usr/sbin/lsof',
    ['-nP', '-a', `-iTCP:${remotePort}`, '-sTCP:ESTABLISHED', '-Fpn'], {
      timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { LC_ALL: 'C' },
    })
  const endpoint = (address: string, port: number) => {
    const normalized = address.replace(/^::ffff:/, '')
    return `${normalized.includes(':') ? `[${normalized}]` : normalized}:${port}`
  }
  const connection = `${endpoint(remoteAddress, remotePort)}->${endpoint(localAddress, localPort)}`
  const pids = new Set<number>()
  let pid: number | undefined
  for (const field of stdout.trim().split('\n')) {
    if (field.startsWith('p')) pid = Number(field.slice(1))
    if (field === `n${connection}` && pid !== undefined) pids.add(pid)
  }
  if (!pids.size) throw new LocalClientUnavailableError()
  return !(await Promise.all([...pids].map(pid => agentAncestor(pid, parents)))).some(Boolean)
}

type ClientSocket = Pick<Socket, 'remoteAddress' | 'remotePort' | 'localAddress' | 'localPort'>
// A connected socket keeps its endpoints and owning process boundary, so keep-alive
// requests reuse its attribution instead of re-running `ss` and /proc walks.
const attributedSockets = new WeakMap<ClientSocket, { endpoints: string; human: Promise<boolean> }>()

/** Attribute the socket and its process ancestry through the OS, never client headers. */
export function localHumanClient(socket: ClientSocket): Promise<boolean> {
  const endpoints = `${socket.remoteAddress} ${socket.remotePort} ${socket.localAddress} ${socket.localPort}`
  const known = attributedSockets.get(socket)
  if (known?.endpoints === endpoints) return known.human
  const human = attributeClient(socket)
  attributedSockets.set(socket, { endpoints, human })
  // Failed attribution is not a decision; the next request inspects again.
  human.catch(() => { if (attributedSockets.get(socket)?.human === human) attributedSockets.delete(socket) })
  return human
}

async function attributeClient(socket: ClientSocket): Promise<boolean> {
  const { remoteAddress, remotePort, localAddress, localPort } = socket
  if (!remoteAddress || !localAddress
    || !loopbackAddresses.has(remoteAddress) || !loopbackAddresses.has(localAddress)
    || !Number.isInteger(remotePort) || !Number.isInteger(localPort)) return false
  try {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return false
    const parents = await runtimeParents()
    if (process.platform === 'linux') return await linuxClient(remoteAddress, remotePort!, localAddress, localPort!, parents)
    return await macClient(remoteAddress, remotePort!, localAddress, localPort!, parents)
  } catch (error) {
    if (error instanceof LocalClientUnavailableError) throw error
    // OS lookups can time out or race a closing socket/process. They do not
    // establish either human access or an agent denial.
    if (error instanceof Error && ('code' in error || 'killed' in error || 'signal' in error)) {
      throw new LocalClientUnavailableError({ cause: error })
    }
    throw error
  }
}

/** Preserve the client's process boundary before a browser development proxy forwards it. */
export async function localHumanProxyRequest(request: IncomingMessage, response: ServerResponse,
  next: (error?: Error) => void): Promise<void> {
  if (!request.url?.startsWith('/api/') || request.headers.authorization !== undefined) {
    next()
    return
  }
  try {
    if (await localHumanClient(request.socket)) {
      next()
      return
    }
    response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    const error: ApiErrorResponse = { error: { code: 'LOCAL_HUMAN_REQUIRED',
      message: 'Agent processes require an application credential.' } }
    response.end(JSON.stringify(error))
  } catch (error) {
    if (!(error instanceof LocalClientUnavailableError)) {
      next(error as Error)
      return
    }
    response.writeHead(503, {
      'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1',
    })
    const body: ApiErrorResponse = { error: {
      code: error.code, message: error.message, details: { retryable: true },
    } }
    response.end(JSON.stringify(body))
  }
}
