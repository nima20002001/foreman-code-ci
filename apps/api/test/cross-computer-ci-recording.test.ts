import { readFileSync } from 'node:fs'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { collectCiReadback, recordScenario, type RecordedScenario } from './helpers/crossComputerCiRecording.js'
import { createScenarioObservation, pollCiScenario, type RunningCiWorkflow } from './helpers/crossComputerCiObservation.js'
import type { CrossComputerCiInput } from './helpers/crossComputerCiInput.js'
import { verifyScenario } from './helpers/crossComputerCiVerification.js'

afterEach(() => vi.useRealTimers())

it('collects delayed public readbacks into one JSON value that replays offline', async () => {
  vi.useFakeTimers()
  const recorded: RecordedScenario = JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
  const workflows = recorded.workflows.map(workflow => ({
    workspace: { workspaceId: workflow.workspaceId, project: workflow.project }, graph: { id: workflow.workflowId },
    saved: { version: { id: workflow.workflowVersionId } }, runId: workflow.runId, repository: workflow.repository,
    assignments: workflow.assignments.map(agent => ({ ...agent, profile: { target: { hostRef: agent.hostRef } } })),
  })) as unknown as RunningCiWorkflow[]
  const observation = createScenarioObservation()
  let published = false
  const callTool = vi.fn<Client['callTool']>(async request => {
    const args = request.arguments!
    const workflow = recorded.workflows.find(value => value.runId === args.runId
      || recorded.tickets.some(ticket => ticket.runId === value.runId && ticket.ticketId === args.ticketId))!
    if (workflow.workspaceId !== args.workspaceId) {
      return { isError: true, content: [], structuredContent: { error: { code: 'NOT_FOUND' } } }
    }
    let result: unknown
    if (request.name === 'run_get') result = recorded.runs.find(value => value.run.id === args.runId)
    else if (request.name === 'ci_list') result = recorded.ciLists[workflow.runId]
    else if (request.name === 'ci_get') result = Object.values(recorded.groups).find(value => value.run.id === args.ticketId)
    else if (request.name === 'run_activities_get_v1') {
      const items = recorded.activities[workflow.runId]!
      result = { scope: items[0]!.scope, items, mode: 'initial', highWater: '3', retainedFrom: '0',
        nextCursor: 'cursor', olderCursor: null, hasMore: false }
    } else if (request.name === 'run_executions_list') {
      const page = structuredClone(recorded.executions[workflow.runId]![0]!)
      if (!published) delete page.items[0]!.worktree
      result = page
    } else if (request.name === 'run_node_placement_get') {
      result = Object.values(recorded.placements).find(value => value.nodeId === args.nodeId)
    } else if (request.name === 'ci_logs_read') {
      const ticket = recorded.tickets.find(value => value.ticketId === args.ticketId)!
      result = args.group ? recorded.groupLogs[ticket.latest.groupId]
        : { ...ticket.log, nextOffset: ticket.log!.logBytes, maxBytes: 65_536 }
    } else throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: result }
  })
  const client = { callTool } as unknown as Client
  const input = { workspaces: recorded.workspaces, excludedComputers: [] } as unknown as CrossComputerCiInput
  await pollCiScenario(client, workflows, observation, async () => undefined)
  const pending = collectCiReadback(client, workflows, observation, input)
  await vi.advanceTimersByTimeAsync(500)
  published = true
  await vi.runAllTimersAsync()
  await pending
  expect(observation.readErrors).toEqual([])
  const replay = JSON.parse(JSON.stringify(recordScenario(workflows, observation, input)))
  expect(replay.workflows[0].assignments[0].task).toEqual(recorded.workflows[0]!.assignments[0]!.task)
  expect(replay.placements).toHaveProperty('execution-1')
  expect(replay.tickets.every((ticket: { log: unknown }) => ticket.log)).toBe(true)
  expect(() => verifyScenario(replay)).not.toThrow()
})

it('gives later group publications their own allowance', async () => {
  vi.useFakeTimers()
  const started = Date.now()
  const recorded: RecordedScenario = JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
  const observation = createScenarioObservation()
  observation.groups = new Map(Object.entries(recorded.groups))
  const groupIds = [...observation.groups.keys()]
  const callTool = vi.fn<Client['callTool']>(async request => {
    const group = [...observation.groups.values()].find(value => value.run.id === request.arguments!.ticketId)!
    const readyAt = group.run.groupId === groupIds[0] ? 110_000 : 140_000
    const logs = structuredClone(recorded.groupLogs[group.run.groupId]!)
    if (Date.now() - started < readyAt) logs.parts = []
    return { content: [], structuredContent: logs }
  })
  const input = { workspaces: [], excludedComputers: [] } as unknown as CrossComputerCiInput
  const pending = collectCiReadback({ callTool } as unknown as Client, [], observation, input)
  await vi.runAllTimersAsync()
  await pending
  expect(observation.readErrors).toEqual([])
  expect([...observation.groupLogs.values()].every(logs => logs.parts!.length > 0)).toBe(true)
  expect(Date.now() - started).toBe(140_000)
})

it('bounds all diagnostics together and stops issuing reads after the collection budget', async () => {
  vi.useFakeTimers()
  const started = Date.now()
  const recorded: RecordedScenario = JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
  const observation = createScenarioObservation()
  const workflows = recorded.workflows.map(workflow => ({
    workspace: { workspaceId: workflow.workspaceId }, graph: { id: workflow.workflowId },
    assignments: [], runId: workflow.runId,
  })) as unknown as RunningCiWorkflow[]
  for (let index = 0; index < 12; index++) {
    const ticket = { ...recorded.tickets[0]!, ticketId: `ticket-${index}` }
    observation.tickets.set(ticket.ticketId, ticket)
  }
  const callTool = vi.fn<Client['callTool']>(async (_request, options) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Diagnostic unavailable')), 30_000)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(options.signal!.reason)
    }, { once: true })
  }))
  const input = { workspaces: [], excludedComputers: [] } as unknown as CrossComputerCiInput
  await Promise.all([collectCiReadback({ callTool } as unknown as Client, workflows, observation, input),
    vi.runAllTimersAsync()])
  expect(Date.now() - started).toBeLessThanOrEqual(300_000)
  expect(observation.readErrors.some(error => /collection.*budget|collection.*Timed out/i.test(error))).toBe(true)
  const count = callTool.mock.calls.length
  await vi.advanceTimersByTimeAsync(300_000)
  expect(callTool).toHaveBeenCalledTimes(count)
})
