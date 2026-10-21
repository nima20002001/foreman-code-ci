import type { ManagementAction } from '@foreman-code/contracts/management'
import { z } from 'zod'
import { CiGetOutputSchema, CiRunOutputSchema, integrationPartition } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it('reports the explicit selection reason through authenticated MCP and persisted readback', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope: 'affected', files: [],
      commit: 'a'.repeat(40), commandId: 'selection-reason' }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toHaveProperty('selection', { scope: 'affected', files: [], reason: 'Caller supplied the affected files.' })
    const persisted = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(persisted).toEqual(read.run)
  } finally { await f.close() }
})

it('splits affected unit files without sending an empty part to a computer', async () => {
  const f = await fixture({ cloud: { github: 3, circleci: 0 } })
  try {
    const files = ['apps/api/test/a.test.ts', 'apps/api/test/b.test.ts', 'apps/api/test/c.test.ts']
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'unit', commandId: 'selected-parts', scope: 'affected', files, commit: 'a'.repeat(40),
    }))
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(3)
    expect(read.partitions!.every(run => run.part === 'unit-api' && run.files.length === 1)).toBe(true)
    expect(read.partitions!.flatMap(run => run.files).sort()).toEqual(files)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(3)
    for (const item of f.started) expect(item.request).toMatchObject({ part: 'unit-api', scope: 'affected',
      files: expect.any(Array), partition: { count: 3 } })
  } finally { await f.close() }
})

it('persists completed unit result reports for read-only MCP callers', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await f.call(reader, 'ci_run', {
      suite: 'unit', scope: 'affected', files: ['apps/api/test/example.test.ts'],
      commit: 'a'.repeat(40), commandId: 'reader-unit-report',
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'unit', scope: 'affected', files: ['apps/api/test/example.test.ts'], commandId: 'unit-report',
      commit: 'a'.repeat(40),
    }))
    await f.ci.dispatch()
    f.finish(started.ticketId, 0, 'passed\n', { 'apps/api/test/example.test.ts': 60_000 })
    await f.waitFor(reader, started.ticketId, output => output.run.collection === 'complete')
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
      ticketId: started.ticketId, testStatus: ['passed'],
    }))
    expect(read.tests).toEqual({ summary: { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false })
    expect(read.run).toMatchObject({ state: 'passed', collection: 'complete', commit: 'a'.repeat(40),
      scope: 'affected', files: ['apps/api/test/example.test.ts'] })
    const persisted = CiGetOutputSchema.parse(decodeMcpToolResult(await reader.callTool({
      name: 'ci_get', arguments: { workspaceId: f.workspaceId, ticketId: started.ticketId, testStatus: ['passed'] },
    })))
    expect(persisted.tests).toEqual(read.tests)
    expect(persisted.run).toEqual(read.run)
  } finally { await f.close() }
})

it('sizes persisted unit parts from committed timings and then from learned unit timings', async () => {
  const files = Array.from({ length: 6 }, (_, index) => `apps/api/test/unit-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 150_000]))
  const f = await fixture({ unitInventory: { files, durations, heavy: [] }, cloud: { github: 6, circleci: 0 } })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'unit', scope: 'full', commandId: 'timed-parts' }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    let read = await f.waitFor(reader, first.ticketId, output =>
      output.partitions!.every(run => run.state === 'running' || run.state === 'queued')
        && output.partitions!.some(run => run.state === 'running'))
    expect(read.partitions!.filter(run => run.part === 'unit-api')).toHaveLength(6)
    const measured: string[] = []
    for (let pass = 0; pass < first.partitions!.length && read.group!.state !== 'passed'; pass++) {
      const active = read.partitions!.filter(run => run.state === 'running')
      expect(active.length).toBeGreaterThan(0)
      for (const run of active) {
        const slice = run.part === 'unit-api' ? integrationPartition(files, durations, run.partition!) : []
        measured.push(...slice)
        f.finish(run.id, 0, 'passed\n', Object.fromEntries(slice.map(file => [file, 60_000])))
      }
      read = await f.waitFor(reader, first.ticketId, output =>
        active.every(previous => output.partitions!.find(run => run.id === previous.id)?.collection === 'complete')
          && (output.partitions!.every(run => run.state === 'passed')
            || output.partitions!.some(run => run.state === 'running')))
    }
    expect(read.group!.state).toBe('passed')
    expect(read.partitions!.every(run => run.collection === 'complete')).toBe(true)
    expect(measured.sort()).toEqual(files)
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'unit', scope: 'full', commandId: 'learned-parts',
    }))
    const learned = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: next.ticketId }))
    expect(learned.partitions!.filter(run => run.part === 'unit-api')).toHaveLength(3)
    expect((await f.pool.query('select count(*)::int as count from ci_file_durations')).rows[0].count).toBe(6)
  } finally { await f.close() }
})

it('persists affected files through authenticated MCP, bounds partition count and rejects a denied caller', async () => {
  const f = await fixture()
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/c.integration.test.ts']
  const input = { suite: 'integration', scope: 'affected', files, commit: 'a'.repeat(40), commandId: 'affected', partitions: 32 }
  try {
    const listed = await f.operator.listTools()
    const tool = listed.tools.find(value => value.name === 'ci_run')!
    expect(tool.inputSchema.properties).toHaveProperty('scope')
    expect(tool.inputSchema.properties).toHaveProperty('files')
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(2)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(2)
    for (const item of f.started) expect(item.request).toMatchObject({ scope: 'affected', files, partition: { count: 2 } })
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ scope: 'affected', files })
    const stored = await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [started.ticketId])
    expect(stored.rows[0]!.record).toMatchObject({ scope: 'affected', files })
  } finally { await f.close() }
})

it('shares affected CI validation, grants and persisted readback between HTTP and MCP', async () => {
  const f = await fixture()
  try {
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const input = { suite: 'unit', scope: 'affected', files: ['apps/api/src/feature.test.ts'],
      commit: 'a'.repeat(40), commandId: 'http-affected' }
    const reader = await f.credential(CI_GET_ACTIONS)
    const denied = await f.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${reader.token}` }, payload: input })
    expect(denied.statusCode).toBe(403)
    const response = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    const replay = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(replay.json()).toEqual(started)
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    expect(read.statusCode).toBe(200)
    expect(CiGetOutputSchema.parse(read.json()).run).toMatchObject({ scope: 'affected', files: input.files })
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId })).run)
      .toMatchObject({ scope: 'affected', files: input.files })
    const audit = await f.pool.query<{ source: string; outcome: string }>(
      'select source,outcome from management_audit where action=$1', ['ci.run'])
    expect(audit.rows).toEqual(expect.arrayContaining([
      { source: 'http', outcome: 'denied' }, { source: 'http', outcome: 'succeeded' },
    ]))
    for (const invalid of [{ ...input, files: ['../escape.test.ts'] }, { ...input, scope: 'full' },
      { ...input, suite: 'integration' }]) {
      const rejected = await f.app.inject({ method: 'POST', url, headers, payload: invalid })
      expect(rejected.statusCode).toBe(400)
    }
  } finally { await f.close() }
})

it('records an empty affected selection as passed and preserves explicit full scope', async () => {
  const f = await fixture()
  try {
    const empty = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', scope: 'affected',
      files: [], commit: 'a'.repeat(40), commandId: 'empty', partitions: 32 }))
    expect(empty.partitions).toBeUndefined()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: empty.ticketId }))
    expect(read.run).toMatchObject({ state: 'passed', exitCode: 0, scope: 'affected', files: [], computer: null })
    expect(f.started).toHaveLength(0)
    const full = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'unit', scope: 'full', commandId: 'explicit-full' }))
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: full.ticketId })).run)
      .toMatchObject({ scope: 'full', files: [] })
  } finally { await f.close() }
})

it('persists an explicit base through authenticated Operator MCP, enforces grants and dispatches it to the runner', async () => {
  const f = await fixture()
  try {
    const baseCommit = 'b'.repeat(40)
    const input = { suite: 'integration', scope: 'affected', baseCommit, commandId: 'release-changes' }
    const tool = (await f.operator.listTools()).tools.find(item => item.name === 'ci_run')!
    expect(tool.inputSchema.properties).toHaveProperty('baseCommit')
    const reader = await f.connect(CI_GET_ACTIONS)
    const foreign = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['workspace-other'] })
    for (const caller of [reader, foreign]) {
      const denied = await f.call(caller, 'ci_run', input)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    }
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    expect((await f.call(f.operator, 'ci_run', { ...input, baseCommit: 'c'.repeat(40) })).isError).toBe(true)
    await f.ci.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]!.request).toMatchObject({ baseCommit, commit: 'a'.repeat(40), scope: 'affected' })
    expect(f.started[0]!.request).not.toHaveProperty('files')
    const read = await f.waitFor(reader, started.ticketId, output =>
      output.run.state === 'running' && output.run.observation?.status === 'available')
    expect(read.run).toMatchObject({ baseCommit, commit: 'a'.repeat(40), scope: 'affected', deriveFiles: true })
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record
    expect(stored).toEqual(read.run)
    f.finish(started.ticketId, 0, 'completed')
    await f.ci.dispatch()
    expect((await ciRunReadback(input => f.value(reader, 'ci_get', input), started.ticketId, 'passed')).run)
      .toMatchObject({ baseCommit, state: 'passed', exitCode: 0 })
  } finally { await f.close() }
})

it('defaults authenticated Operator MCP and HTTP calls to runner-selected affected scope with denied read-only callers', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const deniedHttp = await f.credential(CI_GET_ACTIONS)
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const headers = { authorization: `Bearer ${writer.token}` }
    for (const scope of [undefined, 'full'] as const) {
      const input = { suite: 'integration', commandId: `mcp-${scope ?? 'default'}`, ...(scope ? { scope } : {}) }
      expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
      const read = await f.waitFor(f.operator, started.ticketId, output =>
        output.run.state === 'running' && output.run.observation?.status === 'available')
      expect(read.run).toMatchObject({ scope: scope ?? 'affected', files: [] })
      expect(read.run.deriveFiles).toBe(scope === undefined ? true : undefined)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [started.ticketId])).rows[0]!
      expect(stored.record).toEqual(read.run)
      const httpInput = { ...input, commandId: `http-${scope ?? 'default'}` }
      expect((await f.app.inject({ method: 'POST', url, payload: httpInput,
        headers: { authorization: `Bearer ${deniedHttp.token}` } })).statusCode).toBe(403)
      const response = await f.app.inject({ method: 'POST', url, headers, payload: httpInput })
      expect(response.statusCode).toBe(200)
      const http = CiRunOutputSchema.parse(response.json())
      const httpRead = await f.app.inject({ method: 'GET', url: `${url}/${http.ticketId}`, headers })
      expect(CiGetOutputSchema.parse(httpRead.json()).run).toMatchObject({ scope: scope ?? 'affected', files: [] })
    }
    await f.ci.dispatch()
    const request = f.started.find(item => item.request.operation === 'start' && item.request.scope === 'affected')!.request
    expect(request).toMatchObject({ scope: 'affected', defaultBranch: 'main' })
    expect(request).not.toHaveProperty('files')
  } finally { await f.close() }
})

it('defaults authenticated Agent MCP to affected scope, reads explicit full scope and denies a caller without CI grants', async () => {
  const f = await fixture({ agent: true })
  try {
    const agent = f.agent!
    const tool = (await agent.listTools()).tools.find(item => item.name === 'ci_run')!
    expect(tool.inputSchema.properties).toHaveProperty('scope')
    expect(tool.inputSchema.properties).toHaveProperty('files')
    for (const baseCommit of [undefined, 'b'.repeat(40)]) {
      for (const scope of [undefined, 'full'] as const) {
        const result = await agent.callTool({ name: 'ci_run', arguments: {
          suite: 'integration', commandId: `agent-${scope ?? 'default'}${baseCommit ? '-base' : ''}`,
          ...(baseCommit ? { baseCommit } : {}), ...(scope ? { scope } : {}) } })
        expect(result.isError).not.toBe(true)
        const started = CiRunOutputSchema.parse(decodeMcpToolResult(result))
        const read = await agent.callTool({ name: 'ci_get', arguments: { ticketId: started.ticketId } })
        expect(read.isError).not.toBe(true)
        const run = CiGetOutputSchema.parse(decodeMcpToolResult(read)).run
        expect(run).toMatchObject({ id: started.ticketId, workspaceId: f.workspaceId,
          commit: 'a'.repeat(40), scope: scope ?? 'affected', files: [] })
        expect(run.baseCommit).toBe(baseCommit)
        expect(run.deriveFiles).toBe(scope === undefined ? true : undefined)
        await f.ci.dispatch()
        f.finish(started.ticketId, 0, 'integration passed\n')
        const completed = await f.waitFor(agent, started.ticketId, output => output.run.collection === 'complete')
        expect(completed.run).toMatchObject({ id: started.ticketId, scope: scope ?? 'affected', files: [],
          commit: 'a'.repeat(40), state: 'passed', exitCode: 0, collection: 'complete' })
        expect(completed.run.baseCommit).toBe(baseCommit)
        expect(completed.run.deriveFiles).toBe(scope === undefined ? true : undefined)
        const persisted = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
          ticketId: started.ticketId,
        }))
        expect(persisted.run).toEqual(completed.run)
      }
    }
    const stored = (await f.pool.query<{ grants: { actions: ManagementAction[]; scope: Record<string, unknown> }[] }>(
      'select grants from management_principals where id=$1', [f.authorizationPrincipalId])).rows[0]!
    const grants = stored.grants.map(grant => ({ ...grant, actions: grant.actions.filter(action => action !== 'ci') }))
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [f.authorizationPrincipalId, JSON.stringify(grants)])
    expect((await agent.callTool({ name: 'ci_run', arguments: { suite: 'unit', commandId: 'agent-denied' } })).isError).toBe(true)
    expect((await agent.callTool({ name: 'ci_run', arguments: { suite: 'unit', baseCommit: 'b'.repeat(40),
      commandId: 'agent-base-denied' } })).isError).toBe(true)
  } finally { await f.close() }
}, 60_000)

it('retains an Agent ticket for an authorized Operator after the Agent runtime closes', async () => {
  const agent = await fixture({ agent: true })
  let completed: z.infer<typeof CiGetOutputSchema>
  try {
    const started = CiRunOutputSchema.parse(await agent.value(agent.agent!, 'ci_run', {
      suite: 'install', scope: 'full', commandId: 'retained-agent-ticket',
    }))
    await agent.ci.dispatch()
    agent.finish(started.ticketId, 0, 'install passed\n')
    completed = await ciRunReadback(input => agent.value(agent.agent!, 'ci_get', input), started.ticketId, 'passed')
    expect(completed.run.state).toBe('passed')
  } finally { await agent.close() }

  const operator = await fixture()
  try {
    const input = { workspaceId: agent.workspaceId, ticketId: completed.run.id }
    expect((await operator.call(operator.operator, 'ci_get', input)).isError).toBe(true)
    const reader = await operator.connect(CI_GET_ACTIONS, { workspaceIds: [agent.workspaceId] })
    const read = CiGetOutputSchema.parse(await operator.value(reader, 'ci_get', input))
    expect(read.run).toEqual(completed.run)
    expect(read.logTail).toBe('install passed\n')
    const stored = await operator.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [read.run.id])
    expect(stored.rows[0]?.record).toEqual(read.run)
  } finally { await operator.close() }
}, 60_000)


it('persists large selections outside repository-specific roots through authenticated MCP', async () => {
  const f = await fixture()
  try {
    const files = ['root.ts', 'docs/example.ts', '.github/check.ts',
      ...Array.from({ length: 2001 }, (_, index) => `src/feature-${index}.ts`)]
    const input = { suite: 'typecheck', scope: 'affected', files,
      commit: 'a'.repeat(40), commandId: 'large-selection' }
    const reader = await f.connect(CI_GET_ACTIONS)
    const foreign = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['workspace-other'] })
    for (const caller of [reader, foreign]) {
      const denied = await f.call(caller, 'ci_run', input)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    }
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const read = await f.waitFor(reader, started.ticketId, output =>
      output.run.state === 'running' && output.run.observation?.status === 'available')
    expect(read.run).toMatchObject({ scope: 'affected', files: [...files].sort() })
    const stored = await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [started.ticketId])
    expect(stored.rows[0]!.record).toEqual(read.run)
  } finally { await f.close() }
})
