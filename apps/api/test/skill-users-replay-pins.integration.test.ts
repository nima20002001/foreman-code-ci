import { randomUUID } from 'node:crypto'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { skillConsumerFixture } from './helpers/skillConsumerFixture.js'

describe.skipIf(!postgresEnabled)('Skill consumer update plans over authenticated MCP: pins', () => {
  const context = skillConsumerFixture()
  const { call, fixture, makeAgent, makeWorkflow, publish } = context

  it('leaves unrelated stale workflows and immutable history unchanged', async () => {
    const f = await fixture()
    const unrelated = await makeAgent(f.workspaceId)
    const untouched = await makeWorkflow(f.workspaceId, [unrelated.agent], 'Unrelated')
    await call('agent_update', c.AgentMutationResultSchema, {
      workspaceId: f.workspaceId, agentId: unrelated.agent.id, commandId: randomUUID(),
      expectedRevision: unrelated.metadataRevision, expectedConfigurationVersionId: unrelated.agent.configurationVersionId,
      prompt: { system: 'Unrelated edit' },
    })
    const before = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: untouched.workflowId,
    })
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const usage = await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId })
    expect(usage.workflows.map(workflow => workflow.workflowId)).toEqual([f.workflow.workflowId])
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result.failed).toEqual([])
    expect(result.agents.map(agent => agent.agentId)).toEqual([f.consumer.agent.id])
    expect(result.workflows.map(workflow => workflow.workflowId)).toEqual([f.workflow.workflowId])
    expect(await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: untouched.workflowId,
    })).toEqual(before)
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.workflow.workflowId,
    })
    expect(read.version.executionSemanticsVersion).toBe(3)
    expect(await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.workflow.workflowId, workflowVersionId: f.workflow.currentVersionId,
    })).toMatchObject({ version: f.workflow.version })
  })

  it('does not adopt an unrelated changed Agent pin inside an affected workflow', async () => {
    const f = await fixture()
    const unrelated = await makeAgent(f.workspaceId)
    const mixed = await makeWorkflow(f.workspaceId, [f.consumer.agent, unrelated.agent], 'Mixed')
    await call('agent_update', c.AgentMutationResultSchema, {
      workspaceId: f.workspaceId, agentId: unrelated.agent.id, commandId: randomUUID(),
      expectedRevision: unrelated.metadataRevision, expectedConfigurationVersionId: unrelated.agent.configurationVersionId,
      prompt: { system: 'Unrelated edit' },
    })
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result.failed).toEqual([])
    expect(result.agents.map(agent => agent.agentId)).toEqual([f.consumer.agent.id])
    expect(result.workflows.map(workflow => workflow.workflowId).sort())
      .toEqual([f.workflow.workflowId, mixed.workflowId].sort())
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: mixed.workflowId,
    })
    const savedMixed = result.workflows.find(workflow => workflow.workflowId === mixed.workflowId)!
    expect(read.currentVersionId).toBe(savedMixed.workflowVersionId)
    expect(read.currentVersionId).not.toBe(mixed.currentVersionId)
    expect(read.revision).toBe(mixed.revision + 1)
    expect(read.version.agentConfigurationVersionIds).toEqual({
      [f.consumer.agent.id]: result.agents[0]!.configurationVersionId,
      [unrelated.agent.id]: unrelated.agent.configurationVersionId,
    })
    expect(await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: mixed.workflowId, workflowVersionId: mixed.currentVersionId,
    })).toMatchObject({ version: mixed.version })
  })

  it('recovers workflow pins when its consumer Agent already has the current skill version', async () => {
    const f = await fixture()
    await publish(f.workspaceId, f.skillId, 1, 'Version two')
    const agent = (await call('agent_update', c.AgentMutationResultSchema, {
      workspaceId: f.workspaceId, agentId: f.consumer.agent.id, commandId: randomUUID(),
      expectedRevision: f.consumer.metadataRevision,
      expectedConfigurationVersionId: f.consumer.agent.configurationVersionId,
      assignedSkills: [{ skillId: f.skillId, version: '2' }],
    })).value.agent
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId }))
      .toMatchObject({ agents: [], workflows: [{ workflowId: f.workflow.workflowId }] })
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId: randomUUID(),
    })
    expect(result).toMatchObject({ agents: [], failed: [], workflows: [{ workflowId: f.workflow.workflowId }] })
    const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.workflow.workflowId,
    })
    expect(read.version.agentConfigurationVersionIds).toEqual({ [agent.id]: agent.configurationVersionId })
  })

})
