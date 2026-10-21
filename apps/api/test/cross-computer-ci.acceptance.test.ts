import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { ManualRunStartResultSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { readCrossComputerCiInput, type CrossComputerCiInput } from './helpers/crossComputerCiInput.js'
import { listCiToolNames } from './helpers/crossComputerCiTools.js'
import { callCiTool, connectCiOperator, disableCiProfiles, expectCiDenied, prepareCiWorkflow, qualifyCiProfile,
  type OwnedCiProfile, type PreparedCiWorkflow } from './helpers/crossComputerCiSetup.js'
import { createScenarioObservation, pollCiScenario, type RunningCiWorkflow,
  type ScenarioObservation } from './helpers/crossComputerCiObservation.js'
import { ciGroupRequestedBy, ciTerminal } from './helpers/crossComputerCiReadback.js'
import { verifyScenario } from './helpers/crossComputerCiVerification.js'
import { collectCiReadback, recordScenario, type RecordedScenario } from './helpers/crossComputerCiRecording.js'
import { waitForCi } from './helpers/crossComputerCiWait.js'

function startInput(workflow: PreparedCiWorkflow) {
  return {
    workspaceId: workflow.workspace.workspaceId, workflowId: workflow.graph.id,
    workflowVersionId: workflow.saved.version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedWorkflowRevision: workflow.saved.revision,
    expectedAgentConfigurationVersionIds: workflow.saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: workflow.locationRevision, input: {},
  }
}

async function verifyPrerequisites(client: Client, input: CrossComputerCiInput) {
  expect(await listCiToolNames(client)).toEqual(expect.arrayContaining([
    'ci_run', 'ci_get', 'ci_list', 'ci_computers_list', 'ci_logs_read', 'ci_cancel',
    'workspace_get', 'workflow_create', 'workflow_edit_v3', 'workflow_edits_get_v3', 'workflow_saved_get_v3',
    'run_start', 'run_stop', 'run_get', 'run_executions_list', 'run_events_list', 'run_activities_get_v1',
    'run_node_placement_get', 'workflow_node_placement_choices',
    'harness_registry_get', 'harness_instance_save', 'harness_instance_check', 'harness_instances_list',
  ]))
  for (const workspace of input.workspaces) {
    await waitForCi('configured CI computer readiness', async () => {
      const listed = CiComputersOutputSchema.parse(await callCiTool(client, 'ci_computers_list', {
        workspaceId: workspace.workspaceId,
      }))
      return workspace.ciComputers.map(host =>
        listed.computers.find(value => JSON.stringify(value.hostRef) === JSON.stringify(host)))
    }, computers => computers.every(Boolean) && computers.some(computer => computer?.ready),
    { deadline: Date.now() + 5 * 60_000 })
  }
}

async function prepareProfiles(client: Client, input: CrossComputerCiInput, owned: Map<string, OwnedCiProfile>) {
  const profiles = new Map<string, HarnessProfileSelection>()
  for (const workspace of input.workspaces) {
    for (const computer of workspace.computers) {
      const key = JSON.stringify(computer.hostRef)
      if (!profiles.has(key)) profiles.set(key, await qualifyCiProfile(client, computer, owned))
    }
  }
  return profiles
}

async function startWorkflows(client: Client, denied: Client, prepared: PreparedCiWorkflow[], running: RunningCiWorkflow[]) {
  const requests = prepared.map(workflow => ({ workflow, request: startInput(workflow) }))
  for (const { request, workflow } of requests) {
    await expectCiDenied(denied, 'run_start', request)
    await expectCiDenied(denied, 'ci_run', {
      workspaceId: workflow.workspace.workspaceId, suite: 'build', commandId: randomUUID(),
    })
  }
  const results = await Promise.allSettled(requests.map(async ({ workflow, request }) => {
    const result = ManualRunStartResultSchema.parse(await callCiTool(client, 'run_start', request))
    running.push({ ...workflow, runId: result.run.id })
  }))
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  expect(new Set(running.map(workflow => workflow.runId)).size).toBe(prepared.length)
}

async function cleanupFailedRound(client: Client, workflows: RunningCiWorkflow[], observation: ScenarioObservation) {
  const errors: string[] = []
  await Promise.all(workflows.map(async workflow => {
    try {
      const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
      await callCiTool(client, 'run_stop', { ...scope, commandId: randomUUID() })
      const details = await waitForCi(`Run ${workflow.runId} cleanup`, async () =>
        SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' })),
      value => value.run.executionState === 'completed' && !value.cleanupPending,
      { deadline: Date.now() + 120_000 })
      const unknown = details.executions.filter(execution =>
        workflow.assignments.some(agent => agent.agentId === execution.agentId && agent.suite)
        && !([...observation.groups.values()].some(group => ciGroupRequestedBy(group, execution.id))))
      if (unknown.length) {
        errors.push(`Run ${workflow.runId} has ${unknown.length} CI Agents without discoverable ticket groups; inspect production.`)
      }
    } catch (error) {
      errors.push(`Run ${workflow.runId} Stop or cleanup read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))
  for (const ticket of observation.tickets.values()) {
    try {
      const scope = { workspaceId: ticket.workspaceId, ticketId: ticket.ticketId }
      let readback = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', scope))
      if (!ciTerminal(readback.run.state)) await callCiTool(client, 'ci_cancel', { ...scope, commandId: randomUUID() })
      readback = await waitForCi(`ticket ${ticket.ticketId} cancellation`, async () =>
        CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', scope)),
      value => ciTerminal(value.run.state), { deadline: Date.now() + 120_000 })
      ticket.latest = readback.run
    } catch {
      errors.push(`CI ticket ${ticket.ticketId} cancellation or read failed.`)
    }
  }
  return errors
}

it('runs concurrent projects through Agent Host CI with isolated readback twice in a row', async () => {
  const input = await readCrossComputerCiInput()
  await mkdir(input.evidenceDirectory, { recursive: true, mode: 0o700 })
  const invocationId = randomUUID()
  const clients: Client[] = []
  let profiles = new Map<string, HarnessProfileSelection>()
  const ownedProfiles = new Map<string, OwnedCiProfile>()
  const redact = (text: string) => text.replaceAll(input.token, '[redacted]').replaceAll(input.deniedToken, '[redacted]')
  try {
    const writer = await connectCiOperator(input.endpoint, input.token)
    clients.push(writer)
    const denied = await connectCiOperator(input.endpoint, input.deniedToken)
    clients.push(denied)
    // Fast iteration runs one round per deploy; the final confirmation runs both (FOREMAN_CODE_CROSS_COMPUTER_CI_ROUNDS=2).
    const rounds = process.env.FOREMAN_CODE_CROSS_COMPUTER_CI_ROUNDS === '1' ? [1] : [1, 2]
    for (const round of rounds) {
      const workflows: RunningCiWorkflow[] = []
      const observation = createScenarioObservation()
      const evidence = { invocationId, round, startedAt: new Date().toISOString(), finishedAt: null as string | null,
        status: 'running' as 'running' | 'passed' | 'failed', failure: null as string | null, cleanupErrors: [] as string[] }
      let recorded: RecordedScenario | undefined
      const persist = async () => {
        await writeFile(join(input.evidenceDirectory, `cross-computer-ci-${invocationId}-round-${round}.json`),
          redact(JSON.stringify({ ...evidence,
            ...(recorded ?? recordScenario(workflows, observation, input)),
          }, null, 2)), { mode: 0o600 })
      }
      await persist()
      let collected = false
      try {
        if (round === 1) {
          await verifyPrerequisites(writer, input)
          profiles = await prepareProfiles(writer, input, ownedProfiles)
        }
        const prepared: PreparedCiWorkflow[] = []
        for (const workspace of input.workspaces) {
          for (const index of [1, 2]) prepared.push(await prepareCiWorkflow(writer, workspace, profiles, round, index))
        }
        const agents = prepared.flatMap(workflow => workflow.assignments).filter(agent => agent.suite)
        expect(agents).toHaveLength(12)
        expect(agents.filter(agent => agent.suite === 'integration' && agent.task?.scope === 'full')).toHaveLength(1)
        expect(agents.filter(agent => agent.task?.seedFailure)).toHaveLength(1)
        expect(new Set(prepared.map(workflow => workflow.repository)).size, 'The projects use distinct repositories')
          .toBe(input.workspaces.length)
        await startWorkflows(writer, denied, prepared, workflows)
        await persist()
        await pollCiScenario(writer, workflows, observation, persist)
        await collectCiReadback(writer, workflows, observation, input)
        collected = true
        recorded = structuredClone(recordScenario(workflows, observation, input))
        await persist()
        verifyScenario(recorded)
        evidence.status = 'passed'
      } catch (error) {
        evidence.cleanupErrors = await cleanupFailedRound(writer, workflows, observation)
        if (!collected) await collectCiReadback(writer, workflows, observation, input)
        recorded ??= structuredClone(recordScenario(workflows, observation, input))
        evidence.status = 'failed'
        evidence.failure = redact(error instanceof Error ? error.message : 'Scenario failed.')
        await persist()
        throw new Error(`Cross-computer CI round ${round} failed; inspect its private evidence JSON.`,
          { cause: error })
      } finally {
        evidence.finishedAt = new Date().toISOString()
        await persist()
      }
    }
  } finally {
    if (clients[0] && ownedProfiles.size) await disableCiProfiles(clients[0], ownedProfiles.values())
    const closed = await Promise.allSettled(clients.map(client => client.close()))
    expect(closed.every(result => result.status === 'fulfilled'), 'Close every scenario MCP client').toBe(true)
  }
}, 9 * 60 * 60_000)
