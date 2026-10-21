import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
} from '@foreman-code/contracts/wave25'
import type { ResolvedSkill } from '@foreman-code/contracts'
import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { composeInstructionText } from '../src/modules/skills/instructions.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const fixtures: WriterFixture[] = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.app.close())) })
afterAll(async () => { await db?.close() })

const outputSchema = {
  type: 'object',
  required: ['status', 'summary', 'ticket'],
  properties: {
    status: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' },
  },
}

it('discovers, saves, rejects and reads back Agent output schemas and node skill overrides through authenticated Operator MCP', async () => {
  const f = await writerFixture(db, 'sequential', { approvalPolicy: 'never' })
  fixtures.push(f)
  const scope = { workspaceId: f.input.workspaceId, workflowId: f.input.workflowId }
  const capabilities = CurrentWorkflowCapabilitiesSchema.parse(graphRpcValue(
    (await f.call(CURRENT_WORKFLOW_TOOLS.capabilities, {})).result))
  expect(capabilities.agentOutputSchema).toMatchObject({ field: 'node.outputSchema', referenceKeyword: 'x-foreman-reference',
    referenceKinds: ['ciTicket'], repairTurns: 2, failureCodes: ['OUTPUT_SCHEMA_MISMATCH', 'OUTPUT_REFERENCE_UNKNOWN'] })
  expect(capabilities.agentSkills).toMatchObject({ field: 'node.skills' })

  const skills = new SkillCatalogService(db.pool, new PostgresCommandCoordinator(db.pool))
  const created = await skills.create(f.writer.principal, { workspaceId: scope.workspaceId, commandId: randomUUID(),
    name: 'Release notes', instructions: 'Write release notes for every change.' }, 'mcp')
  const skill = { skillId: created.value.skill.skillId, version: created.value.version.version }

  const graph = structuredClone(f.input.graph)
  const node = graph.nodes[0]!
  if (node.kind === 'job') throw new Error('Expected an Agent node')
  node.outputSchema = outputSchema
  node.skills = { add: [skill] }
  const input = { ...f.input, graph, commandId: randomUUID() }

  const reader = await f.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [scope.workspaceId] } }])
  const denied = await f.call(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)
  expect(denied.result?.isError).toBe(true)
  expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  expect((await f.workflows.get(f.writer.principal, scope.workspaceId, scope.workflowId)).currentVersionId).toBeNull()

  const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.save, input)).result)).value
  const read = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
    (await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope, reader.token)).result))
  expect(read.version).toEqual(saved.version)
  expect(read.version.definition.nodes[0]).toMatchObject({ id: node.id, outputSchema, skills: { add: [skill] } })
  expect(read.version.definition.nodes[1]).not.toHaveProperty('outputSchema')

  // Each execution of the node receives the added skill's pinned instructions; the Agent configuration is unchanged.
  const pinned = f.configurations.find(config => config.agentId === node.agentId)!
  const repository = new PostgresWorkflowRepository(db.pool)
  const version = await repository.getSavedVersion(saved.version.id)
  const snapshots = (version as typeof version & { nodeSkillSnapshots?: Record<string, ResolvedSkill[]> })
    ?.nodeSkillSnapshots?.[node.id]
  expect(snapshots).toMatchObject([{ skillId: skill.skillId, version: skill.version }])
  const executionConfiguration = await repository.resolveNodeSkills(pinned, { add: [skill] }, snapshots)
  expect(composeInstructionText(executionConfiguration)).toContain('Write release notes for every change.')
  expect(pinned.assignedSkills).toEqual([])

  const refused = async (change: (agentNode: Exclude<typeof node, { kind: 'job' }>) => void) => {
    const next = structuredClone(saved.version.definition)
    const agentNode = next.nodes[0]!
    if (agentNode.kind === 'job') throw new Error('Expected an Agent node')
    change(agentNode)
    const reply = await f.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID(), expectedRevision: saved.revision,
      expectedWorkflowVersionId: saved.currentVersionId, graph: next })
    expect(reply.result?.isError).toBe(true)
    // Schema violations are refused by MCP input validation as plain text; domain refusals are structured JSON.
    const { structuredContent, content } = reply.result!
    return structuredContent !== undefined ? JSON.stringify(structuredContent)
      : content?.find(item => item.type === 'text')?.text ?? ''
  }
  // Invalid schemas, unassigned removals and unknown skill versions are refused before anything is saved.
  await refused(agentNode => { agentNode.outputSchema = { type: 'object', properties: { ticket: { type: 'number', 'x-foreman-reference': 'ciTicket' } } } })
  await refused(agentNode => { agentNode.outputSchema = { $ref: 'https://example.com/contract.json' } })
  expect(await refused(agentNode => { agentNode.skills = { remove: ['skill-the-agent-does-not-assign'] } }))
    .toContain('skill-the-agent-does-not-assign')
  expect(await refused(agentNode => { agentNode.skills = { add: [{ skillId: skill.skillId, version: '999' }] } }))
    .toContain('SKILL_VERSION_NOT_FOUND')

  const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope)).result))
  expect(persisted.version.id).toBe(saved.version.id)
  expect(persisted.version.definition.nodes[0]).toMatchObject({ outputSchema, skills: { add: [skill] } })
})
