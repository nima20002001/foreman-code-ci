import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatExecutionActivityPageSchema, type AgentChatExecutionSummary } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { ExecutionActivityFold, type ExecutionEventRow } from '../src/modules/conversations/executionActivity.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { executionProjectionRows } from './agent-chat-execution-activity.testSupport.js'

const at = '2026-01-01T00:00:00.000Z'
let sequence = 0
const event = (itemKey: string, type: string, payload: Record<string, unknown>): ExecutionEventRow =>
  ({ sequence: ++sequence, item_key: itemKey, record: { type, payload: { threadId: 'thread', turnId: 'turn', ...payload }, occurredAt: at } })
const notification = (itemKey: string, nativeMethod: string, payload: Record<string, unknown>) =>
  event(itemKey, 'native.notification', { itemId: itemKey, nativeMethod, ...payload })
const command = (id: string, status: string, output: string | null) => ({ id, type: 'commandExecution', status,
  command: "/bin/bash -lc 'git status'", cwd: '/work', commandActions: [{ type: 'unknown', command: 'git status' }], aggregatedOutput: output })

function liveRun() {
  sequence = 0
  return [
    event('user-1', 'item.completed', { item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Check CI' }] } }),
    event('msg-1', 'item.started', { item: { id: 'msg-1', type: 'agentMessage', text: '' } }),
    notification('msg-1', 'item/agentMessage/delta', { delta: 'Looking ' }),
    notification('msg-1', 'item/agentMessage/delta', { delta: 'now' }),
    event('cmd-1', 'item.started', { item: command('cmd-1', 'inProgress', null) }),
    notification('cmd-1', 'item/commandExecution/outputDelta', { delta: 'On branch main\n' }),
    event('mcp-1', 'item.started', { item: { id: 'mcp-1', type: 'mcpToolCall', server: 'foreman-code', tool: 'ci_get', status: 'inProgress', arguments: { runId: 'r1' } } }),
    event('mcp-1', 'item.completed', { item: { id: 'mcp-1', type: 'mcpToolCall', server: 'foreman-code', tool: 'ci_get', status: 'completed',
      arguments: { runId: 'r1' }, result: { _meta: null, content: [{ type: 'text', text: '{"status":"passed"}' }] } } }),
    event('plan:turn', 'native.notification', { nativeMethod: 'turn/plan/updated', plan: [{ step: 'Read logs', status: 'completed' }, { step: 'Fix', status: 'inProgress' }] }),
    event('rs-1', 'item.completed', { item: { id: 'rs-1', type: 'reasoning', summary: [], content: [] } }),
  ]
}

describe('Agent chat live execution activity projection', () => {
  it('projects streamed messages and every public step in native order, identically when folded incrementally', () => {
    const rows = liveRun()
    const whole = new ExecutionActivityFold(); whole.apply(rows)
    const stepwise = new ExecutionActivityFold(); for (const row of rows) stepwise.apply([row])
    const items = whole.items('execution-1', false)
    expect(stepwise.items('execution-1', false)).toEqual(items)
    expect(items.map((item) => item.entry.kind === 'message'
      ? [item.entry.message.role, item.entry.message.content, item.entry.message.nativeMessageComplete]
      : [item.entry.activity.kind, item.entry.activity.title, item.entry.activity.status, item.entry.activity.output])).toEqual([
      ['user', 'Check CI', true],
      ['assistant', 'Looking now', false],
      ['tool', 'git status', 'running', 'On branch main\n'],
      ['mcp', 'foreman-code · ci_get', 'completed', '{"status":"passed"}'],
      ['tool', 'Update plan', 'completed', '[x] Read logs\n[~] Fix'],
    ])
  })

  it('replaces streamed text with completed native results and marks unfinished steps of a finished execution', () => {
    const rows = liveRun()
    const fold = new ExecutionActivityFold(); fold.apply(rows)
    fold.apply([
      event('msg-1', 'item.completed', { item: { id: 'msg-1', type: 'agentMessage', text: 'Looking now. Done.' } }),
      event('cmd-1', 'item.completed', { item: command('cmd-1', 'completed', 'clean\n') }),
      event('cmd-2', 'item.started', { item: command('cmd-2', 'inProgress', null) }),
    ])
    const items = fold.items('execution-1', true)
    expect(items.find((item) => item.id === 'msg-1')?.entry).toMatchObject({ message: { content: 'Looking now. Done.', nativeMessageComplete: true } })
    expect(items.find((item) => item.id === 'cmd-1')?.entry).toMatchObject({ activity: { status: 'completed', output: 'clean\n' } })
    expect(items.find((item) => item.id === 'cmd-2')?.entry).toMatchObject({ activity: { status: 'unknown' } })
  })

  it('bounds previews and returns full bodies for an expanded entry', () => {
    sequence = 0
    const fold = new ExecutionActivityFold()
    fold.apply([event('cmd-big', 'item.completed', { item: command('cmd-big', 'completed', 'x'.repeat(10_000)) })])
    const [preview] = fold.items('execution-1', false)
    expect(preview?.entry).toMatchObject({ activity: { truncated: true } })
    expect(preview?.entry.kind === 'activity' && preview.entry.activity.output?.length).toBeLessThan(10_000)
    const [full] = fold.items('execution-1', false, { message: 65_536, input: 16_000, output: 24_000 })
    expect(full?.entry.kind === 'activity' && full.entry.activity.output?.length).toBe(10_000)
  })

  it('retains Claude streamed arguments, canonical file edits and redacted bounded results', () => {
    sequence = 0
    const token = `opm_${'a'.repeat(43)}`
    const fold = new ExecutionActivityFold()
    fold.apply([
      event('claude:tool:shell', 'claude.tool', { itemId: 'claude:tool:shell', name: 'Bash', status: 'running' }),
      event('claude:tool:shell', 'claude.tool', { itemId: 'claude:tool:shell', name: 'Bash',
        inputJsonDelta: '{"command":"git ', status: 'running' }),
      event('claude:tool:shell', 'claude.tool', { itemId: 'claude:tool:shell', name: 'Bash',
        inputJsonDelta: 'status"}', status: 'running' }),
    ])
    expect(fold.items('execution', false)[0]?.entry).toMatchObject({ activity: { input: '{"command":"git status"}' } })
    fold.apply([
      event('claude:tool:shell', 'claude.tool', { itemId: 'claude:tool:shell', name: 'Bash',
        input: { command: 'git status' }, status: 'running' }),
      event('claude:tool:shell', 'claude.tool', { itemId: 'claude:tool:shell', name: 'Bash',
        output: [{ type: 'text', text: `clean ${token} ${'界'.repeat(10_000)}` }], status: 'completed' }),
      event('claude:tool:edit', 'claude.tool', { itemId: 'claude:tool:edit', name: 'Edit', status: 'running',
        input: { file_path: '/project/app.ts', old_string: 'before', new_string: 'after' } }),
      event('claude:tool:edit', 'claude.tool', { itemId: 'claude:tool:edit', name: 'Edit', status: 'completed', output: 'updated' }),
    ])
    const items = fold.items('execution', false)
    expect(items[0]?.entry).toMatchObject({ activity: { title: 'git status', status: 'completed', truncated: true } })
    const shell = items[0]?.entry
    expect(shell?.kind === 'activity' && shell.activity.output).toContain('[REDACTED]')
    expect(JSON.stringify(items)).not.toContain(token)
    expect(shell?.kind === 'activity' && Buffer.byteLength(shell.activity.output!)).toBeLessThanOrEqual(4_000)
    expect(items[1]?.entry).toMatchObject({ activity: { title: 'Edit /project/app.ts',
      input: expect.stringContaining('after'), output: 'updated' } })
  })
})

interface ExecutionFixture {
  id: string; tick: number | null; state: AgentChatExecutionSummary['state']
  createdAt: Date; events: ExecutionEventRow[]; recordRevision: number
}

function service() {
  const workspaceId = 'workspace-live', workflowId = 'workflow-live', runId = 'run-live', workflowNodeId = 'node-live', agentId = 'agent-live'
  const principal: ManagementPrincipal = { id: 'live-reader', name: 'Live reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId], workflowIds: [workflowId] } }] }
  const executions: ExecutionFixture[] = [
    { id: 'execution-main', tick: null, state: 'completed', createdAt: new Date('2026-01-01T00:00:00Z'), events: [], recordRevision: 0 },
    { id: 'execution-check-1', tick: 1, state: 'running', createdAt: new Date('2026-01-01T00:02:00Z'), events: liveRun(), recordRevision: 0 },
  ]
  executions[0]!.events = [event('final', 'item.completed', { item: { id: 'final', type: 'agentMessage', text: 'Initial work finished' } })]
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('management_principals')) return { rows: [{ id: principal.id, name: principal.name, audience: 'operator',
      grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
    if (sql.includes('from harness_executions e join runs r')) {
      if (values[0] !== runId || values[1] !== workflowNodeId || values[2] !== agentId || values[3] !== workspaceId || values[4] !== workflowId) return { rows: [] }
      return { rows: [...executions].reverse().map((execution) => ({ id: execution.id, attempt: 1, tick_index: execution.tick,
        occurrence_index: null, state: execution.state, native_session_id: 'thread', created_at: execution.createdAt,
        started_at: execution.createdAt.toISOString(), finished_at: null,
        revision: String(execution.events.at(-1)?.sequence ?? 0), record_revision: String(execution.recordRevision) })) }
    }
    if (sql.includes('from harness_native_events n')) {
      const execution = executions.find((entry) => entry.id === values[0])
      return { rows: executionProjectionRows(execution?.events ?? [], values) }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const unused = new Proxy({}, { get: () => { throw new Error('Execution activity must not use chat storage or native sessions') } })
  const chat = new AgentChatService(pool, unused as never, unused as never, unused as never, unused as never, unused as never, '/fixture')
  return { chat, pool, principal, executions, context: { workspaceId, workflowId, runId, workflowNodeId, agentId } }
}

const cleanup: AgentChatService[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((chat) => chat.shutdown())) })

describe('Agent chat live execution activity over HTTP', () => {
  it('streams labeled interval checks by cursor, pages earlier entries, expands one entry, and denies a wrong scope', async () => {
    const f = service()
    cleanup.push(f.chat)
    const access = new PostgresAccessService(f.pool)
    const denied = { ...f.principal, id: 'wrong-scope', grants: [{ actions: ['agent_chat:read' as const], scope: { workspaceIds: ['other'] } }] }
    vi.spyOn(access, 'authenticate').mockImplementation(async (token) => token === 'reader' ? f.principal : denied)
    const recordDenied = vi.fn(async () => undefined)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: f.chat, commands: { recordDenied } } as unknown as OperatorServices },
    })
    const { workspaceId, ...query } = f.context
    const read = async (params: Record<string, string>, token = 'reader') => app.inject({ method: 'GET',
      url: `/api/workspaces/${workspaceId}/agent-chat/execution-activity?${new URLSearchParams({ ...query, ...params })}`,
      headers: { authorization: `Bearer ${token}` } })
    const page = async (params: Record<string, string>) => {
      const response = await read(params)
      expect(response.statusCode, response.body).toBe(200)
      return AgentChatExecutionActivityPageSchema.parse(response.json())
    }
    try {
      const first = await page({})
      expect(first.mode).toBe('snapshot')
      expect(first.executions.map((execution) => [execution.label, execution.state])).toEqual([['Execution', 'completed'], ['Loop 1', 'running']])
      expect(first.items.map((item) => [item.executionId, item.id])).toEqual([['execution-main', 'final'],
        ['execution-check-1', 'user-1'], ['execution-check-1', 'msg-1'], ['execution-check-1', 'cmd-1'],
        ['execution-check-1', 'mcp-1'], ['execution-check-1', 'plan:turn']])
      expect(await page({ cursor: first.cursor! })).toMatchObject({ mode: 'changes', items: [] })

      const live = f.executions[1]!
      live.events.push(event('cmd-1', 'item.completed', { item: command('cmd-1', 'completed', 'clean\n') }))
      live.recordRevision += 1
      const changed = await page({ cursor: first.cursor! })
      expect(changed.items).toEqual([expect.objectContaining({ executionId: live.id, id: 'cmd-1',
        entry: { kind: 'activity', activity: expect.objectContaining({ title: 'git status', status: 'completed', output: 'clean\n' }) } })])

      for (const id of ['paged-1', 'paged-2', 'paged-3']) {
        live.events.push(event(id, 'item.started', { item: command(id, 'inProgress', null) }))
        live.recordRevision += 1
      }
      const partial = await page({ cursor: changed.cursor!, limit: '1' })
      expect(partial.items.map((item) => item.id)).toEqual(['paged-1'])
      expect(partial.hasMoreChanges).toBe(true)
      live.events.push(event('paged-4', 'item.started', { item: command('paged-4', 'inProgress', null) }))
      live.recordRevision += 1
      let progress = partial
      for (const id of ['paged-2', 'paged-3', 'paged-4']) {
        progress = await page({ cursor: progress.cursor!, limit: '1' })
        expect(progress.items.map((item) => item.id)).toEqual([id])
        live.recordRevision += 1
      }
      expect(progress.hasMoreChanges).toBe(false)
      expect(await page({ cursor: progress.cursor! })).toMatchObject({ items: [] })

      const earlier = await page({ executionId: live.id, before: first.items[3]!.sequence, limit: '1' })
      expect(earlier.items.map((item) => item.id)).toEqual(['msg-1'])
      expect(earlier.executions.find((execution) => execution.executionId === live.id)?.hasEarlierItems).toBe(true)
      expect(await page({ executionId: live.id, itemId: 'mcp-1' })).toMatchObject({ mode: 'item', items: [{ id: 'mcp-1' }] })

      live.events.push(event('unfinished', 'item.started', { item: command('unfinished', 'inProgress', null) }))
      const beforeStop = await page({})
      live.state = 'completed'
      live.recordRevision += 1
      let stopped = await page({ cursor: beforeStop.cursor!, limit: '1' })
      const terminalItems = [...stopped.items]
      for (let count = 0; stopped.hasMoreChanges && count < 20; count += 1) {
        stopped = await page({ cursor: stopped.cursor!, limit: '1' })
        terminalItems.push(...stopped.items)
      }
      expect(stopped.hasMoreChanges).toBe(false)
      expect(terminalItems.find((item) => item.id === 'unfinished')?.entry)
        .toMatchObject({ activity: { status: 'unknown' } })
      expect(await page({ cursor: stopped.cursor! })).toMatchObject({ items: [] })
      const expanded = await page({ executionId: live.id, itemId: 'unfinished' })
      expect(expanded.items[0]?.entry).toMatchObject({ activity: { status: 'unknown' } })
      expect(BigInt(expanded.items[0]!.revision)).toBeGreaterThan(
        BigInt(beforeStop.items.find((item) => item.id === 'unfinished')!.revision))

      expect((await read({}, 'denied')).statusCode).toBe(403)
      expect(recordDenied).toHaveBeenCalledWith('wrong-scope', 'http', expect.any(String), `/api/workspaces/${workspaceId}/agent-chat/execution-activity`)
    } finally {
      await app.close()
    }
  })
})
