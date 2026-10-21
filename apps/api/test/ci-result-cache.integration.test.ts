import { createHash, randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunOutputSchema, type CiHostRequest, type CiHostRun, type CiTestResults } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

const LABEL = 'apps/api/test/label.integration.test.ts'
const PLAIN = 'apps/api/test/plain.integration.test.ts'
const DYNAMIC = 'apps/api/test/dynamic.integration.test.ts'

/** The repository at the first commit: LABEL imports label.ts, which imports format.ts. */
const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'site', private: true, devDependencies: { vitest: '4.0.0' } }),
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'scripts/ci-suite.sh': '#!/bin/bash\nexec node scripts/ci-files.mjs\n',
  'scripts/ci-files.mjs': 'export const files = []\n',
  'apps/api/package.json': JSON.stringify({ name: 'api', devDependencies: { vitest: '4.0.0' } }),
  'apps/api/src/lib/format.ts': 'export const format = (value: string) => value.trim()\n',
  'apps/api/src/lib/label.ts': "import { format } from './format.js'\nexport const label = (value: string) => `[${format(value)}]`\n",
  'apps/api/src/unrelated.ts': 'export const unrelated = 1\n',
  [LABEL]: "import { expect, it } from 'vitest'\nimport { label } from '../src/lib/label.js'\n"
    + "it('labels', () => { expect(label(' a ')).toBe('[a]') })\n",
  [PLAIN]: "import { expect, it } from 'vitest'\nit('adds', () => { expect(1 + 1).toBe(2) })\n",
  [DYNAMIC]: "import { expect, it } from 'vitest'\nconst name = '../src/lib/format.js'\n"
    + "it('loads', async () => { expect(await import(name)).toBeTruthy() })\n",
}
const commit = (digit: string) => digit.repeat(40)
/** Every later commit changes one input of the first. */
const TREES: Record<string, Record<string, string>> = {
  [commit('1')]: BASE,
  [commit('2')]: { ...BASE, 'apps/api/src/unrelated.ts': 'export const unrelated = 2\n' },
  [commit('3')]: { ...BASE, 'apps/api/src/lib/format.ts': 'export const format = (value: string) => value.trim() || "-"\n' },
  [commit('4')]: { ...BASE, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# upgraded\n' },
  [commit('5')]: { ...BASE, 'scripts/ci-suite.sh': '#!/bin/bash\nexec node scripts/ci-files.mjs --changed\n' },
}

type Outcome = 'passed' | 'failed' | 'skipped' | 'missing'

async function fixture() {
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI result cache', repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
  })])
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const computers: HostCiComputer[] = [
    { key: 'cache-builder', hostRef: { kind: 'main', mainId: 'cache-main' }, label: 'Builder', priority: 60 },
    ...[0, 1].map(slot => ({ key: `cache-cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'cache-main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  const remote = new Map<string, CiHostRun>()
  const starts: Extract<CiHostRequest, { operation: 'start' }>[] = []
  /** Per-file outcomes the build computer reports for the next finished runs. */
  const outcomes = new Map<string, Outcome>()
  const results = (files: string[]): CiTestResults => {
    const reported = files.filter(file => outcomes.get(file) !== 'missing')
    const status = (file: string) => (outcomes.get(file) ?? 'passed') as 'passed' | 'failed' | 'skipped'
    return { truncated: false, summary: {
      passed: reported.filter(file => status(file) === 'passed').length,
      failed: reported.filter(file => status(file) === 'failed').length,
      skipped: reported.filter(file => status(file) === 'skipped').length },
    files: reported.map(file => ({ file, status: status(file) === 'skipped' ? 'passed' : status(file), durationMs: 10,
      tests: [{ name: `${file} works`, status: status(file), durationMs: 10 }] })) }
  }
  const tree = (sha: string) => {
    const files = TREES[sha]
    if (!files) throw new Error(`Unknown commit ${sha}`)
    return { blobs: new Map(Object.entries(files).map(([path, text]) =>
      [path, `100644:${createHash('sha1').update(text).digest('hex')}`])),
    read: async (path: string) => files[path]! }
  }
  const integrationFiles = [DYNAMIC, LABEL, PLAIN]
  const commits: CiCommits & { testTree: (repository: string, sha: string) => Promise<ReturnType<typeof tree>> } = {
    resolve: async (_repository, _branch, sha) => sha!,
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files: integrationFiles,
      durations: Object.fromEntries(integrationFiles.map(file => [file, 1000])) }),
    unitInventory: async () => ({ files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }),
    testTree: async (_repository, sha) => tree(sha),
  }
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), commits, {
    computers: async () => computers,
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 16, memoryBytes: 32 * 2 ** 30, slotsTotal: 8, slotsUsed: 0, runs: [] }
      if (request.operation === 'start') {
        starts.push(request)
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, logBytes: 0, message: null }
        remote.set(request.runId, run)
        return { operation: 'start', run }
      }
      const run = remote.get(request.runId)
      if (!run) throw new Error('Unexpected CI request')
      if (request.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
      const started = starts.find(start => start.runId === request.runId)!
      const finished = !['starting', 'running'].includes(run.state)
      return { operation: 'read', run, text: '', nextOffset: 0,
        ...(request.testResults && finished ? { testResults: results(started.files ?? []) } : {}) }
    },
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: typeof CI_GET_ACTIONS) => {
    const issued = await access.issue({ name: 'CI cache caller', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
    const client = new Client({ name: 'ci-result-cache-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await operator.callTool({ name, arguments: { workspaceId, ...input } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const request = async (sha: string, files: string[]) => CiRunOutputSchema.parse(await call('ci_run', {
    suite: 'integration', commit: commit(sha), scope: 'affected', files, commandId: randomUUID() }))
  const read = async (ticketId: string) => CiGetOutputSchema.parse(await call('ci_get', { ticketId }))
  /** Starts the request on the builder, finishes it and collects its results. */
  // ci_run also starts a background dispatch; observations run in the background, so wait for them to finish.
  const settle = async () => { await ci.dispatch(); await ci.drain() }
  const complete = async (ticketId: string, state: 'passed' | 'failed' = 'passed') => {
    await settle()
    const run = remote.get(ticketId)
    if (!run) throw new Error('The CI ticket did not start')
    remote.set(ticketId, { ...run, state, exitCode: state === 'passed' ? 0 : 1, finishedAt: new Date().toISOString() })
    await settle()
    const completed = CiGetOutputSchema.parse(await call('ci_get', {
      ticketId, waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(completed.wait?.status).toBe('settled')
    expect(completed.run).toMatchObject({ state, collection: 'complete' })
  }
  /** The files a request actually sent to a build computer. */
  const sent = async (ticketId: string) => {
    await settle()
    return starts.find(start => start.runId === ticketId)?.files ?? null
  }
  const cachedRows = async () => (await pool.query<{ file: string; ticket_id: string }>(
    'select file,ticket_id from ci_test_result_cache where workspace_id=$1 order by file', [workspaceId])).rows
  return { workspaceId, connect, call, request, read, complete, sent, starts, outcomes, cachedRows, close: async () => {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
  } }
}

it('skips unchanged passed files in a later affected run and reports the run that proved them', async () => {
  const f = await fixture()
  try {
    const first = await f.request('1', [LABEL, PLAIN])
    expect(await f.sent(first.ticketId)).toEqual([LABEL, PLAIN])
    await f.complete(first.ticketId)
    expect(await f.cachedRows()).toEqual([
      { file: LABEL, ticket_id: first.ticketId }, { file: PLAIN, ticket_id: first.ticketId }])

    const startsBefore = f.starts.length
    const second = await f.request('2', [LABEL, PLAIN])
    const proof = [{ file: LABEL, ticketId: first.ticketId, commit: commit('1') },
      { file: PLAIN, ticketId: first.ticketId, commit: commit('1') }]
    expect(second.cachedFiles).toEqual(proof)
    expect(await f.sent(second.ticketId)).toBeNull()
    expect(f.starts).toHaveLength(startsBefore)
    const readback = await f.read(second.ticketId)
    expect(readback.run).toMatchObject({ state: 'passed', cachedFiles: proof })
    expect(readback.logTail).toContain(LABEL)
    expect(readback.logTail).toContain(PLAIN)
    expect(readback.logTail).toContain(first.ticketId)

    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await reader.callTool({ name: 'ci_run', arguments: { workspaceId: f.workspaceId,
      suite: 'integration', commit: commit('2'), scope: 'affected', files: [LABEL], commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(await f.cachedRows()).toHaveLength(2)
  } finally { await f.close() }
})

it('runs a file again when a transitive import, the lockfile or the runner scripts change', async () => {
  const f = await fixture()
  try {
    const first = await f.request('1', [LABEL, PLAIN])
    await f.complete(first.ticketId)

    const imported = await f.request('3', [LABEL, PLAIN])
    expect(imported.cachedFiles).toEqual([{ file: PLAIN, ticketId: first.ticketId, commit: commit('1') }])
    expect(await f.sent(imported.ticketId)).toEqual([LABEL])
    const notice = f.starts.find(start => start.runId === imported.ticketId)!.notice
    expect(notice).toContain(PLAIN)
    expect(notice).toContain(first.ticketId)

    for (const changed of ['4', '5']) {
      const run = await f.request(changed, [LABEL, PLAIN])
      expect(run.cachedFiles, `commit ${changed}`).toBeUndefined()
      expect(await f.sent(run.ticketId), `commit ${changed}`).toEqual([LABEL, PLAIN])
    }
  } finally { await f.close() }
})

it('never caches failed, skipped, unreported or uncertain results', async () => {
  const f = await fixture()
  try {
    f.outcomes.set(PLAIN, 'failed')
    const failed = await f.request('1', [LABEL, PLAIN])
    await f.complete(failed.ticketId, 'failed')
    expect(await f.cachedRows()).toEqual([])

    f.outcomes.set(PLAIN, 'skipped')
    f.outcomes.set(LABEL, 'missing')
    const partial = await f.request('1', [LABEL, PLAIN, DYNAMIC])
    expect(partial.cachedFiles).toBeUndefined()
    await f.complete(partial.ticketId)
    // Only the dynamic file passed, and its import cannot be resolved statically, so it has no usable key.
    expect(await f.cachedRows()).toEqual([])

    const again = await f.request('2', [LABEL, PLAIN, DYNAMIC])
    expect(again.cachedFiles).toBeUndefined()
    expect(await f.sent(again.ticketId)).toEqual([DYNAMIC, LABEL, PLAIN])
  } finally { await f.close() }
})

it('never skips cached files in full-scope runs or gates', async () => {
  const f = await fixture()
  try {
    const first = await f.request('1', [LABEL, PLAIN])
    await f.complete(first.ticketId)

    const full = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'integration', commit: commit('1'),
      scope: 'full', commandId: randomUUID() }))
    expect(full.cachedFiles).toBeUndefined()
    // A full-scope start sends no file list, so the builder runs every file.
    await f.sent(full.ticketId)
    const start = f.starts.find(sent => sent.runId === full.ticketId)
    expect(start).toMatchObject({ scope: 'full' })
    expect(start?.files).toBeUndefined()
    expect((await f.read(full.ticketId)).run).toMatchObject({ scope: 'full', files: [], state: 'running',
      computer: { hostRef: { kind: 'main', mainId: 'cache-main' } } })

    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await reader.callTool({ name: 'ci_run', arguments: { workspaceId: f.workspaceId,
      suite: 'integration', commit: commit('1'), scope: 'full', gate: true } })
    expect(denied.isError).toBe(true)

    const gate = CiRunOutputSchema.parse(await f.call('ci_run', { suite: 'integration', commit: commit('1'),
      scope: 'full', gate: true, commandId: randomUUID() }))
    expect(gate.cachedFiles).toBeUndefined()
    const parts = (await f.read(gate.ticketId)).partitions ?? []
    expect(parts.every(part => part.cachedFiles === undefined)).toBe(true)
    expect(parts.filter(part => part.suite === 'integration').every(part => part.plannedHostKey === 'cache-builder'))
      .toBe(true)
    expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
      .toEqual([DYNAMIC, LABEL, PLAIN])
  } finally { await f.close() }
})
