import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import {
  AGENT_INTERVAL_MAX_SECONDS, AGENT_INTERVAL_MIN_SECONDS, AGENT_INTERVAL_PROMPT_MAX_LENGTH, CURRENT_WORKFLOW_TOOLS, CurrentWorkflowCapabilitiesSchema,
  CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
} from '@foreman-code/contracts/wave25'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const fixtures: WriterFixture[] = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.app.close())) })
afterAll(async () => { await db?.close() })

it('refuses interval checks for an Agent that may ask for routed approval', async () => {
  const f = await writerFixture(db)
  fixtures.push(f)
  const watcher = f.input.graph.nodes[0]!
  if (watcher.kind === 'job') throw new Error('Expected an Agent node')
  watcher.interval = { everySeconds: 60 }
  const blocked = await f.call(CURRENT_WORKFLOW_TOOLS.save, f.input)
  expect(blocked.result?.isError).toBe(true)
  expect(JSON.stringify(graphRpcValue(blocked.result))).toContain('loops need an Agent that never asks for workflow approval')
  expect((await f.workflows.get(f.writer.principal, f.input.workspaceId, f.input.workflowId)).currentVersionId).toBeNull()
})

it('discovers, saves, clears and reads back Agent loops and their prompt through authenticated Operator MCP', async () => {
  const f = await writerFixture(db, 'sequential', { approvalPolicy: 'never' })
  fixtures.push(f)
  const scope = { workspaceId: f.input.workspaceId, workflowId: f.input.workflowId }
  const capabilities = CurrentWorkflowCapabilitiesSchema.parse(graphRpcValue(
    (await f.call(CURRENT_WORKFLOW_TOOLS.capabilities, {})).result))
  expect(capabilities.agentInterval).toMatchObject({ field: 'node.interval.everySeconds', defaultEnabled: false,
    promptField: 'node.interval.prompt', promptMaxLength: AGENT_INTERVAL_PROMPT_MAX_LENGTH,
    minimumSeconds: AGENT_INTERVAL_MIN_SECONDS, maximumSeconds: AGENT_INTERVAL_MAX_SECONDS,
    maximumChecksPerRun: null, runStatusTool: 'run_status_get' })
  const tools = JSON.stringify((await graphRpc(f.app, f.writer.token, 'tools/list')).result)
  expect(tools).toContain('node.interval')
  expect(tools).toContain('Loops do not consume maxParallelism slots and serialize with work on the same node.')
  expect(tools).toContain('node.interval.prompt')

  const watcher = f.input.graph.nodes[0]!
  if (watcher.kind === 'job') throw new Error('Expected an Agent node')
  watcher.interval = { everySeconds: 60, prompt: 'Check the deploy log for errors.' }
  const input = { ...f.input, commandId: randomUUID() }
  const reader = await f.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [scope.workspaceId] } }])
  const denied = await f.call(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)
  expect(denied.result?.isError).toBe(true)
  expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  expect((await f.workflows.get(f.writer.principal, scope.workspaceId, scope.workflowId)).currentVersionId).toBeNull()

  const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.save, input)).result)).value
  const read = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
    (await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope, reader.token)).result))
  expect(read.version).toEqual(saved.version)
  expect(read.version.definition.nodes[0]).toMatchObject({ id: watcher.id,
    interval: { everySeconds: 60, prompt: 'Check the deploy log for errors.' } })
  expect(read.version.definition.nodes[1]).not.toHaveProperty('interval')

  // Turning checks off is an ordinary executable save; the earlier version keeps its setting.
  const graph = structuredClone(saved.version.definition)
  const first = graph.nodes[0]!
  if (first.kind !== 'job') delete first.interval
  const cleared = CurrentWorkflowSaveResultSchema.parse(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.save, {
    ...input, commandId: randomUUID(), expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId, graph,
  })).result)).value
  const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope)).result))
  expect(persisted.version.id).toBe(cleared.version.id)
  expect(persisted.version.definition.nodes[0]).not.toHaveProperty('interval')
  const historical = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
    (await f.call(CURRENT_WORKFLOW_TOOLS.saved, { ...scope, workflowVersionId: saved.version.id })).result))
  expect(historical.version.definition.nodes[0]).toMatchObject({ interval: { everySeconds: 60, prompt: 'Check the deploy log for errors.' } })

  const tooFast = structuredClone(cleared.version.definition)
  const node = tooFast.nodes[0]!
  if (node.kind !== 'job') node.interval = { everySeconds: AGENT_INTERVAL_MIN_SECONDS - 1 }
  expect((await f.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID(), expectedRevision: cleared.revision,
    expectedWorkflowVersionId: cleared.currentVersionId, graph: tooFast })).result?.isError).toBe(true)

  // A check never publishes artifacts, so an Agent declaring artifact outputs cannot run checks.
  const withOutputs = structuredClone(cleared.version.definition)
  const producer = withOutputs.nodes[0]!
  if (producer.kind !== 'job') Object.assign(producer, { interval: { everySeconds: 60 }, artifactOutputs: { version: 1, outputKeys: ['report'] } })
  const refused = await f.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID(), expectedRevision: cleared.revision,
    expectedWorkflowVersionId: cleared.currentVersionId, graph: withOutputs })
  expect(refused.result?.isError).toBe(true)
  expect(JSON.stringify(refused.result)).toContain('AGENT_INTERVAL_WITH_ARTIFACT_OUTPUTS')
  expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope)).result))
    .version.id).toBe(cleared.version.id)
}, 60_000)
