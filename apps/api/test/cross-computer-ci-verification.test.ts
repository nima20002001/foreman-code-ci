import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { CiGetOutputSchema, CiListOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import * as verifier from './helpers/crossComputerCiVerification.js'

function fixture(): Parameters<typeof verifier.verifyScenario>[0] {
  return JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
}

it('replays a saved round offline with terminal-only samples and product-owned identifiers', () => {
  const recorded = fixture()
  recorded.tickets[0]!.latest.smokeComputer = recorded.tickets[0]!.latest.computer!.hostRef
  expect(() => verifier.verifyScenario(recorded)).not.toThrow()
})

it('requires tickets to execute on at least two computers', () => {
  const recorded = fixture()
  recorded.tickets[1]!.latest.computer = recorded.tickets[0]!.latest.computer
  expect(() => verifier.verifyScenario(recorded)).toThrow('At least two computers')
})

it('collects independent product failures in one diagnostic', () => {
  const recorded = fixture()
  recorded.runs[0]!.run.outcome = 'failed'
  recorded.reports['execution-1'] = { ...recorded.reports['execution-1'] as object, logLine: 'Invented log line' }
  recorded.tickets[1]!.latest.initiator.executionId = 'foreign-execution'
  expect(() => verifier.verifyScenario(recorded)).toThrow(/workflow.*outcome[\s\S]*logLine[\s\S]*executionId/i)
})

it.each(['scope', 'owner', 'order', 'reference'] as const)('rejects incorrect activity %s', change => {
  const recorded = fixture()
  const items = recorded.activities['run-1']!
  const job = items[1]!
  if (change === 'scope') job.scope.runId = 'run-2'
  if (change === 'owner') job.refs.executionId = 'execution-2'
  if (change === 'order') job.sequence = '4'
  if (change === 'reference') {
    job.refs.jobExecutionId = job.refs.ciTicketId!
    delete job.refs.ciTicketId
  }
  expect(() => verifier.verifyScenario(recorded)).toThrow()
})

it('checks each Agent succeeds once and has its own product worktree branch', () => {
  const recorded = fixture()
  recorded.runs[0]!.executions.push({ ...recorded.runs[0]!.executions[0]!, id: 'duplicate' })
  recorded.workflows[1]!.repository = recorded.workflows[0]!.repository
  recorded.runs[1]!.worktrees![0]!.branch = recorded.runs[0]!.worktrees![0]!.branch
  expect(() => verifier.verifyScenario(recorded)).toThrow(/succeeds once[\s\S]*own branch/)
})

it('accepts an idle configured cloud provider unless that workspace\'s tickets waited in the queue', () => {
  const recorded = fixture()
  const circleci = { ...recorded.tickets[0]!.latest.computer!.hostRef, provider: 'circleci' as const }
  recorded.workspaces[0]!.ciComputers.push(circleci)
  expect(() => verifier.verifyScenario(recorded)).not.toThrow()
  const ticket = recorded.tickets[0]!
  const queued = { ...ticket.timeline[0]!.run, state: 'queued' as const }
  ticket.timeline.unshift({ observedAt: '2026-01-01T00:00:00.000Z', run: queued },
    { observedAt: '2026-01-01T00:01:00.000Z', run: queued })
  expect(() => verifier.verifyScenario(recorded)).toThrow('Configured circleci CI executes work while tickets wait')
})

function joinedFixture() {
  const recorded = fixture()
  for (const ticket of recorded.tickets) {
    ticket.latest = CiRunRecordSchema.parse(ticket.latest)
    ticket.timeline = ticket.timeline.map(sample => ({ ...sample, run: CiRunRecordSchema.parse(sample.run) }))
  }
  for (const log of Object.values(recorded.groupLogs)) {
    for (const part of log.parts ?? []) part.run = CiRunRecordSchema.parse(part.run)
  }
  for (const [id, group] of Object.entries(recorded.groups)) recorded.groups[id] = CiGetOutputSchema.parse(group)
  const workflow = recorded.workflows[0]!
  const details = recorded.runs[0]!
  const original = details.executions[0]!
  const executionId = 'joined-execution'
  const agentId = 'joined-agent'
  const nodeId = 'joined-node'
  workflow.assignments.push({ ...workflow.assignments[0]!, agentId, nodeId })
  details.executions.push({ ...original, id: executionId, agentId, workflowNodeId: nodeId,
    workingDirectory: '/projects/joined' })
  details.worktrees!.push({ ...details.worktrees![0]!, executionId,
    workingDirectory: '/projects/joined', branch: 'agent/joined' })
  const page = recorded.executions[workflow.runId]![0]!
  page.items.push({ ...page.items[0]!, executionId, agentId, workflowNodeId: nodeId,
    worktree: { ...page.items[0]!.worktree!, branch: 'agent/joined' } } as typeof page.items[number])
  const placement = structuredClone(recorded.placements[original.id]!)
  placement.nodeId = nodeId
  if (placement.readback.evidence !== 'accepted') throw new Error('Expected accepted placement')
  placement.readback.placement.nodeId = nodeId
  recorded.placements[executionId] = placement
  recorded.reports[executionId] = recorded.reports[original.id]
  const groupId = recorded.tickets[0]!.latest.groupId
  const group = recorded.groups[groupId]!
  recorded.groups[groupId] = CiGetOutputSchema.parse({ ...group, sharing: { requesters: [
    { ...group.run.initiator, initiator: true, active: true },
    { principalId: 'joined-principal', executionId, initiator: false, active: true },
  ] } })
  const listed = recorded.ciLists[workflow.runId]!
  recorded.ciLists[workflow.runId] = CiListOutputSchema.parse({ ...listed, jobs: [...listed.jobs,
    { ...listed.jobs[0]!, requester: { executionId, agentId, nodeId, nodeName: 'Joined Agent' } },
  ] })
  const items = recorded.activities[workflow.runId]!
  const joined = items.map((item, index) => ({ ...item, id: `joined-activity-${index}`,
    sequence: String(items.length + index + 1),
    actor: { agentId, nodeId, agentName: 'Joined Agent', nodeName: 'Joined Agent' },
    refs: { ...item.refs, executionId } }))
  recorded.activities[workflow.runId] = RunActivitiesPageSchema.parse({
    scope: items[0]!.scope, items: [...items, ...joined], mode: 'initial',
    highWater: String(items.length + joined.length), retainedFrom: '1',
    nextCursor: 'cursor', olderCursor: null, hasMore: false,
  }).items
  return recorded
}

it('counts a shared group once per requester using ci_get, ci_list and activity responses', () => {
  expect(() => verifier.verifyScenario(joinedFixture())).not.toThrow()
})

it.each(['missing', 'extra'] as const)('rejects a %s joined request in the ci_get sharing readback', change => {
  const recorded = joinedFixture()
  const group = recorded.groups[recorded.tickets[0]!.latest.groupId]!
  if (change === 'missing') group.sharing!.requesters.pop()
  else group.sharing!.requesters.push({ principalId: 'extra-principal', executionId: 'extra-execution',
    initiator: false, active: true })
  expect(() => verifier.verifyScenario(recorded)).toThrow('No lost or duplicated CI requests')
})

function retryFixture(recorded = burstFixture()) {
  const initial = recorded.tickets[0]!
  const group = recorded.groups[initial.latest.groupId]!
  const retry = structuredClone(initial)
  const retryRun = { ...retry.latest, id: '22222222-2222-4222-8222-000000000003',
    groupId: '33333333-3333-4333-8333-000000000003', commit: 'c'.repeat(40),
    scope: 'affected' as const, files: recorded.workflows[0]!.assignments[0]!.task!.files, partition: null,
    queuedAt: '2026-10-15T00:01:00.000Z', startedAt: '2026-10-15T00:01:01.000Z',
    finishedAt: '2026-10-15T00:01:02.000Z' }
  retry.ticketId = retryRun.id
  retry.latest = retryRun
  retry.timeline = [{ observedAt: retryRun.finishedAt, run: structuredClone(retryRun) }]
  recorded.tickets.push(retry)
  recorded.groups[retryRun.groupId] = { run: structuredClone(retryRun),
    group: { groupId: retryRun.groupId, state: 'passed' } }
  recorded.groupLogs[retryRun.groupId] = { ...structuredClone(recorded.groupLogs[initial.latest.groupId]!),
    parts: [{ ...structuredClone(recorded.groupLogs[initial.latest.groupId]!.parts![0]!), run: retryRun }] }
  const listed = recorded.ciLists['run-1']!
  const job = structuredClone(listed.jobs[0]!)
  job.ticketId = retryRun.id
  job.scope = 'affected'
  job.ci = { ...job.ci, id: retryRun.id, groupId: retryRun.groupId, partition: null,
    queuedAt: retryRun.queuedAt, startedAt: retryRun.startedAt, finishedAt: retryRun.finishedAt }
  listed.jobs.push(job)
  const items = recorded.activities['run-1']!
  const queued = structuredClone(items.find(item => item.status === 'queued')!)
  const completed = structuredClone(items.find(item => item.kind === 'job_work' && item.status === 'completed')!)
  for (const item of items.filter(item => item.kind === 'job_work' && item.status === 'completed'
    && item.refs.ciTicketId === initial.ticketId)) item.status = 'failed'
  for (const [index, item] of [queued, completed].entries()) {
    item.id = `retry-activity-${index}`
    item.sequence = String(items.length + 1)
    item.refs.ciTicketId = retryRun.id
    item.status = index === 0 ? 'queued' : 'completed'
    items.push(item)
  }
  for (const run of [initial.latest, ...initial.timeline.map(sample => sample.run), group.run,
    recorded.groupLogs[initial.latest.groupId]!.parts![0]!.run]) {
    run.state = 'failed'
    run.exitCode = 1
  }
  group.group!.state = 'failed'
  listed.jobs[0]!.ci.state = 'failed'
  listed.jobs[0]!.ci.exitCode = 1
  initial.tests = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false,
    files: [{ file: retryRun.files[0]!, status: 'failed', durationMs: 1,
      tests: [{ name: 'collapses whitespace', status: 'failed', durationMs: 1 }] }] }
  recorded.workflows[0]!.assignments[0]!.task!.seedFailure = true
  return recorded
}

it('counts an initial failed request and a committed retry of only its failed file', () => {
  expect(() => verifier.verifyScenario(retryFixture())).not.toThrow()
})

it.each(['full', 'unrelated', 'missing', 'early', 'no-failure-results'] as const)(
  'rejects a retry with %s selection or readback', change => {
  const recorded = retryFixture()
  const retry = recorded.groups[recorded.tickets.at(-1)!.latest.groupId]!
  if (change === 'full') { retry.run.scope = 'full'; retry.run.files = [] }
  if (change === 'unrelated') retry.run.files = ['apps/api/test/unrelated.test.ts']
  if (change === 'missing') delete recorded.groups[retry.run.groupId]
  if (change === 'early') retry.run.queuedAt = '2026-10-14T00:00:00.000Z'
  if (change === 'no-failure-results') delete recorded.tickets[0]!.tests
  expect(() => verifier.verifyScenario(recorded)).toThrow()
})

it('rejects CI published from an unchanged Agent worktree', () => {
  const recorded = fixture()
  recorded.runs[0]!.worktrees![0]!.baseCommit = recorded.tickets[0]!.latest.commit
  expect(() => verifier.verifyScenario(recorded)).toThrow('committed change')
})

it('rejects an unrequested ticket omitted from its group', () => {
  const recorded = retryFixture()
  recorded.tickets.push({ ...structuredClone(recorded.tickets.at(-1)!), ticketId: 'orphan-ticket' })
  expect(() => verifier.verifyScenario(recorded)).toThrow('owns every group ticket')
})

function burstFixture() {
  const recorded = fixture()
  const workflow = recorded.workflows[0]!
  workflow.project = 'graphql'
  workflow.assignments[0]!.suite = 'integration'
  workflow.assignments[0]!.task!.scope = 'full'
  workflow.assignments[0]!.task!.files = ['apps/api/test/ci-example.integration.test.ts']
  const template = recorded.tickets.shift()!
  const group = recorded.groups[template.latest.groupId]!
  const log = recorded.groupLogs[template.latest.groupId]!
  const job = recorded.ciLists['run-1']!.jobs[0]!
  const items = recorded.activities['run-1']!
  const activity = items.filter(item => item.kind === 'job_work')
  recorded.activities['run-1'] = items.filter(item => item.kind === 'agent_work')
  const tickets = Array.from({ length: 100 }, (_, index) => {
    const ticket = structuredClone(template)
    const run = { ...ticket.latest, id: `burst-ticket-${index}`, suite: 'integration' as const,
      scope: 'full' as const, files: [], partition: { index, count: 100 } }
    ticket.ticketId = run.id
    ticket.latest = run
    ticket.timeline = [{ observedAt: run.finishedAt!, run: structuredClone(run) }]
    for (const [offset, item] of activity.entries()) {
      recorded.activities['run-1']!.push({ ...structuredClone(item), id: `burst-${index}-${offset}`,
        sequence: String(index * 2 + offset + 2), refs: { ...item.refs, ciTicketId: run.id } })
    }
    return ticket
  })
  recorded.tickets.unshift(...tickets)
  group.run = tickets[0]!.latest
  group.partitions = tickets.map(ticket => ticket.latest)
  log.parts = tickets.map(ticket => ({ ...structuredClone(log.parts![0]!), run: ticket.latest }))
  recorded.ciLists['run-1']!.jobs = tickets.map(ticket => ({ ...structuredClone(job),
    ticketId: ticket.ticketId, scope: 'full', ci: { ...job.ci, id: ticket.ticketId, suite: 'integration',
      partition: ticket.latest.partition } }))
  recorded.reports['execution-1'] = { ...recorded.reports['execution-1'] as object, suite: 'integration' }
  const affected = recorded.workflows[1]!
  affected.project = 'graphql'
  affected.assignments[0]!.suite = 'integration'
  const files = ['apps/api/test/ci-other.integration.test.ts']
  affected.assignments[0]!.task!.files = files
  const ticket = recorded.tickets.at(-1)!
  const ownGroup = recorded.groups[ticket.latest.groupId]!
  for (const run of [ticket.latest, ...ticket.timeline.map(sample => sample.run), ownGroup.run,
    recorded.groupLogs[ticket.latest.groupId]!.parts![0]!.run]) {
    run.suite = 'integration'
    run.files = files
  }
  recorded.ciLists['run-2']!.jobs[0]!.ci.suite = 'integration'
  recorded.reports['execution-2'] = { ...recorded.reports['execution-2'] as object, suite: 'integration' }
  return recorded
}

it('accepts one full hundred-part integration burst alongside affected work', () => {
  expect(() => verifier.verifyScenario(burstFixture())).not.toThrow()
})

it('reruns only the failed file after a hundred-part full integration request', () => {
  expect(() => verifier.verifyScenario(retryFixture(burstFixture()))).not.toThrow()
})

it('requires the full integration load request when graphql participates', () => {
  const recorded = fixture()
  recorded.workflows[0]!.project = 'graphql'
  expect(() => verifier.verifyScenario(recorded)).toThrow('one full integration request')
})

it('rejects a missing partition in the full integration burst', () => {
  const recorded = burstFixture()
  Object.values(recorded.groups)[0]!.partitions!.pop()
  expect(() => verifier.verifyScenario(recorded)).toThrow('partition')
})


function fullDemoFixture(recorded = fixture()) {
  for (const workflow of recorded.workflows.filter(value => value.project === 'demo')) {
    for (const assignment of workflow.assignments) {
      if (!assignment.task) continue
      assignment.task.scope = 'full'
      assignment.task.files = [`test/ci-scratch-label-${workflow.workflowId}.test.mjs`]
    }
    const runs = recorded.tickets.filter(ticket => ticket.workspaceId === workflow.workspaceId)
      .flatMap(ticket => [ticket.latest, ...ticket.timeline.map(sample => sample.run)])
    for (const group of Object.values(recorded.groups).filter(value => value.run.workspaceId === workflow.workspaceId)) {
      runs.push(group.run, ...group.partitions ?? [])
    }
    for (const log of Object.values(recorded.groupLogs)) {
      runs.push(...(log.parts ?? []).map(part => part.run).filter(run => run.workspaceId === workflow.workspaceId))
    }
    for (const run of runs) {
      run.scope = 'full'
      run.files = []
    }
    for (const job of recorded.ciLists[workflow.runId]!.jobs) job.scope = 'full'
  }
  return recorded
}

it('accepts demo full unit requests without counting them as full integration requests', () => {
  expect(() => verifier.verifyScenario(fullDemoFixture())).not.toThrow()
})

it('accepts a committed demo full unit retry after its seeded failure', () => {
  expect(() => verifier.verifyScenario(fullDemoFixture(retryFixture(fixture())))).not.toThrow()
})

it('still requires the graphql full integration burst alongside demo full unit requests', () => {
  const recorded = fullDemoFixture()
  recorded.workflows[0]!.project = 'graphql'
  expect(() => verifier.verifyScenario(recorded)).toThrow('one full integration request')
})
