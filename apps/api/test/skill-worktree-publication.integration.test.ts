import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import * as c from '@foreman-code/contracts/management'
import type { z } from 'zod'
import { buildApp } from '../src/app.js'
import { createOperatorExtensions } from '../src/mcp/operator/extensions.js'
import { setup } from './helpers/workflowWorktreeMcp.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

for (const [source, worktree] of [
  ['http', true],
  ['mcp', true],
  ['http', false],
  ['mcp', false],
] as const) {
  const workflowKind = worktree ? 'worktree' : 'ordinary'
  it.skipIf(!postgresEnabled)(`republishes ${workflowKind} workflows after a bulk skill update over ${source}`, async () => {
    const f = await setup()
    const input = { pool: f.base.db.pool, commands: f.base.commands, catalog: f.base.services.harnesses,
      locations: f.base.locations, workflows: f.base.services.workflows.current,
      native: {} as Parameters<typeof createOperatorExtensions>[0]['native'],
      detection: {} as Parameters<typeof createOperatorExtensions>[0]['detection'] }
    const services = { ...f.base.services, extensions: createOperatorExtensions(input) }
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access: f.base.access, services } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'skill-worktree', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
        return client
      }
      const client = await connect(f.base.writer.token)
      const call = async <T>(name: string, schema: z.ZodType<T>, arguments_: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: arguments_ })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        return schema.parse(decodeMcpToolResult(result))
      }
      const workspaceId = f.workspaceId
      const skill = (await call('skill_create', c.SkillMutationResultSchema, { workspaceId,
        commandId: randomUUID(), name: 'Worktree skill', instructions: 'Original' })).value
      const previousAgentId = Object.keys(f.base.f.version.agentConfigurationVersionIds)[0]!
      const agentId = 'skill-consumer'
      const assigned = await call('agent_create', c.AgentMutationResultSchema, { workspaceId, agentId,
        commandId: randomUUID(), name: 'Skill consumer', productRole: 'coder',
        configuration: f.base.f.configurations.find(value => value.agentId === previousAgentId)!.harness,
        assignedSkills: [{ skillId: skill.skill.skillId, version: skill.version.version }] })
      const { saveInput } = await f.create(worktree ? undefined : null)
      saveInput.graph.nodes = saveInput.graph.nodes.map(node => node.kind !== 'job' && node.agentId === previousAgentId
        ? { ...node, agentId } : node)
      delete saveInput.expectedAgentConfigurationVersionIds[previousAgentId]
      saveInput.expectedAgentConfigurationVersionIds[agentId] = assigned.value.agent.configurationVersionId!
      const original = await f.save(saveInput)
      await call('skill_update', c.SkillMutationResultSchema, { workspaceId, skillId: skill.skill.skillId,
        commandId: randomUUID(), expectedRevision: skill.skill.revision, name: 'Worktree skill', instructions: 'Replacement' })
      const update = { workspaceId, skillId: skill.skill.skillId, commandId: randomUUID() }
      const reader = await connect((await f.base.access.issue({ name: 'Skill reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['skills:read'], scope: { workspaceIds: [workspaceId] } }] })).token)
      expect((await reader.callTool({ name: 'skill_users_update', arguments: update })).isError).toBe(true)
      expect((await f.read(saveInput.workflowId)).version).toEqual(original.value.version)
      expect((await f.base.services.agents.get(f.base.writer.principal, workspaceId, agentId)).agent.assignedSkills)
        .toEqual([{ skillId: skill.skill.skillId, version: '1' }])
      const updateUsers = async () => {
        if (source === 'mcp') return call('skill_users_update', c.SkillUsersUpdateResultSchema, update)
        const response = await app.inject({ method: 'POST',
          url: `/api/management/workspaces/${workspaceId}/skills/${skill.skill.skillId}/update-users`,
          headers: { authorization: `Bearer ${f.base.writer.token}` }, payload: { commandId: update.commandId } })
        expect(response.statusCode).toBe(200)
        return c.SkillUsersUpdateResultSchema.parse(response.json())
      }
      const result = await updateUsers()
      expect(result.failed).toEqual([])
      expect(result.workflows).toContainEqual({ workflowId: saveInput.workflowId,
        workflowVersionId: expect.any(String) })
      const readback = await f.read(saveInput.workflowId)
      expect(readback.version.id).not.toBe(original.value.currentVersionId)
      expect(readback.version.definition.defaultWorktree).toEqual(original.value.version.definition.defaultWorktree)
      expect(readback.version.agentConfigurationVersionIds[agentId]).toBe(result.agents[0]!.configurationVersionId)
      expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId, skillId: skill.skill.skillId }))
        .toMatchObject({ headVersion: '2', agents: [], workflows: [] })
      expect(await updateUsers()).toEqual(result)
      expect((await f.base.db.pool.query<{ record: unknown }>('select record from runs where id=$1', [f.base.f.run.id])).rows[0]!.record)
        .toMatchObject({ agentConfigurationVersionIds: f.base.f.run.agentConfigurationVersionIds })
      const historical = await f.base.services.workflows.current.read(f.base.writer.principal, {
        workspaceId, workflowId: saveInput.workflowId, workflowVersionId: original.value.currentVersionId })
      expect(historical.version).toEqual(original.value.version)
      expect((await f.base.services.agents.get(f.base.writer.principal, workspaceId, agentId)).agent.assignedSkills)
        .toEqual([{ skillId: skill.skill.skillId, version: '2' }])
    } finally {
      await Promise.all(clients.map(client => client.close()))
      await app.close()
      await f.close()
    }
  }, 30_000)
}
