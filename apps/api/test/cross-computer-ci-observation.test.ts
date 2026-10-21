import { readFileSync } from 'node:fs'
import type { Client } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import type { SavedRunDetails } from '@foreman-code/contracts/wave25'
import { createScenarioObservation, pollCiScenario,
  type RunningCiWorkflow } from './helpers/crossComputerCiObservation.js'

function fixture() {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
  const workflow = recorded.workflows[0]
  const details = recorded.runs[0]
  const ticket = recorded.tickets[0].latest
  const prepared = { workspace: { workspaceId: workflow.workspaceId }, graph: { id: workflow.workflowId },
    saved: { version: { id: workflow.workflowVersionId } }, runId: workflow.runId, repository: workflow.repository,
    assignments: workflow.assignments } as RunningCiWorkflow
  const activity = { scope: recorded.activities['run-1'][0].scope, items: recorded.activities['run-1'],
    mode: 'initial', highWater: '3', retainedFrom: '0', nextCursor: 'cursor', olderCursor: null, hasMore: false }
  const replies: Record<string, unknown> = {
    run_get: details, ci_get: recorded.groups[ticket.groupId], ci_list: recorded.ciLists['run-1'],
    run_activities_get_v1: activity,
  }
  const callTool = vi.fn<Client['callTool']>(async request => {
    if (!(request.name in replies)) throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: replies[request.name] }
  })
  return { ticket, prepared, replies, activity, observation: createScenarioObservation(), callTool,
    client: { callTool } as unknown as Client }
}

it('discovers tickets from product initiators without a copied identifier in the Agent report', async () => {
  const f = fixture()
  await pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
  expect(f.observation.tickets.get(f.ticket.id)?.latest).toEqual(expect.objectContaining(f.ticket))
  expect(f.observation.reports.get('execution-1')).not.toHaveProperty('ticketId')
  expect(f.callTool.mock.calls.some(([request]) => request.name === 'ci_list')).toBe(true)
})

it('waits for delayed ticket publication after a workflow completes', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    const ciList = f.replies.ci_list
    f.replies.ci_list = { runId: 'run-1', jobs: [], truncated: false }
    f.replies.run_activities_get_v1 = { ...f.activity, items: [], highWater: '0' }
    const pending = pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
    await vi.advanceTimersByTimeAsync(500)
    f.replies.ci_list = ciList
    f.replies.run_activities_get_v1 = f.activity
    await vi.runAllTimersAsync()
    await pending
    expect(f.observation.tickets.has(f.ticket.id)).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('records malformed reports for replay instead of failing before readbacks are collected', async () => {
  const f = fixture()
  const details = f.replies.run_get as { executions: { result: { output: unknown } }[] }
  details.executions[0]!.result.output = 'not JSON'
  await pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
  expect(f.observation.tickets.has(f.ticket.id)).toBe(true)
  expect(f.observation.reports.get('execution-1')).toBe('not JSON')
})

it('collects failed file results for every failed partition after the group settles', async () => {
  const f = fixture()
  const failed = { ...structuredClone(f.ticket), id: '22222222-2222-4222-8222-000000000003',
    state: 'failed', exitCode: 1 }
  const tests = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false,
    files: [{ file: 'apps/api/test/example.test.ts', status: 'failed', durationMs: 1,
      tests: [{ name: 'normalizes a label', status: 'failed', durationMs: 1 }] }] }
  f.callTool.mockImplementation(async request => {
    if (request.name === 'ci_get') {
      const run = request.arguments!.ticketId === failed.id ? failed : f.ticket
      return { content: [], structuredContent: { run, partitions: [f.ticket, failed],
        group: { groupId: failed.groupId, state: 'failed' },
        ...(request.arguments!.testStatus ? { tests } : {}) } }
    }
    if (!(request.name in f.replies)) throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: f.replies[request.name] }
  })
  const items = [...f.activity.items]
  for (const [index, item] of f.activity.items.filter((item: { kind: string }) => item.kind === 'job_work').entries()) {
    items.push({ ...structuredClone(item), id: `failed-activity-${index}`, sequence: String(items.length + 1),
      refs: { ...item.refs, ciTicketId: failed.id }, status: item.status === 'completed' ? 'failed' : item.status })
  }
  f.replies.run_activities_get_v1 = { ...f.activity, items, highWater: String(items.length) }
  await pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
  expect(f.observation.tickets.get(failed.id)?.tests).toEqual(tests)
  expect(f.callTool.mock.calls.some(([request]) => request.name === 'ci_get'
    && request.arguments?.ticketId === failed.id && Array.isArray(request.arguments?.testStatus))).toBe(true)
})


it.each(['object', 'json', 'native-text', 'active-sibling'] as const)(
  'fails promptly with direction findings from a %s result', async carrier => {
    vi.useFakeTimers()
    const f = fixture()
    const details = f.replies.run_get as SavedRunDetails
    details.run.executionState = 'waiting'
    details.run.outcome = 'pending'
    delete details.run.result
    delete details.run.finishedAt
    const findings = ['CI passed but did not execute the requested test file', { message: 'Selected test never ran' }]
    const output = { routing: { kind: 'finish' }, data: { latestDeliverable: 'CI completed', remainingFindings: findings } }
    details.executions[0]!.result = { outcome: 'succeeded', output: carrier === 'json' ? JSON.stringify(output)
      : carrier === 'native-text' ? { text: JSON.stringify(output) } : output }
    if (carrier === 'active-sibling') {
      const sibling = { ...details.executions[0]!, id: 'active-sibling', state: 'running' as const }
      delete sibling.result
      delete sibling.finishedAt
      details.executions.push(sibling)
    }
    details.executions.unshift({ ...details.executions[0]!, id: 'coordinator-ready',
      result: { outcome: 'succeeded', output: { text: 'Ready' } } })
    const failed = vi.fn()
    const pending = pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined).catch(failed)
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(failed).toHaveBeenCalledOnce()
      expect(failed.mock.calls[0]![0]).toBeInstanceOf(Error)
      expect(failed.mock.calls[0]![0].message).toContain('run-1')
      for (const finding of [findings[0], 'Selected test never ran']) {
        expect(failed.mock.calls[0]![0].message).toContain(finding)
      }
      expect(f.observation.runs.get('run-1')?.run.executionState).toBe('waiting')
    } finally {
      vi.setSystemTime(Date.now() + 4 * 60 * 60_000)
      await vi.runOnlyPendingTimersAsync()
      await pending
      vi.useRealTimers()
    }
  },
)

it.each(['completed', 'waiting', 'none'] as const)(
  'fails promptly when a waiting Run has no active execution (%s)', async state => {
    vi.useFakeTimers()
    const f = fixture()
    const details = f.replies.run_get as SavedRunDetails
    details.run.executionState = 'waiting'
    details.run.outcome = 'pending'
    delete details.run.result
    delete details.run.finishedAt
    if (state === 'none') details.executions = []
    if (state === 'waiting') {
      details.executions[0]!.state = state
      delete details.executions[0]!.result
      delete details.executions[0]!.finishedAt
    }
    const failed = vi.fn()
    const pending = pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined).catch(failed)
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(failed).toHaveBeenCalledOnce()
      expect(failed.mock.calls[0]![0].message).toMatch(/Run run-1.*waiting.*no active execution/i)
    } finally {
      vi.setSystemTime(Date.now() + 4 * 60 * 60_000)
      await vi.runOnlyPendingTimersAsync()
      await pending
      vi.useRealTimers()
    }
  },
)

it.each(['queued', 'starting', 'running'] as const)(
  'keeps observing a waiting Run while an execution is %s', async state => {
    vi.useFakeTimers()
    const f = fixture()
    const completed = structuredClone(f.replies.run_get)
    const details = f.replies.run_get as SavedRunDetails
    details.executions.push({ ...details.executions[0]!, id: 'coordinator-ready',
      result: { outcome: 'succeeded', output: { text: 'Ready' } } })
    details.run.executionState = 'waiting'
    details.run.outcome = 'pending'
    delete details.run.result
    delete details.run.finishedAt
    details.executions[0]!.state = state
    delete details.executions[0]!.result
    delete details.executions[0]!.finishedAt
    const failed = vi.fn()
    const pending = pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined).catch(failed)
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(failed).not.toHaveBeenCalled()
      f.replies.run_get = completed
      await vi.advanceTimersByTimeAsync(1000)
      await pending
      expect(failed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  },
)
