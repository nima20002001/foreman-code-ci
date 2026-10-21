import { randomUUID } from 'node:crypto'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { skillConsumerFixture } from './helpers/skillConsumerFixture.js'

describe.skipIf(!postgresEnabled)('Skill consumer update plans over authenticated MCP: bulk', () => {
  const context = skillConsumerFixture()
  const { call, fixture, publish, seedConsumerFixtures, connect, configurationOf } = context

  it('lists all consumers in a supported workspace with more than 1000 Agents and workflows', async () => {
    const { access } = context
    const f = await fixture()
    await seedConsumerFixtures(f)
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const usage = await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId })
    expect(usage.agents).toHaveLength(1001)
    expect(usage.workflows).toHaveLength(1001)
    expect(new Set(usage.agents.map(agent => agent.agentId)).size).toBe(1001)
    expect(new Set(usage.workflows.map(workflow => workflow.workflowId)).size).toBe(1001)
    const reader = await access.issue({ name: 'Consumer reader', audience: 'operator',
      grants: [{ actions: ['skills:read'], scope: { workspaceIds: [f.workspaceId] } }],
      expiresAt: new Date(Date.now() + 600_000) })
    const denied = await (await connect(reader.token)).callTool({ name: 'skill_users_update', arguments: {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    } })
    expect(denied.isError).toBe(true)
    expect((await configurationOf(f.workspaceId, f.consumer.agent.id)).assignedSkills)
      .toEqual([{ skillId: f.skillId, version: '1' }])
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result.failed).toEqual([])
    expect(result.agents).toHaveLength(1001)
    expect(result.workflows).toHaveLength(1001)
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId }))
      .toMatchObject({ agents: [], workflows: [] })
    const last = result.workflows.at(-1)!
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: last.workflowId,
    })
    expect(read.version.id).toBe(last.workflowVersionId)
    expect(read.version.executionSemanticsVersion).toBe(3)
  }, 240_000)
})
