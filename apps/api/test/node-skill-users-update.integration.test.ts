import { randomUUID } from 'node:crypto'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { skillConsumerFixture } from './helpers/skillConsumerFixture.js'

describe('node skill consumers over authenticated MCP', () => {
  const context = skillConsumerFixture()
  const { call, fixture, makeAgent, makeWorkflow } = context

  async function nodeConsumer() {
    const f = await fixture()
    const skill = (await call('skill_create', c.SkillMutationResultSchema, {
      workspaceId: f.workspaceId, name: 'Node guide', instructions: 'Original node instructions',
    })).value
    const member = await makeAgent(f.workspaceId)
    const workflow = await makeWorkflow(f.workspaceId, [member.agent, member.agent], 'Node consumers')
    const graph = structuredClone(workflow.version.definition)
    const node = graph.nodes[0]!
    if (node.kind === 'job') throw new Error('An Agent node is required')
    node.skills = { add: [
      { skillId: skill.skill.skillId, version: '1' }, { skillId: f.skillId, version: '1' },
    ] }
    const saved = (await call('workflow_save_v3', current.CurrentWorkflowSaveResultSchema, {
      workspaceId: f.workspaceId, workflowId: workflow.workflowId, executionSemanticsVersion: 3,
      expectedRevision: workflow.revision, expectedWorkflowVersionId: workflow.currentVersionId,
      expectedAgentConfigurationVersionIds: workflow.version.agentConfigurationVersionIds,
      graph,
    })).value
    await call('skill_update', c.SkillMutationResultSchema, {
      workspaceId: f.workspaceId, skillId: skill.skill.skillId,
      expectedRevision: skill.skill.revision,
      name: 'Node guide', instructions: 'Updated node instructions',
    })
    return { ...f, skillId: skill.skill.skillId, member, saved }
  }

  it('discovers a skill used only by a node addition', async () => {
    const f = await nodeConsumer()
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId }))
      .toEqual({ skillId: f.skillId, headVersion: '2', agents: [],
        workflows: [{ workflowId: f.saved.workflowId, name: 'Node consumers' }] })
  })

  it('saves updated node references and snapshots without changing Agent pins or saved history', async () => {
    const f = await nodeConsumer()
    const read = (workflowVersionId?: string) => call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
      workspaceId: f.workspaceId, workflowId: f.saved.workflowId, ...(workflowVersionId ? { workflowVersionId } : {}),
    })
    const before = await read()
    const reader = await context.connect((await context.access.issue({ name: 'Skill reader', audience: 'operator',
      grants: [{ actions: ['skills:read'], scope: { workspaceIds: [f.workspaceId] } }],
      expiresAt: new Date(Date.now() + 60_000) })).token)
    expect((await reader.callTool({ name: 'skill_users_update', arguments: {
      workspaceId: f.workspaceId, skillId: f.skillId,
    } })).isError).toBe(true)
    expect(await read()).toEqual(before)
    const commandId = randomUUID()
    const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId,
    })
    expect(result.failed).toEqual([])
    expect(result.agents).toEqual([])
    expect(result.workflows).toEqual([{ workflowId: f.saved.workflowId,
      workflowVersionId: expect.any(String) }])
    const after = await read()
    expect(after.currentVersionId).not.toBe(before.currentVersionId)
    expect(after.version.agentConfigurationVersionIds).toEqual(before.version.agentConfigurationVersionIds)
    const node = after.version.definition.nodes[0]!
    const originalNode = before.version.definition.nodes[0]!
    if (node.kind === 'job' || originalNode.kind === 'job') throw new Error('An Agent node is required')
    expect(node.skills?.add).toEqual(originalNode.skills!.add!.map(skill =>
      skill.skillId === f.skillId ? { ...skill, version: '2' } : skill))
    expect(after.version.definition.nodes[1]).toEqual(before.version.definition.nodes[1])
    expect(after.version.nodeSkillSnapshots?.[node.id]).toEqual([
      expect.objectContaining({ skillId: f.skillId, version: '2', instructions: 'Updated node instructions' }),
      before.version.nodeSkillSnapshots![node.id]![1],
    ])
    expect((await read(before.currentVersionId!)).version).toEqual(before.version)
    expect((await context.configurationOf(f.workspaceId, f.member.agent.id)).assignedSkills).toEqual([])
    expect(await call('skill_users_update', c.SkillUsersUpdateResultSchema, {
      workspaceId: f.workspaceId, skillId: f.skillId, commandId,
    })).toEqual(result)
    expect(await read()).toEqual(after)
    expect(await call('skill_usage_get', c.SkillUsageSchema, { workspaceId: f.workspaceId, skillId: f.skillId }))
      .toEqual({ skillId: f.skillId, headVersion: '2', agents: [], workflows: [] })
  })
})
