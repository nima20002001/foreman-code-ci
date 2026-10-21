import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect } from 'vitest'
import { z } from 'zod'
import { ApiErrorSchema, withAdvancedDefaults, type Agent } from '@foreman-code/contracts'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { HarnessRegistryReadbackSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema, HostHarnessOverrideListSchema, type HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { CurrentEditReadResultSchema, CurrentWorkflowReadResultSchema, SavedManagedWorkflowCommandResultSchema,
  type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { buildCrossComputerCiGraph, ciHarness, createCiTasks, type ScenarioAgent } from './crossComputerCiGraph.js'
import type { ScenarioComputer, ScenarioWorkspace } from './crossComputerCiInput.js'
import { CiWaitTimeout, waitForCi } from './crossComputerCiWait.js'

type SavedCiWorkflow = z.infer<typeof CurrentWorkflowReadResultSchema>

type CiClient = Pick<Client, 'callTool'>
export type OwnedCiProfile = Pick<HarnessProfileSelection, 'instanceId' | 'target'>
export type CiToolOptions = { deadline?: number; timeoutMs?: number }
type CiConnection = {
  generation: number
  pending: Promise<void> | undefined
  reconnect: (signal: AbortSignal, timeout: number) => Promise<void>
}
const connections = new WeakMap<CiClient, CiConnection>()

async function boundedCiRequest<T>(label: string, deadline: number, timeoutMs: number,
  request: (signal: AbortSignal, timeout: number) => Promise<T>): Promise<T> {
  const timeout = Math.min(timeoutMs, deadline - Date.now())
  if (timeout <= 0) throw new CiWaitTimeout(`Timed out waiting for ${label}.`)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = Date.now() >= deadline ? new CiWaitTimeout(`Timed out waiting for ${label}.`)
        : new SdkError(SdkErrorCode.RequestTimeout, `${label} request timed out.`)
      reject(error)
      controller.abort(error)
    }, timeout)
  })
  try {
    return await Promise.race([request(controller.signal, timeout), expired])
  } finally {
    clearTimeout(timer)
  }
}

export async function connectCiOperator(endpoint: string, token: string): Promise<Client> {
  const client = new Client({ name: 'Cross-computer CI acceptance', version: '1' })
  const connect = (signal: AbortSignal, timeout: number) => client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }), { signal, timeout })
  try {
    await boundedCiRequest('MCP connection', Date.now() + 60_000, 60_000, connect)
  } catch (error) {
    await client.close()
    throw error
  }
  connections.set(client, { generation: 0, pending: undefined, reconnect: async (signal, timeout) => {
    await client.close()
    await connect(signal, timeout)
  } })
  return client
}

function transientCiTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof SdkHttpError) return error.status === 502 || error.status === 503
  const code = 'code' in error ? error.code : undefined
  if (['REQUEST_TIMEOUT', 'CONNECTION_CLOSED', 'NOT_CONNECTED',
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(code))) return true
  // Fetch and SDK send failures preserve the underlying socket error as their cause.
  return (error instanceof TypeError || code === 'SEND_FAILED') && transientCiTransportError(error.cause)
}

async function reconnectCiClient(connection: CiConnection, generation: number, deadline: number) {
  if (connection.generation !== generation) return
  connection.pending ??= boundedCiRequest('MCP reconnection', deadline, 60_000, connection.reconnect)
    .then(() => { connection.generation++ })
    .finally(() => { connection.pending = undefined })
  await boundedCiRequest('MCP reconnection', deadline, 60_000, async () => connection.pending)
}

export function toolErrorCode(result: Awaited<ReturnType<Client['callTool']>>): string | null {
  const content = result.content.find(item => item.type === 'text')
  if (content?.type !== 'text') return null
  let body: unknown
  try {
    body = JSON.parse(content.text)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  const parsed = z.object({ error: ApiErrorSchema }).safeParse(body)
  return parsed.success ? parsed.data.error.code : null
}

export async function callCiTool(client: CiClient, name: string, args: Record<string, unknown>,
  options: CiToolOptions = {}) {
  const result = await callCiToolResult(client, name, args, options)
  const code = result.isError ? toolErrorCode(result) : null
  const detail = result.isError ? JSON.stringify(result.structuredContent ?? result.content).slice(0, 2000) : ''
  expect(result.isError, `Public MCP operation ${name} failed${code ? ` (${code})` : ''}: ${detail}`).not.toBe(true)
  return decodeMcpToolResult(result)
}

export async function callCiToolResult(client: CiClient, name: string, args: Record<string, unknown>,
  options: CiToolOptions = {}) {
  const deadline = options.deadline ?? Date.now() + 5 * 60_000
  const read = name === 'workflow_node_placement_choices' || /_(get|list|read)(_v\d+)?$/.test(name)
  const replayable = read || (typeof args.commandId === 'string' && args.commandId.length > 0)
  const connection = connections.get(client)
  const result = await waitForCi(`MCP ${name}`, async () => {
    const generation = connection?.generation ?? 0
    try {
      return await boundedCiRequest(`MCP ${name}`, deadline, options.timeoutMs ?? 180_000, async (signal, timeout) => {
        await connection?.pending
        signal.throwIfAborted()
        return client.callTool({ name, arguments: args }, { signal, timeout })
      })
    } catch (error) {
      if (!replayable || !transientCiTransportError(error)) throw error
      if (connection) {
        try {
          await reconnectCiClient(connection, generation, deadline)
        } catch (reconnectError) {
          if (!transientCiTransportError(reconnectError)) throw reconnectError
        }
      }
      return null
    }
  }, value => {
    if (!value) return false
    const code = value.isError ? toolErrorCode(value) : null
    const retry = code === 'DEVICE_BUSY'
      || (code === 'ACTIVITY_SNAPSHOT_CONFLICT' && ['run_get', 'run_activities_get_v1'].includes(name))
      || (code === 'DATABASE_READ_TIMEOUT' && read)
      || code === 'COMMAND_DATABASE_TIMEOUT' || code === 'COMMAND_LOCK_TIMEOUT'
      || (code === 'HARNESS_PROFILE_CHECK_PENDING' && name === 'run_start')
      || (name === 'run_stop' && ['WORKFLOW_STOP_SETTLEMENT_PENDING', 'WORKFLOW_STOP_OWNER_UNCERTAIN'].includes(code ?? ''))
    return !(replayable && retry)
  }, { deadline })
  return result!
}

export async function expectCiDenied(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 30_000 })
  expect(result.isError, `${name} must reject the denied caller`).toBe(true)
  expect(toolErrorCode(result)).toBe('ACCESS_DENIED')
}

export async function qualifyCiProfile(client: Client, computer: ScenarioComputer,
  owned: Map<string, OwnedCiProfile>): Promise<HarnessProfileSelection> {
  const inventory = await waitForCi(`${computer.name} harness readiness`, async () =>
    HarnessRegistryReadbackSchema.parse(await callCiTool(client, 'harness_registry_get', { ...computer.hostRef })),
  value => Boolean(value.hostMetadata && value.installations.some(item => item.driverId === 'codex'
    && item.installed && item.installationFingerprint))
    && (!computer.registration || value.hostMetadata?.connection?.phase === 'ready'),
  { deadline: Date.now() + 5 * 60_000 })
  const metadata = inventory.hostMetadata!
  expect(metadata.hostRef).toEqual(computer.hostRef)
  if (computer.registration) expect(metadata.connection?.binding).toMatchObject(computer.registration)
  const installation = inventory.installations.find(value => value.driverId === 'codex' && value.installed
    && value.installationFingerprint)!
  const target = {
    hostRef: computer.hostRef,
    applicationInstallationId: metadata.applicationInstallationId,
    harnessInstallationId: installation.harnessInstallationId,
    installationFingerprint: installation.installationFingerprint!,
  }
  const instanceId = randomUUID()
  // Keep ownership even when the save commits but its response is lost.
  owned.set(instanceId, { instanceId, target })
  const profile = HostHarnessOverrideSaveResultSchema.parse(await callCiTool(client, 'harness_instance_save', {
    commandId: randomUUID(), instanceId, expectedRevision: 0,
    target, presetId: 'local-default:codex', enabled: true, configuration: ciHarness,
  })).value
  const checked = HostHarnessInstanceCheckResultSchema.parse(await callCiTool(client, 'harness_instance_check', {
    commandId: randomUUID(), instanceId: profile.instanceId, expectedRevision: profile.revision, target,
  }))
  expect(checked.proof.qualified, `${computer.name} Codex profile qualification`).toBe(true)
  expect(checked.value.configuration).toEqual(withAdvancedDefaults(ciHarness))
  const selection = { instanceId: checked.value.instanceId, instanceRevision: checked.value.instanceRevision, target }
  owned.set(instanceId, selection)
  return selection
}

/** Disables the invocation's profiles so later restarts do not recheck every scenario profile ever created. */
export async function disableCiProfiles(client: Client, profiles: Iterable<OwnedCiProfile>) {
  for (const profile of profiles) {
    const { target } = profile
    const listed = HostHarnessOverrideListSchema.parse(await callCiTool(client, 'harness_instances_list', {
      hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
    }))
    const saved = listed.overrides.find(value => value.instanceId === profile.instanceId)
    if (!saved?.enabled) continue
    await callCiTool(client, 'harness_instance_save', {
      commandId: randomUUID(), instanceId: saved.instanceId, expectedRevision: saved.revision,
      target: saved.target, presetId: saved.presetId, enabled: false, configuration: saved.configuration,
    })
  }
}

async function saveGraph(client: Client, input: {
  graph: WorkflowDefinitionV3
  revision: number
  versionId: string | null
  configurations: Record<string, string>
  agents?: Agent[]
}): Promise<SavedCiWorkflow> {
  const scope = { workspaceId: input.graph.workspaceId, workflowId: input.graph.id }
  const draftId = randomUUID()
  await callCiTool(client, 'workflow_edit_v3', {
    ...scope, action: 'stage_edits', commandId: randomUUID(), draftId, executionSemanticsVersion: 3,
    expectedRevision: input.revision, expectedWorkflowVersionId: input.versionId,
    expectedAgentConfigurationVersionIds: input.configurations,
    graph: input.graph,
    ...(input.agents ? { stagedAgents: input.agents.map(agent => ({ agent, baseRevision: null })) } : {}),
  })
  const staged = CurrentEditReadResultSchema.parse(await callCiTool(client, 'workflow_edits_get_v3', {
    ...scope, action: 'read_edits', draftId,
  })).intent
  if (!staged) throw new Error('The staged CI workflow was not persisted.')
  await callCiTool(client, 'workflow_edit_v3', {
    ...scope, action: 'stop_and_save', draftId, intentId: staged.id, commandId: staged.advanceCommandId,
  })
  return CurrentWorkflowReadResultSchema.parse(await callCiTool(client, 'workflow_saved_get_v3', scope))
}

export type PreparedCiWorkflow = {
  workspace: ScenarioWorkspace
  assignments: ScenarioAgent[]
  graph: WorkflowDefinitionV3
  saved: SavedCiWorkflow
  locationRevision: number
  repository: string
}

export async function prepareCiWorkflow(client: Client, workspace: ScenarioWorkspace,
  profiles: Map<string, HarnessProfileSelection>, round: number, index: number): Promise<PreparedCiWorkflow> {
  const managed = await waitForCi('workspace readiness', async () => ManagedWorkspaceSchema.parse(
    await callCiTool(client, 'workspace_get', { workspaceId: workspace.workspaceId })),
  value => value.locationValidation.status === 'ready', { deadline: Date.now() + 5 * 60_000 })
  const repository = managed.workspace.repository
  if (!repository) throw new Error(`${workspace.project} workspace needs its GitHub repository configured.`)
  const created = SavedManagedWorkflowCommandResultSchema.parse(await callCiTool(client, 'workflow_create', {
    workspaceId: workspace.workspaceId, commandId: randomUUID(),
    name: `Cross-computer CI ${workspace.project} round ${round} workflow ${index}`, executionSemanticsVersion: 3,
  })).value
  const tasks = [{ suite: null }, ...createCiTasks(workspace.project, index, created.workflow.id)]
  const assignments: ScenarioAgent[] = tasks.map((task, index) => {
    const computer = workspace.computers[Math.max(0, index - 1) % workspace.computers.length]!
    const profile = profiles.get(JSON.stringify(computer.hostRef))
    if (!profile) throw new Error(`Missing qualified profile for ${computer.name}.`)
    return { agentId: randomUUID(), nodeId: randomUUID(), profile, ...task,
      name: `${computer.name} ${task.suite ?? 'coordinator'}` }
  })
  const built = buildCrossComputerCiGraph(created.workflow, assignments)
  const first = await saveGraph(client, {
    graph: built.graph, agents: built.agents, revision: created.revision, versionId: null,
    configurations: {},
  })
  for (const assignment of assignments) {
    const selected = await waitForCi(`placement readiness for ${assignment.name}`, async () => {
      const choices = NodePlacementChoicesResultSchema.parse(await callCiTool(client, 'workflow_node_placement_choices', {
        workspaceId: workspace.workspaceId, workflowId: built.graph.id, nodeId: assignment.nodeId,
        agentConfigurationVersionId: first.version.agentConfigurationVersionIds[assignment.agentId],
      }))
      return choices.choices.find(choice => choice.availability === 'ready'
        && JSON.stringify(choice.placement.hostRef) === JSON.stringify(assignment.profile.target.hostRef)
        && choice.placement.instanceId === assignment.profile.instanceId)
    }, Boolean, { deadline: Date.now() + 5 * 60_000 })
    assignment.placement = selected!.placement
  }
  // The placement edit builds on the definition the first save published, with its version stamp.
  const { graph } = buildCrossComputerCiGraph(first.version.definition, assignments)
  const saved = await saveGraph(client, {
    graph, revision: first.revision, versionId: first.version.id,
    configurations: first.version.agentConfigurationVersionIds,
  })
  const savedPlacements = saved.version.definition.nodes.map(node => node.kind === 'job' ? null : node.placement)
  expect(savedPlacements).toEqual(assignments.map(assignment => assignment.placement))
  return { workspace, assignments, graph, saved, locationRevision: managed.locationRevision,
    repository: `${repository.owner}/${repository.name}` }
}
