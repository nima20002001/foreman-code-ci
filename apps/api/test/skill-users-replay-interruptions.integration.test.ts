import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import * as c from '@foreman-code/contracts/management'
import * as current from '@foreman-code/contracts/wave25'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { skillConsumerFixture } from './helpers/skillConsumerFixture.js'

describe.skipIf(!postgresEnabled)('Skill consumer update plans over authenticated MCP: interruptions', () => {
  const context = skillConsumerFixture()
  const { call, fixture, makeAgent, publish, configurationOf } = context

  it.each(['partial', 'response-gap'] as const)('retains its original plan across a %s and later head/consumer changes',
    async (interruption) => {
      const { commands, authoring, client, database } = context
      const f = await fixture()
      await publish(f.workspaceId, f.skillId, 1, 'Version two')
      const commandId = interruption.padEnd(200, 'p')
      const input = { workspaceId: f.workspaceId, skillId: f.skillId, commandId }
      const execute = commands.execute.bind(commands)
      let interrupt = true
      const intercepted: typeof commands.execute = async (command) => {
        if (interruption === 'response-gap' && interrupt && command.operation === 'skill.users.update') {
          interrupt = false
          return execute({ ...command, perform: async (sql) => {
            await command.perform(sql)
            throw new Error('Parent response interrupted after child commits')
          } })
        }
        return execute(command)
      }
      const commandSpy = vi.spyOn(commands, 'execute').mockImplementation(intercepted)
      const workflowSpy = vi.spyOn(authoring, 'save')
      if (interruption === 'partial') workflowSpy.mockImplementationOnce(async () => {
        throw new DomainError('WORKFLOW_BUSY', 'Workflow is busy.', 409)
      })
      try {
        const first = await client.callTool({ name: 'skill_users_update', arguments: input })
        if (interruption === 'response-gap') {
          expect(first.isError).toBe(true)
          expect(workflowSpy).toHaveBeenCalledTimes(1)
        } else expect(c.SkillUsersUpdateResultSchema.parse(decodeMcpToolResult(first)).failed)
          .toEqual([{ kind: 'workflow', id: f.workflow.workflowId, code: 'WORKFLOW_BUSY', message: 'Workflow is busy.' }])
        const accepted = await configurationOf(f.workspaceId, f.consumer.agent.id)
        expect(accepted.assignedSkills).toEqual([{ skillId: f.skillId, version: '2' }])
        const newcomer = await makeAgent(f.workspaceId, f.skillId)
        await publish(f.workspaceId, f.skillId, 2, 'Version three')
        const result = await call('skill_users_update', c.SkillUsersUpdateResultSchema, input)
        expect(result).toMatchObject({ headVersion: '2', failed: [],
          agents: [{ agentId: f.consumer.agent.id, configurationVersionId: accepted.id }] })
        expect(result.workflows.map(workflow => workflow.workflowId)).toEqual([f.workflow.workflowId])
        expect(await configurationOf(f.workspaceId, f.consumer.agent.id)).toEqual(accepted)
        expect((await configurationOf(f.workspaceId, newcomer.agent.id)).assignedSkills)
          .toEqual([{ skillId: f.skillId, version: '1' }])
        const read = await call('workflow_saved_get_v3', current.CurrentWorkflowReadResultSchema, {
          workspaceId: f.workspaceId, workflowId: f.workflow.workflowId,
        })
        expect(read.version.agentConfigurationVersionIds).toEqual({ [f.consumer.agent.id]: accepted.id })
        expect(await call('skill_users_update', c.SkillUsersUpdateResultSchema, input)).toEqual(result)
        expect((await database.pool.query('select count(*)::int as count from agent_configuration_versions where agent_id=$1',
          [f.consumer.agent.id])).rows[0].count).toBe(2)
        const other = (await call('skill_create', c.SkillMutationResultSchema, {
          workspaceId: f.workspaceId, commandId: randomUUID(), name: 'Other', instructions: 'Other instructions',
        })).value.skill
        const conflict = await client.callTool({ name: 'skill_users_update', arguments: { ...input, skillId: other.skillId } })
        expect(conflict.isError).toBe(true)
        expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
      } finally {
        workflowSpy.mockRestore()
        commandSpy.mockRestore()
      }
    })

})
