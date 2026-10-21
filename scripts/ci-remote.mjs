// Runs a test command through Main's CI instead of on this computer:
//   node scripts/ci-remote.mjs <suite> -- <local command...>
// On a CI machine (CI=true: cloud runners and build computers) or with FOREMAN_CODE_CI_LOCAL=1 it runs the local
// command. Anywhere else it snapshots the working tree (uncommitted changes included) as a commit, pushes it to
// GitHub, starts Main's ci_run for it, streams progress and failures, and exits with the run's result.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as wait } from 'node:timers/promises'
import { affectedSnapshot } from './ci-affected.mjs'
import { appMcpDirectory } from '../packages/contracts/src/productEnvironmentNode.mjs'

const environment = process.env

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

/** The working tree as a commit on HEAD, without touching the index, branch or files. */
export function snapshot(cwd = process.cwd()) {
  const directory = mkdtempSync(join(environment.TMPDIR ?? tmpdir(), 'ci-index-'))
  try {
    const env = { ...environment, GIT_INDEX_FILE: join(directory, 'index') }
    git(['read-tree', 'HEAD'], { env, cwd })
    git(['add', '-A'], { env, cwd })
    const tree = git(['write-tree'], { env, cwd })
    if (tree === git(['rev-parse', 'HEAD^{tree}'], { cwd })) return git(['rev-parse', 'HEAD'], { cwd })
    // A throwaway commit only CI reads, so it needs no personal identity.
    const identity = { GIT_AUTHOR_NAME: 'Foreman Code CI', GIT_AUTHOR_EMAIL: 'ci@foreman-code.invalid',
      GIT_COMMITTER_NAME: 'Foreman Code CI', GIT_COMMITTER_EMAIL: 'ci@foreman-code.invalid' }
    return git(['commit-tree', tree, '-p', 'HEAD', '-m', 'CI snapshot of uncommitted changes'], { cwd, env: { ...environment, ...identity } })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

/** Use the installed bridge so credential routes and Worker relay renewal stay owned by the app. */
async function scopedRequest(message) {
  const directory = appMcpDirectory(environment)
  const child = spawn(process.execPath, [join(directory, 'launcher.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Object.assign(new Error('The scoped MCP bridge timed out.'), { retryable: true }))
      }, 300_000)
      child.once('error', reject)
      child.stdin.once('error', reject)
      child.once('close', () => {
        clearTimeout(timeout)
        reject(new Error('The scoped MCP bridge closed without a response.'))
      })
      lines.on('line', line => {
        try {
          const reply = JSON.parse(line)
          if (reply.id !== message.id) return
          clearTimeout(timeout)
          resolve(reply)
        } catch (error) {
          clearTimeout(timeout)
          reject(error)
        }
      })
      child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  } finally {
    lines.close()
    child.stdin.end()
    child.kill()
  }
}

function hasScopedCredential() {
  return environment.FOREMAN_CODE_MCP_TOKEN !== undefined || environment.GRAPHQL_MCP_TOKEN !== undefined
}

function toolValue(name, result) {
  const text = result.content?.[0]?.text ?? ''
  let value
  try {
    value = text ? JSON.parse(text) : result.structuredContent
  } catch (error) {
    throw new Error(`${name}: ${text.slice(0, 400)}`, { cause: error })
  }
  if (result.isError) {
    const code = value?.error?.code
    const denied = code === 'ACCESS_DENIED' || typeof code === 'string' && code.startsWith('AUTH_')
    throw Object.assign(new Error(`${name}: ${JSON.stringify(value).slice(0, 600)}`),
      { retryable: !denied && value?.error?.details?.retryable === true })
  }
  return value?.value ?? value
}

export async function mcpClient(clientName = 'ci-remote') {
  const scoped = hasScopedCredential()
  const base = environment.FOREMAN_CODE_MAIN_URL ?? 'http://127.0.0.1:3041'
  const tokenFile = environment.FOREMAN_CODE_OPERATOR_TOKEN_FILE
    ?? join(homedir(), '.local/share/foreman-code/production-operator.private.json')
  const token = scoped ? undefined
    : environment.FOREMAN_CODE_OPERATOR_TOKEN ?? JSON.parse(readFileSync(tokenFile, 'utf8')).token
  let session, version
  const send = async message => {
    if (scoped) return scopedRequest(message)
    let response
    let body
    try {
      response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(300_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}), ...(version ? { 'Mcp-Protocol-Version': version } : {}) },
        body: JSON.stringify(message) })
      body = await response.text()
    } catch (error) {
      error.retryable = true
      throw error
    }
    if (!response.ok) throw Object.assign(new Error(`Main refused MCP: HTTP ${response.status}`),
      { retryable: response.status === 429 || response.status >= 500 })
    session = response.headers.get('mcp-session-id') ?? session
    try {
      return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body)
        : body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
          .find(value => value.id === message.id)
    } catch (error) {
      error.retryable = true
      throw error
    }
  }
  const request = async (method, params) => {
    const message = { jsonrpc: '2.0', id: randomUUID(), method, params }
    const retryableCall = method === 'initialize' || method === 'tools/call'
      && (params.name === 'ci_get' || params.name === 'ci_run' && params.arguments.commandId)
    for (let attempt = 0; ; attempt++) {
      try {
        const envelope = await send(message)
        if (!envelope) throw Object.assign(new Error(`Main returned no response for ${method}.`), { retryable: true })
        if (envelope.error) {
          const kind = envelope.error.data?.kind
          const retryable = envelope.error.data?.retryable ?? ['service_unavailable', 'transport',
            'route_unavailable', 'timeout', 'indeterminate_delivery', 'invalid_response', 'relay_unavailable'].includes(kind)
          throw Object.assign(new Error(`Main refused ${method}: ${JSON.stringify(envelope.error).slice(0, 400)}`),
            { retryable })
        }
        return method === 'tools/call' ? toolValue(params.name, envelope.result) : envelope.result
      } catch (error) {
        if (!retryableCall || !error.retryable || attempt === 3) {
          if (params?.name === 'ci_run' && error.retryable) {
            error.message += `; retry ci_run with the same arguments: ${JSON.stringify(params.arguments)}`
          }
          throw error
        }
        console.error(`[ci] MCP connection interrupted; retrying ${params?.name ?? method} with unchanged input.`)
        await wait(1000 * 2 ** attempt)
      }
    }
  }
  version = (await request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: clientName, version: '1' } })).protocolVersion
  return Object.assign((name, args) => request('tools/call', { name, arguments: args }), {
    listTools: args => request('tools/list', args),
  })
}

/** A suite part by its name (typecheck-api), an integration partition by its number. */
const partName = run => run.part ?? (run.partition ? `part ${run.partition.index + 1} of ${run.partition.count}` : run.suite)

/** Pushes the snapshot for Main's CI. Several commands often push the same commit at once (an agent running test
 * and lint together); GitHub refuses all but one ref update, and the branch then already holds the commit. */
async function publish(commit) {
  const ref = `refs/heads/foreman/ci/${commit}`
  for (let attempt = 1; ; attempt++) {
    try { git(['push', '--quiet', 'origin', `${commit}:${ref}`]); return } catch (error) {
      const published = (() => { try { return git(['ls-remote', 'origin', ref]).split(/\s/)[0] } catch { return '' } })()
      if (published === commit) return
      if (attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
    }
  }
}

/** FOREMAN_CODE_WORKSPACE_ID, else the workspace whose repository is this checkout's GitHub origin. */
export async function workspaceFor(call) {
  if (environment.FOREMAN_CODE_WORKSPACE_ID) return environment.FOREMAN_CODE_WORKSPACE_ID
  const origin = git(['remote', 'get-url', 'origin']).replace(/\.git$/, '')
  const repository = /github\.com[:/]([^/]+\/[^/]+)$/.exec(origin)?.[1]
  if (!repository) throw new Error(`The origin remote is not a GitHub repository: ${origin}`)
  // The list omits repository details; read each workspace until one uses this repository.
  let cursor
  do {
    const page = await call('workspace_list', cursor ? { cursor } : {})
    for (const item of page.items ?? []) {
      const value = (await call('workspace_get', { workspaceId: item.workspace.id })).workspace?.repository
      if (value && `${value.owner}/${value.name}`.toLowerCase() === repository.toLowerCase()) return item.workspace.id
    }
    cursor = page.pageInfo?.nextCursor
  } while (cursor)
  throw new Error(`No Foreman Code workspace uses ${repository}.`)
}

/** Token presence selects transport; the authenticated tool schema selects workspace arguments. */
async function ciWorkspaceFor(call) {
  let cursor
  do {
    const page = await call.listTools(cursor ? { cursor } : {})
    const tool = page.tools.find(tool => tool.name === 'ci_run')
    if (tool) {
      return tool.inputSchema.required?.includes('workspaceId') ? workspaceFor(call) : undefined
    }
    cursor = page.nextCursor
  } while (cursor)
  throw new Error('The authenticated MCP connection does not advertise ci_run.')
}

/** Test files named on the command line (`pnpm test -- some.test.ts`), relative to the repository root. */
export function requestedTestFiles(args, cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], { cwd })
  return [...new Set(args.filter(arg => /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg) && !arg.includes('*'))
    .map(arg => relative(root, resolve(cwd, arg))).filter(file => existsSync(join(root, file))))]
}

/** Waits for the tickets' group with one log-free read, prints each failed part with its ticket, failed tests and log
 * lines once the group's results are collected, and returns the finished runs. A ticket superseded by a newer commit is
 * replaced by its replacement's tickets. Group reads include siblings added during fallback. After waitMs it stops
 * waiting and returns the runs as they are; open tickets
 * keep running on CI. */
export async function awaitTickets(call, workspaceId, tickets,
  { waitMs = Number(environment.FOREMAN_CODE_CI_WAIT_MS || 2 * 3_600_000) } = {}) {
  const workspace = workspaceId === undefined ? {} : { workspaceId }
  const startedAt = Date.now(), states = new Map(), followed = new Set()
  for (;;) {
    // Main holds each read until every ticket of that group is terminal with its results collected, or for about a
    // minute. A superseded group's replacement is another group, so every group the tickets belong to is read.
    const runs = [], covered = new Set()
    let groupsSettled = true
    for (const ticketId of tickets) {
      if (covered.has(ticketId)) continue
      const remainingSeconds = Math.ceil((waitMs - (Date.now() - startedAt)) / 1000)
      const read = await call('ci_get', { ...workspace, ticketId, waitUntil: 'group-terminal',
        waitSeconds: Math.min(1800, Math.max(1, remainingSeconds)), logTail: false })
      if (!read.wait) throw new Error('Main answered ci_get without the requested group wait.')
      const group = read.partitions ?? [read.run]
      for (const run of group) covered.add(run.id)
      runs.push(...group.filter(run => !followed.has(run.id)))
      if (read.wait.status !== 'settled') groupsSettled = false
    }
    tickets = runs.map(run => run.id)
    for (const run of runs) {
      const line = `${run.state}${run.computer ? ` on ${run.computer.label}` : ''}`
      if (states.get(run.id) !== line) { states.set(run.id, line); console.error(`[ci] ${Math.round((Date.now() - startedAt) / 1000)}s ${partName(run)}: ${line}`) }
    }
    const superseded = runs.filter(run => run.state === 'canceled' && run.supersededBy)
    if (superseded.length) {
      for (const run of superseded) followed.add(run.id)
      const replacements = new Set()
      for (const replacement of new Set(superseded.map(run => run.supersededBy))) {
        const next = await call('ci_get', { ...workspace, ticketId: replacement, logTail: false })
        for (const value of next.partitions ?? [next.run]) replacements.add(value.id)
        console.error(`[ci] superseded by a newer commit's ticket ${replacement}; following it`)
      }
      tickets = [...new Set([...tickets.filter(id => !superseded.some(run => run.id === id)), ...replacements])]
      continue
    }
    const open = runs.filter(run => ['queued', 'starting', 'running'].includes(run.state))
    const settled = groupsSettled && !open.length
    if (!settled && Date.now() - startedAt < waitMs) continue
    if (open.length) {
      console.log(`\n[ci] Stopped waiting after ${Math.round(waitMs / 60_000)} min (FOREMAN_CODE_CI_WAIT_MS); still open, `
        + `and still running on CI: ${open.map(run => `${partName(run)} ${run.state} (ticket ${run.id})`).join(', ')}`)
      return runs
    }
    for (const run of runs.filter(value => value.state !== 'passed')) {
      const log = await call('ci_logs_read', { ...workspace, ticketId: run.id, maxBytes: 65_536 }).catch(() => {
        console.error(`[ci] ci_logs_read for ticket ${run.id} unavailable; diagnostic retrieval failed.`)
        return { text: '' }
      })
      const read = await call('ci_get', { ...workspace, ticketId: run.id, testStatus: ['failed'], logTail: false }).catch(() => {
        console.error(`[ci] test results for ticket ${run.id} unavailable; diagnostic retrieval failed.`)
        return {}
      })
      const tests = read.tests?.files ?? []
      const history = new Map((read.failureHistory ?? []).map(entry => [`${entry.file}\0${entry.test}`, entry]))
      const flaky = (file, test) => {
        const entry = history.get(`${file}\0${test}`)
        return entry?.runs ? ` (failed ${entry.failedRuns} of the last ${entry.runs} gate runs)` : ''
      }
      const lines = log.text.split('\n').filter(line => /FAIL|failed files|hung files|error TS| {2}error {2}|Error:|×|AssertionError/.test(line))
      console.log(`\n[ci] ${run.suite} ${partName(run)} ${run.state} (ticket ${run.id})${run.message ? `: ${run.message}` : ''}`)
      for (const file of tests) for (const test of file.tests) console.log(`[ci] failed test ${file.file} > ${test.name}${flaky(file.file, test.name)}`)
      console.log(lines.slice(-60).join('\n') || log.text.slice(-4000))
    }
    return runs
  }
}

async function remote(suite, args) {
  const requested = requestedTestFiles(args)
  const call = await mcpClient()
  const workspaceId = await ciWorkspaceFor(call)
  const commit = snapshot()
  const selection = requested.length ? { scope: 'affected', files: requested, reason: 'Test files named on the command line.' }
    : environment.FOREMAN_CODE_CI_SCOPE === 'full' || git(['branch', '--show-current']) === 'main'
      ? { scope: 'full', files: [], reason: 'Full scope requested.' } : affectedSnapshot(commit, suite)
  if (selection.files.length > 2000) {
    selection.scope = 'full'
    selection.files = []
    selection.reason = 'Selection exceeds the CI request limit.'
  }
  console.error(`[ci] ${selection.scope}: ${selection.reason} ${selection.files.length} selected files.`)
  await publish(commit)
  const partitions = suite === 'integration' && environment.FOREMAN_CODE_CI_PARTITIONS
    ? Number(environment.FOREMAN_CODE_CI_PARTITIONS) : undefined
  const started = await call('ci_run', { ...(workspaceId === undefined ? {} : { workspaceId }),
    suite, commit, scope: selection.scope,
    ...(selection.scope === 'affected' ? { files: selection.files } : {}),
    commandId: randomUUID(), ...(partitions ? { partitions } : {}) })
  const tickets = (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId)
  console.error(`[ci] ${suite} of ${commit.slice(0, 12)} on ${tickets.length} CI ${tickets.length === 1 ? 'machine' : 'machines'}`)
  const startedAt = Date.now()
  const failed = (await awaitTickets(call, workspaceId, tickets)).filter(run => run.state !== 'passed')
  console.error(`[ci] ${suite} ${failed.length ? 'FAILED' : 'passed'} in ${Math.round((Date.now() - startedAt) / 1000)}s`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [suite, separator, ...command] = process.argv.slice(2)
  if (!suite || separator !== '--' || !command.length) {
    console.error('usage: node scripts/ci-remote.mjs <suite> -- <local command...>')
    process.exit(2)
  }
  if (environment.CI === 'true' || environment.FOREMAN_CODE_CI_LOCAL === '1') {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
  } else {
    process.exitCode = await remote(suite, command.slice(1)).catch(error => {
      console.error(`[ci] ${error.message}`)
      console.error('[ci] Tests run on the CI computers through Main. Check that Main is running and reachable '
        + '(FOREMAN_CODE_MAIN_URL) with an Operator credential (FOREMAN_CODE_OPERATOR_TOKEN_FILE), '
        + 'or run on this computer on purpose with FOREMAN_CODE_CI_LOCAL=1.')
      return 1
    })
  }
}
