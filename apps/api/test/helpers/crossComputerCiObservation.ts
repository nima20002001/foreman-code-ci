import { isDeepStrictEqual } from 'node:util'
import type { Client } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiListOutputSchema, type CiListOutput, type CiRunRecord,
  type CiLogsOutputSchema } from '@foreman-code/contracts'
import type { RunPlacementGetResult } from '@foreman-code/contracts/placement-readback'
import { RunActivitiesPageSchema, SavedRunDetailsSchema, WorkHandoffResultSchema,
  type RunActivityPublic, type SavedRunDetails, type RunExecutionsPage } from '@foreman-code/contracts/wave25'
import { z } from 'zod'
import { callCiTool, type PreparedCiWorkflow } from './crossComputerCiSetup.js'
import { ciGroupRequestedBy, ciTerminal, type CiReadback } from './crossComputerCiReadback.js'
import { waitForCi } from './crossComputerCiWait.js'

export type RunningCiWorkflow = PreparedCiWorkflow & { runId: string }
export type TicketObservation = {
  ticketId: string
  workspaceId: string
  workflowId: string
  runId: string
  agentId: string
  initiatingExecutionId: string
  timeline: { observedAt: string; run: CiRunRecord }[]
  latest: CiRunRecord
  tests?: CiReadback['tests']
  log?: { text: string; logBytes: number }
}
export function createScenarioObservation() {
  return {
    tickets: new Map<string, TicketObservation>(),
    groups: new Map<string, CiReadback>(),
    runs: new Map<string, SavedRunDetails>(),
    reports: new Map<string, unknown>(),
    agentStates: new Map<string, { observedAt: string; state: string }[]>(),
    activities: new Map<string, Map<string, RunActivityPublic>>(),
    activityPages: new Map<string, z.infer<typeof RunActivitiesPageSchema>[]>(),
    activityCursors: new Map<string, string>(),
    ciLists: new Map<string, CiListOutput>(),
    executions: new Map<string, RunExecutionsPage[]>(),
    placements: new Map<string, RunPlacementGetResult>(),
    groupLogs: new Map<string, z.infer<typeof CiLogsOutputSchema>>(),
    isolation: [] as { tool: string; isError: boolean; body: unknown }[],
    exclusions: [] as { workspaceId: string; hostRef: unknown; ready: boolean; reasons: string[] }[],
    readErrors: [] as string[],
  }
}
export type ScenarioObservation = ReturnType<typeof createScenarioObservation>

async function captureWorkflowActivity(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const items = observation.activities.get(workflow.runId) ?? new Map<string, RunActivityPublic>()
  const pages = observation.activityPages.get(workflow.runId) ?? []
  let cursor = observation.activityCursors.get(workflow.runId)
  let nextCursor = cursor
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = RunActivitiesPageSchema.parse(await callCiTool(client, 'run_activities_get_v1', {
      workspaceId: workflow.workspace.workspaceId, runId: workflow.runId, limit: 100,
      ...(cursor ? { cursor } : {}),
    }))
    pages.push(page)
    observation.activityPages.set(workflow.runId, pages)
    for (const item of page.items) items.set(item.id, item)
    observation.activities.set(workflow.runId, items)
    if (page.mode !== 'older') nextCursor = page.nextCursor
    const follow = page.mode === 'newer' && page.hasMore ? page.nextCursor : page.olderCursor
    if (!follow) {
      observation.activityCursors.set(workflow.runId, nextCursor!)
      return
    }
    cursor = follow
  }
  throw new Error('Run activity collection exceeded its bounded pagination budget.')
}

function recordCiGroup(workflow: RunningCiWorkflow, readback: CiReadback, observation: ScenarioObservation) {
  const executionId = readback.run.initiator.executionId ?? ''
  // A group another Run's Agent joined belongs to the Run of the Agent that initiated it.
  const owner = [...observation.runs.values()].find(details => details.executions.some(item => item.id === executionId))
  const execution = owner?.executions.find(item => item.id === executionId)
  for (const run of readback.partitions ?? [readback.run]) {
    const observed: TicketObservation = observation.tickets.get(run.id) ?? {
      ticketId: run.id, workspaceId: workflow.workspace.workspaceId, workflowId: workflow.graph.id,
      runId: workflow.runId, agentId: '', initiatingExecutionId: executionId,
      timeline: [], latest: run,
    }
    if (owner && execution) {
      observed.runId = owner.run.id
      observed.workflowId = owner.run.workflowId
      observed.agentId = execution.agentId
    }
    if (!isDeepStrictEqual(observed.latest, run) || !observed.timeline.length) {
      observed.timeline.push({ observedAt: new Date().toISOString(), run })
    }
    observed.latest = run
    observation.tickets.set(run.id, observed)
  }
  observation.groups.set(readback.run.groupId, readback)
}

function failIfWaitingWithoutProgress(details: SavedRunDetails) {
  if (details.run.executionState !== 'waiting') return
  const findings = details.executions.filter(execution => execution.state === 'completed').flatMap(execution => {
    const output = execution.result?.output
    const envelope = z.object({ text: z.string() }).safeParse(output)
    const raw = envelope.success ? envelope.data.text : output
    const serializedHandoff = typeof raw === 'string' && raw.trimStart().startsWith('{')
    const value: unknown = serializedHandoff ? JSON.parse(raw) : raw
    const handoff = WorkHandoffResultSchema.safeParse(value)
    return handoff.success ? handoff.data.data.remainingFindings : []
  })
  const directionWait = findings.length > 0 || details.activity.some(event => event.kind === 'work_direction_wait')
  const active = details.executions.some(execution => ['queued', 'starting', 'running'].includes(execution.state))
  if (directionWait || !active) {
    const reason = directionWait ? 'waiting for direction' : 'waiting with no active execution'
    throw new Error(`Run ${details.run.id} is ${reason}. Remaining findings: ${JSON.stringify(findings)}`)
  }
}

async function observeWorkflow(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
  const details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' }))
  observation.runs.set(workflow.runId, details)
  failIfWaitingWithoutProgress(details)
  for (const execution of details.executions) {
    const states = observation.agentStates.get(execution.id) ?? []
    if (states.at(-1)?.state !== execution.state) {
      states.push({ observedAt: new Date().toISOString(), state: execution.state })
    }
    observation.agentStates.set(execution.id, states)
    if (workflow.assignments.some(agent => agent.agentId === execution.agentId && agent.suite)
      && execution.result?.outcome === 'succeeded') {
      observation.reports.set(execution.id, execution.result.output)
    }
  }
  await captureWorkflowActivity(client, workflow, observation)
  const listed = CiListOutputSchema.parse(await callCiTool(client, 'ci_list', scope))
  observation.ciLists.set(workflow.runId, listed)
  const ids = new Set(listed.jobs.map(job => job.ticketId))
  for (const item of observation.activities.get(workflow.runId)?.values() ?? []) {
    if (item.kind === 'job_work' && item.refs.ciTicketId) ids.add(item.refs.ciTicketId)
  }
  for (const ticket of observation.tickets.values()) {
    if (ticket.runId === workflow.runId) ids.add(ticket.ticketId)
  }
  const groups = new Set<string>()
  for (const ticketId of ids) {
    const known = observation.tickets.get(ticketId)
    if (known && groups.has(known.latest.groupId)) continue
    const readback = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
      workspaceId: workflow.workspace.workspaceId, ticketId,
    }))
    recordCiGroup(workflow, readback, observation)
    for (const run of readback.partitions ?? [readback.run]) {
      if (run.state !== 'failed') continue
      const failed = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
        workspaceId: workflow.workspace.workspaceId, ticketId: run.id, testStatus: ['failed'], logTail: false,
      }))
      observation.tickets.get(run.id)!.tests = failed.tests
    }
    groups.add(readback.run.groupId)
  }
}

export async function pollCiScenario(client: Client, workflows: RunningCiWorkflow[],
  observation: ScenarioObservation, persist: () => Promise<void>) {
  const deadline = Date.now() + 4 * 60 * 60_000
  let publicationDeadline: number | undefined
  let nextCheckpoint = 0
  await waitForCi('workflow completion and CI publication', async () => {
    await Promise.all(workflows.map(workflow => observeWorkflow(client, workflow, observation)))
    if (Date.now() >= nextCheckpoint) {
      await persist()
      nextCheckpoint = Date.now() + 30_000
    }
    const finished = workflows.every(workflow => {
      const details = observation.runs.get(workflow.runId)
      return details?.run.executionState === 'completed' && !details.cleanupPending
    })
    if (!finished) return false
    publicationDeadline ??= Date.now() + 120_000
    const published = workflows.every(workflow => {
      const details = observation.runs.get(workflow.runId)!
      if (details.run.outcome !== 'succeeded') return true
      return details.executions.filter(execution => execution.result?.outcome === 'succeeded')
        .filter(execution => workflow.assignments.some(agent => agent.agentId === execution.agentId && agent.suite))
        .every(execution => [...observation.groups.values()].some(group => ciGroupRequestedBy(group, execution.id)))
    })
    const terminal = [...observation.tickets.values()].every(ticket => ciTerminal(ticket.latest.state)
      && ticket.latest.collection !== 'pending')
    const activityPublished = workflows.every(workflow => {
      const items = [...(observation.activities.get(workflow.runId)?.values() ?? [])]
      const details = observation.runs.get(workflow.runId)!
      const agents = details.executions.filter(execution => execution.result?.outcome === 'succeeded')
        .every(execution => items.some(item => item.kind === 'agent_work'
          && item.refs.executionId === execution.id && item.status === 'completed'))
      const tickets = [...observation.tickets.values()].filter(ticket => ticket.runId === workflow.runId)
        .every(ticket => ['queued', ticket.latest.state === 'passed' ? 'completed' : ticket.latest.state]
          .every(status => items.some(item => item.kind === 'job_work'
          && item.refs.ciTicketId === ticket.ticketId && item.status === status)))
      return agents && tickets
    })
    return (published && terminal && activityPublished) || Date.now() >= publicationDeadline
  }, Boolean, { deadline })
}
