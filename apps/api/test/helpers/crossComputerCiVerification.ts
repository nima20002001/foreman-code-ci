import { isDeepStrictEqual } from 'node:util'
import type { CiRunRecord } from '@foreman-code/contracts'
import { ciGroupRequestedBy, readAgentCiReport, requireCiStateOrder, type CiReadback } from './crossComputerCiReadback.js'
import type { RecordedScenario } from './crossComputerCiRecording.js'
import type { TicketObservation } from './crossComputerCiObservation.js'

type Check = (condition: unknown, message: string) => void


/** Tickets queued longer than this had to wait for capacity rather than for the next dispatch pass. */
const CI_QUEUE_WAIT_MS = 30_000

function queuedSpanMs(ticket: TicketObservation) {
  const queued = ticket.timeline.filter(sample => sample.run.state === 'queued').map(sample => Date.parse(sample.observedAt))
  return queued.length < 2 ? 0 : Math.max(...queued) - Math.min(...queued)
}
function sameTicket(left: CiRunRecord | undefined, right: CiRunRecord) {
  // ci_get adds smokeComputer to the requested ticket; partitions and log records omit that projection.
  return left && isDeepStrictEqual({ ...left, smokeComputer: undefined }, { ...right, smokeComputer: undefined })
}

function verifyPartitions(runs: CiRunRecord[], project: string, suite: string, check: Check) {
  if (project === 'demo' && runs.every(run => run.part === null)) {
    check(runs.length === 1 && runs[0]?.part === null && runs[0]?.partition === null,
      'repository-defined suite has one job')
    return
  }
  const full = runs[0]?.scope === 'full'
  check(runs.length >= 1, 'suite has all parts')
  if (suite === 'integration') {
    check(runs.every(run => run.part === null && (!full || run.partition)), 'integration has tier partitions')
    if (full) check(runs.length >= 100, 'full integration has a hundred-part burst')
  } else {
    check(runs.every(run => run.part?.startsWith(`${suite}-`)), 'parts belong to suite')
    if (suite === 'typecheck' || suite === 'lint') {
      const expected = full ? [`${suite}-api`, `${suite}-other`]
        : [...new Set(runs.flatMap(run => run.files).map(file =>
          `${suite}-${file.startsWith('apps/api/') ? 'api' : 'other'}`))].sort()
      check(isDeepStrictEqual([...new Set(runs.map(run => run.part))].sort(), expected),
        'suite includes every selected part')
    }
  }
  const keys = new Set(runs.map(run => suite === 'integration' ? run.partition?.tier : run.part))
  for (const key of keys) {
    const shards = runs.filter(run => (suite === 'integration' ? run.partition?.tier : run.part) === key)
    if (shards.some(run => run.partition)) {
      check(shards.every(run => run.partition?.count === shards.length), 'partition counts agree')
      check(isDeepStrictEqual(shards.map(run => run.partition?.index).sort((a, b) => a! - b!),
        Array.from({ length: shards.length }, (_, index) => index)), 'partition indexes are complete')
    } else check(shards.length === 1, 'part is not duplicated')
  }
}

function verifyTicket(ticket: TicketObservation, run: CiRunRecord, executionId: string, check: Check) {
  check(sameTicket(ticket.latest, run), `ticket ${run.id} agrees with group readback`)
  check(ticket.latest.initiator.executionId === executionId, `ticket ${run.id} has the right executionId`)
  check(ticket.initiatingExecutionId === executionId, `ticket ${run.id} observer executionId agrees`)
  check(ticket.timeline.every(sample => sample.run.initiator.executionId === executionId
    && sample.run.workspaceId === ticket.workspaceId && sample.run.id === run.id),
  `ticket ${run.id} retains its owner and executionId throughout its lifecycle`)
  check(run.state === 'passed' || run.state === 'failed', `ticket ${run.id} reached a test outcome`)
  check(run.state === 'passed' ? run.exitCode === 0 : typeof run.exitCode === 'number' && run.exitCode !== 0,
    `ticket ${run.id} exit code agrees with its outcome`)
  check(run.computer, `ticket ${run.id} ran on a computer`)
  check(run.startedAt && run.finishedAt && Date.parse(run.finishedAt) >= Date.parse(run.startedAt),
    `ticket ${run.id} has ordered start and finish times`)
  check(ticket.log && ticket.log.logBytes > 0, `ticket ${run.id} has its complete log`)
}

function requesters(group: CiReadback) {
  return [group.run.initiator.executionId,
    ...(group.sharing?.requesters.filter(requester => !requester.initiator).map(requester => requester.executionId) ?? [])]
}

function groupFailed(group: CiReadback) {
  return (group.partitions ?? [group.run]).some(run => run.state === 'failed')
}

function failedFiles(recorded: RecordedScenario, group: CiReadback, check: Check) {
  return [...new Set((group.partitions ?? [group.run]).filter(run => run.state === 'failed').flatMap(run => {
    const ticket = recorded.tickets.find(ticket => ticket.ticketId === run.id)
    const files = ['unit', 'integration'].includes(run.suite)
      ? ticket?.tests?.files.filter(file => file.status === 'failed').map(file => file.file) ?? []
      : run.files
    check(files.length, `ticket ${run.id} has failed files from ci_get`)
    return files
  }))].sort()
}

function verifyRequestChain(recorded: RecordedScenario, workflow: RecordedScenario['workflows'][number],
  assignment: RecordedScenario['workflows'][number]['assignments'][number],
  executionId: string, baseCommit: string | undefined, check: Check) {
  const groups = Object.values(recorded.groups).filter(group => ciGroupRequestedBy(group, executionId))
    .sort((left, right) => Date.parse(left.run.queuedAt) - Date.parse(right.run.queuedAt))
  const expected = assignment.suite ? 1 + groups.filter(groupFailed).length : 0
  check(groups.length === expected, `Agent ${assignment.agentId} has the right number of CI groups`)
  if (!assignment.suite) return
  check(assignment.task, `Agent ${assignment.agentId} has a designed file task`)
  if (!assignment.task) return
  const task = assignment.task
  if (task.seedFailure) check(groups.length >= 2 && groupFailed(groups[0]!), 'Seeded failure is fixed through CI')
  for (const [index, group] of groups.entries()) {
    const previous = groups[index - 1]
    let scope = task.scope
    if (previous) scope = workflow.project === 'demo' ? 'full' : 'affected'
    const files = previous && scope === 'affected' ? failedFiles(recorded, previous, check) : task.files
    const runs = group.partitions ?? [group.run]
    check(runs.every(run => run.workspaceId === workflow.workspaceId && run.repository === workflow.repository),
      `group ${group.run.groupId} belongs to its requesting workspace and repository`)
    check(runs.every(run => run.scope === scope && run.suite === assignment.suite), `group ${group.run.groupId} selection agrees`)
    const selected = [...new Set(runs.flatMap(run => run.files))].sort()
    check(isDeepStrictEqual(selected, scope === 'full' ? [] : [...files].sort()), `group ${group.run.groupId} selects only its designed or failed files`)
    check(baseCommit && group.run.commit !== baseCommit, `Agent ${assignment.agentId} has a committed change`)
    if (previous) {
      check(groupFailed(previous), `group ${group.run.groupId} follows a failed request`)
      check((previous.partitions ?? [previous.run]).every(run => run.finishedAt
        && Date.parse(run.finishedAt) <= Date.parse(group.run.queuedAt)), `group ${group.run.groupId} starts after its failed request settles`)
      if (task.seedFailure && index === 1) check(group.run.commit !== previous.run.commit, 'Seeded failure fix is committed')
    }
  }
  const final = groups.at(-1)
  check(final && !groupFailed(final) && final.group?.state === 'passed', `Agent ${assignment.agentId} final request passed`)
  return final
}

function verifyGroup(recorded: RecordedScenario, workflow: RecordedScenario['workflows'][number], group: CiReadback,
  agentId: string, executionId: string, check: Check, capture: (label: string, verify: () => void) => void) {
  const runs = group.partitions ?? [group.run]
  check(group.group?.state === (groupFailed(group) ? 'failed' : 'passed'), `group ${group.run.groupId} terminal state agrees`)
  check(runs.some(run => run.id === group.run.id), 'Group includes its requested ticket')
  check(new Set(runs.map(run => run.id)).size === runs.length, 'Group tickets are unique')
  const tickets = recorded.tickets.filter(ticket => ticket.latest.groupId === group.run.groupId)
  check(isDeepStrictEqual(tickets.map(ticket => ticket.ticketId).sort(), runs.map(run => run.id).sort()),
    `Agent ${agentId} owns every group ticket`)
  verifyPartitions(runs, workflow.project, group.run.suite, check)
  const logParts = recorded.groupLogs[group.run.groupId]?.parts ?? []
  check(isDeepStrictEqual(logParts.map(part => part.run.id).sort(), runs.map(run => run.id).sort()), 'Group logs include every ticket')
  for (const run of runs) {
    const ticket = recorded.tickets.find(value => value.ticketId === run.id)
    check(ticket, `ticket ${run.id} was collected`)
    check(run.workspaceId === workflow.workspaceId && run.repository === workflow.repository
      && run.suite === group.run.suite && run.groupId === group.run.groupId && run.scope === group.run.scope
      && run.commit === group.run.commit && isDeepStrictEqual(run.initiator, group.run.initiator), `ticket ${run.id} request facts agree`)
    if (!ticket) continue
    check(ticket.runId === workflow.runId && ticket.agentId === agentId, `ticket ${run.id} has its own run and owner`)
    verifyTicket(ticket, run, executionId, check)
    capture(`ticket ${run.id} sampled lifecycle`, () => requireCiStateOrder(ticket.timeline.map(sample => sample.run.state)))
    check(sameTicket(logParts.find(part => part.run.id === run.id)?.run, run), `ticket ${run.id} group log record agrees`)
  }
}

function verifyActivity(recorded: RecordedScenario, workflow: RecordedScenario['workflows'][number], check: Check) {
  const details = recorded.runs.find(value => value.run.id === workflow.runId)
  const executions = details?.executions ?? []
  const tickets = recorded.tickets.filter(ticket => ticket.runId === workflow.runId)
  const items = recorded.activities[workflow.runId] ?? []
  for (const page of recorded.activityPages[workflow.runId] ?? []) {
    check(page.scope.runId === workflow.runId && page.scope.workflowId === workflow.workflowId
      && page.scope.workflowVersionId === workflow.workflowVersionId && page.scope.workspaceId === workflow.workspaceId,
    'Activity page belongs to its own run')
  }
  for (const item of items) {
    check(item.scope.runId === workflow.runId && item.scope.workspaceId === workflow.workspaceId
      && item.scope.workflowId === workflow.workflowId && item.scope.workflowVersionId === workflow.workflowVersionId,
    `activity ${item.id} belongs to its own run`)
    if (item.refs.executionId) {
      check(executions.some(execution => execution.id === item.refs.executionId), `activity ${item.id} executionId belongs to run`)
    }
    if (item.refs.ciTicketId) {
      const ticket = tickets.find(value => value.ticketId === item.refs.ciTicketId)
      const shared = recorded.tickets.find(value => value.ticketId === item.refs.ciTicketId)
      const group = shared ? recorded.groups[shared.latest.groupId] : undefined
      const execution = executions.find(value => value.id === item.refs.executionId)
      const joined = group && execution && group.run.workspaceId === workflow.workspaceId
        && ciGroupRequestedBy(group, execution.id)
      check(ticket || joined, `activity ${item.id} ticket belongs to its own run`)
      check(item.refs.executionId === ticket?.initiatingExecutionId || joined,
        `activity ${item.id} has the right executionId`)
      check(item.actor && 'agentId' in item.actor && item.actor.agentId === execution?.agentId,
        `activity ${item.id} has the right owner`)
    }
  }
  for (const execution of executions) {
    if (execution.result?.outcome === 'succeeded') {
      check(items.some(item => item.kind === 'agent_work' && item.refs.executionId === execution.id
        && item.status === 'completed'), `Agent ${execution.id} has completed activity`)
    }
  }
  for (const ticket of tickets) {
    const events = items.filter(item => item.kind === 'job_work' && item.refs.ciTicketId === ticket.ticketId
      && item.refs.executionId === ticket.initiatingExecutionId)
      .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)
    const queued = events.findIndex(item => item.status === 'queued')
    const terminal = events.findIndex(item => ['completed', 'failed', 'canceled'].includes(item.status))
    check(queued >= 0 && terminal > queued, `ticket ${ticket.ticketId} activity has queued then terminal in order`)
    const expected = ticket.latest.state === 'passed' ? 'completed' : ticket.latest.state
    check(events.at(-1)?.status === expected, `ticket ${ticket.ticketId} terminal activity agrees with ticket`)
  }
}

/** Verifies only recorded public readbacks; replay never opens a client or reads a clock. */
export function verifyScenario(recorded: RecordedScenario): void {
  const failures: string[] = [...recorded.readErrors]
  const check: Check = (condition, message) => { if (!condition) failures.push(message) }
  const capture = (label: string, verify: () => void) => {
    try { verify() } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const branches: string[] = []
  const directories: string[] = []
  const groups = Object.values(recorded.groups)
  const assignments = recorded.workflows.flatMap(workflow => workflow.assignments)
  const expected = assignments.filter(agent => agent.suite).length
    + groups.filter(groupFailed).reduce((count, group) => count + requesters(group).length, 0)
  // Identical concurrent requests share one group; each joined request is listed in its sharing requesters.
  const requests = groups.reduce((count, group) => count + requesters(group).length, 0)
  check(requests === expected, 'No lost or duplicated CI requests')
  const suiteExecutions = recorded.runs.flatMap(details => details.executions)
    .filter(execution => assignments.some(agent => agent.agentId === execution.agentId && agent.suite))
  for (const group of groups) {
    const owners = requesters(group)
    check(new Set(owners).size === owners.length && owners.every(owner =>
      suiteExecutions.some(execution => execution.id === owner)), 'Every CI request has one assigned requester')
  }
  const graphql = recorded.workflows.filter(workflow => workflow.project === 'graphql')
  const full = groups.filter(group => group.run.scope === 'full' && group.run.suite === 'integration')
  check(full.reduce((count, group) => count + requesters(group).length, 0) === (graphql.length ? 1 : 0)
    && full.every(group => group.run.suite === 'integration'
    && graphql.some(workflow => workflow.workspaceId === group.run.workspaceId)), 'The round has one full integration request for graphql')
  for (const workflow of recorded.workflows) {
    const details = recorded.runs.find(value => value.run.id === workflow.runId)
    check(details?.run.outcome === 'succeeded', `workflow ${workflow.runId} outcome is succeeded`)
    check(details?.run.workflowId === workflow.workflowId
      && details.run.workflowVersionId === workflow.workflowVersionId, `workflow ${workflow.runId} saved version agrees`)
    check(details?.run.executionState === 'completed' && !details.cleanupPending, `workflow ${workflow.runId} completed cleanup`)
    const executions = details?.executions ?? []
    check(executions.every(execution => workflow.assignments.some(agent => agent.agentId === execution.agentId)),
      `workflow ${workflow.runId} has only its own Agents`)
    for (const execution of executions.filter(value => value.result?.outcome !== 'succeeded')) {
      check(execution.result?.error?.retryable, `execution ${execution.id} failed without a retry`)
    }
    const pages = recorded.executions[workflow.runId] ?? []
    check(pages.length && pages.at(-1)?.pageInfo.nextCursor === null, `workflow ${workflow.runId} execution readback is complete`)
    const listed = recorded.ciLists[workflow.runId]
    check(listed && !listed.truncated && listed.runId === workflow.runId, `workflow ${workflow.runId} CI list is complete`)
    for (const job of listed?.jobs ?? []) {
      const ticket = recorded.tickets.find(ticket => ticket.ticketId === job.ticketId)
      const group = ticket ? recorded.groups[ticket.latest.groupId] : undefined
      const joined = group && group.run.initiator.executionId !== job.requester.executionId
        && ciGroupRequestedBy(group, job.requester.executionId)
      check(joined ? executions.some(execution => execution.id === job.requester.executionId
        && execution.agentId === job.requester.agentId)
        : ticket?.runId === workflow.runId && ticket.agentId === job.requester.agentId
          && ticket.initiatingExecutionId === job.requester.executionId,
      `CI list ticket ${job.ticketId} has its own run, owner and executionId`)
    }
    for (const assignment of workflow.assignments) {
      const succeeded = executions.filter(value => value.agentId === assignment.agentId && value.result?.outcome === 'succeeded')
      check(succeeded.length === 1, `Agent ${assignment.agentId} succeeds once`)
      const execution = succeeded[0]
      if (!execution) continue
      check(execution.state === 'completed', `Agent ${assignment.agentId} completed`)
      const tree = details?.worktrees?.find(value => value.executionId === execution.id)
      const worktree = pages.flatMap(page => page.items).find(value => value.executionId === execution.id)?.worktree
      check(worktree?.repository === workflow.repository && worktree.branch, `Agent ${assignment.agentId} worktree repository and branch`)
      check(tree?.branch && tree.branch === worktree?.branch, `Agent ${assignment.agentId} branch readbacks agree`)
      check(execution.workingDirectory && tree?.workingDirectory === execution.workingDirectory,
        `Agent ${assignment.agentId} worktree directory agrees`)
      if (tree?.branch) branches.push(`${workflow.repository}:${tree.branch}`)
      if (execution.workingDirectory) directories.push(`${JSON.stringify(assignment.hostRef)}:${execution.workingDirectory}`)
      const placement = recorded.placements[execution.id]
      check(placement?.runId === workflow.runId && placement.workflowId === workflow.workflowId
        && placement.nodeId === assignment.nodeId, `Agent ${assignment.agentId} placement belongs to run and node`)
      check(placement?.readback.evidence === 'accepted'
        && isDeepStrictEqual(placement.readback.placement.hostRef, assignment.hostRef), `Agent ${assignment.agentId} placement accepted on chosen computer`)
      const final = verifyRequestChain(recorded, workflow, assignment, execution.id, tree?.baseCommit, check)
      if (!assignment.suite) continue
      let report: ReturnType<typeof readAgentCiReport> | undefined
      capture(`Agent ${assignment.agentId} report`, () => { report = readAgentCiReport(recorded.reports[execution.id]) })
      if (report) {
        check(report.suite === assignment.suite, `Agent ${assignment.agentId} report suite agrees`)
        check(report.repository === worktree?.repository, `Agent ${assignment.agentId} report repository agrees`)
        check(report.outcome === 'passed', `Agent ${assignment.agentId} reports passed`)
        capture(`Agent ${assignment.agentId} observed states`, () => requireCiStateOrder(report!.observedStates))
        check(report.observedStates.at(-1) === 'passed', `Agent ${assignment.agentId} observed terminal state agrees`)
      }
      const own = groups.filter(group => group.run.initiator.executionId === execution.id)
      const tickets = recorded.tickets.filter(ticket => ticket.initiatingExecutionId === execution.id)
      check(isDeepStrictEqual(tickets.map(ticket => ticket.ticketId).sort(),
        own.flatMap(group => (group.partitions ?? [group.run]).map(run => run.id)).sort()),
      `Agent ${assignment.agentId} owns every group ticket`)
      for (const group of own) verifyGroup(recorded, workflow, group, assignment.agentId, execution.id, check, capture)
      if (report && final) {
        const finalTickets = recorded.tickets.filter(ticket => ticket.latest.groupId === final.run.groupId)
        check(finalTickets.some(ticket => ticket.log?.text.split('\n').some(line => line.trim() === report!.logLine)),
          `Agent ${assignment.agentId} logLine appears in its final ticket log`)
      }
    }
    capture(`workflow ${workflow.runId} activity`, () => verifyActivity(recorded, workflow, check))
  }
  check(new Set(branches).size === branches.length, 'Every Agent has its own branch')
  check(new Set(directories).size === directories.length, 'Every Agent has its own worktree')
  const computers = new Set(recorded.tickets.filter(ticket => ticket.latest.computer)
    .map(ticket => JSON.stringify(ticket.latest.computer!.hostRef)))
  check(computers.size >= 2, 'At least two computers execute tickets')
  for (const workspace of recorded.workspaces) {
    // Dispatch prefers faster executors; an idle provider is a defect only while this workspace's tickets wait.
    const waited = recorded.tickets.some(ticket => ticket.workspaceId === workspace.workspaceId
      && queuedSpanMs(ticket) > CI_QUEUE_WAIT_MS)
    if (!waited) continue
    for (const host of workspace.ciComputers.filter(host => host.kind === 'cloud')) {
      check(recorded.tickets.some(ticket => ticket.workspaceId === workspace.workspaceId
        && ticket.latest.computer?.hostRef.provider === host.provider),
      `Configured ${host.provider} CI executes work while tickets wait`)
    }
  }
  for (const read of recorded.isolation) {
    check(read.isError && !['run', 'partitions', 'text', 'parts'].some(field =>
      read.body && typeof read.body === 'object' && field in read.body), `${read.tool} preserves workspace isolation`)
  }
  for (const excluded of recorded.exclusions) {
    check(!excluded.ready && excluded.reasons.length, 'Excluded computer is unavailable with a reason')
    check(!recorded.tickets.some(ticket => ticket.timeline.some(sample =>
      isDeepStrictEqual(sample.run.computer?.hostRef, excluded.hostRef))), 'Unavailable computers never execute tickets')
  }
  if (failures.length) throw new Error(`Scenario verification failed (${failures.length}):\n${failures.map(message => `- ${message}`).join('\n')}`)
}
