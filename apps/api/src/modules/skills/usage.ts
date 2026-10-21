import type pg from 'pg'
import { AgentConfigurationVersionSchema, AgentSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import {
  SkillUsageSchema, SkillUsersUpdateInputSchema, SkillUsersUpdateResultSchema,
  type ManagementPrincipal, type SkillUsage, type SkillUsersUpdateInput, type SkillUsersUpdateResult,
} from '@foreman-code/contracts/management'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import type { OperatorAgentMutationService } from '../workspaces/operatorAgents.js'
import type { CurrentWorkflowAuthoring } from '../workflows/currentAuthoring.js'

type Source = 'http' | 'mcp'
type UpdatePlan = Awaited<ReturnType<typeof readUsage>>
interface AgentRow { id: string; record: unknown; metadata_revision: string; configuration: unknown }

function childCommandId(commandId: string, kind: 'agent' | 'workflow', id: string): string {
  return `skill-users:${commandInputHash({ commandId, kind, id })}`
}

/** Updates skill consumers through the normal Agent and workflow saves. */
export class SkillUsageService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly agents: Pick<OperatorAgentMutationService, 'update'>,
    private readonly workflows: Pick<CurrentWorkflowAuthoring, 'save'>,
    private readonly commands: PostgresCommandCoordinator,
  ) {}

  async usage(principal: ManagementPrincipal, input: { workspaceId: string; skillId: string }): Promise<SkillUsage> {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    const state = await readUsage(this.pool, input.workspaceId, input.skillId)
    return SkillUsageSchema.parse({
      skillId: input.skillId,
      headVersion: state.head,
      agents: state.outdated.map(agent => ({ agentId: agent.id, name: agent.name, version: agent.version })),
      workflows: state.workflows.map(workflow => ({ workflowId: workflow.id, name: workflow.name })),
    })
  }

  async updateUsers(principal: ManagementPrincipal, source: Source, raw: SkillUsersUpdateInput): Promise<SkillUsersUpdateResult> {
    const input = SkillUsersUpdateInputSchema.parse(raw)
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    requireAuthorization(principal, 'agents:update', { workspaceId: input.workspaceId })
    const result = await this.commands.execute({
      principal, source, operation: 'skill.users.update', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:skill:${input.skillId}`, payload: input,
      // Children commit independently; retain command ownership without holding row locks across their saves.
      dedicatedConnection: true,
      authorize: async (client) => { await this.authorize(client, principal, input.workspaceId) },
      shouldResumeReceipt: async (client) => {
        const receipt = (await client.query<{ result: unknown }>(
          `select result from management_command_receipts
           where principal_id=$1 and operation='skill.users.update' and command_id=$2`,
          [principal.id, input.commandId],
        )).rows[0]
        return !!receipt && SkillUsersUpdateResultSchema.parse(receipt.result).failed.length > 0
      },
      perform: async () => {
        const plan = await this.commands.execute({
          principal, source, operation: 'skill.users.plan', commandId: input.commandId,
          targetKey: `workspace:${input.workspaceId}:skill:${input.skillId}`, payload: input,
          authorize: async (client) => {
            await lockActiveWorkspace(client, input.workspaceId)
            await this.authorize(client, principal, input.workspaceId)
          },
          perform: (client) => readUsage(client, input.workspaceId, input.skillId),
        })
        return this.applyPlan(principal, source, input, plan.value)
      },
    })
    return SkillUsersUpdateResultSchema.parse(result.value)
  }

  private async authorize(client: pg.Pool | pg.ClientBase, principal: ManagementPrincipal, workspaceId: string) {
    const live = await readLiveManagementPrincipal(client, principal.id)
    requireAuthorization(live, 'skills:read', { workspaceId })
    requireAuthorization(live, 'agents:update', { workspaceId })
    return live
  }

  private async applyPlan(principal: ManagementPrincipal, source: Source, input: SkillUsersUpdateInput, plan: UpdatePlan) {
    const result: SkillUsersUpdateResult = { headVersion: plan.head, agents: [], workflows: [], failed: [] }
    for (const agent of plan.outdated) {
      try {
        const live = await this.authorize(this.pool, principal, input.workspaceId)
        const updated = await this.agents.update(live, {
          workspaceId: input.workspaceId, agentId: agent.id,
          commandId: childCommandId(input.commandId, 'agent', agent.id), expectedRevision: agent.revision,
          expectedConfigurationVersionId: agent.configurationVersionId,
          assignedSkills: agent.assignedSkills.map(skill => skill.skillId === input.skillId
            ? { ...skill, version: plan.head } : skill),
        }, source)
        result.agents.push({ agentId: agent.id, configurationVersionId: updated.value.agent.configurationVersionId! })
      } catch (error) {
        result.failed.push(failure('agent', agent.id, error))
      }
    }
    await this.saveWorkflows(principal, source, input, plan, result)
    return SkillUsersUpdateResultSchema.parse(result)
  }

  private async saveWorkflows(principal: ManagementPrincipal, source: Source, input: SkillUsersUpdateInput,
    plan: UpdatePlan, result: SkillUsersUpdateResult) {
    const updated = new Map(result.agents.map(agent => [agent.agentId, agent.configurationVersionId]))
    const failedAgents = new Set(result.failed.filter(item => item.kind === 'agent').map(item => item.id))
    for (const workflow of plan.workflows) {
      try {
        if (Object.keys(workflow.currentPins).some(id => failedAgents.has(id))) {
          throw new DomainError('AGENT_UPDATE_FAILED', 'Update this workflow’s Agents before saving its skill update.', 409)
        }
        const live = await this.authorize(this.pool, principal, input.workspaceId)
        const pins = Object.fromEntries(Object.entries(workflow.currentPins)
          .map(([id, version]) => [id, updated.get(id) ?? version]))
        const graph = { ...workflow.graph, nodes: workflow.graph.nodes.map(node => {
          if (node.kind === 'job' || !node.skills?.add) return node
          return { ...node, skills: { ...node.skills, add: node.skills.add.map(skill =>
            skill.skillId === input.skillId ? { ...skill, version: plan.head } : skill) } }
        }) }
        const saved = await this.workflows.save(live, source, {
          workspaceId: input.workspaceId, workflowId: workflow.id,
          executionSemanticsVersion: 3, commandId: childCommandId(input.commandId, 'workflow', workflow.id),
          expectedRevision: workflow.revision, expectedWorkflowVersionId: workflow.versionId,
          expectedAgentConfigurationVersionIds: pins,
          graph,
        }) as { value: { currentVersionId: string } }
        result.workflows.push({ workflowId: workflow.id, workflowVersionId: saved.value.currentVersionId })
      } catch (error) {
        result.failed.push(failure('workflow', workflow.id, error))
      }
    }
  }
}

async function readUsage(client: pg.Pool | pg.ClientBase, workspaceId: string, skillId: string) {
  const head = (await client.query<{ head_version: string }>(
    'select head_version from workspace_skills where workspace_id=$1 and skill_id=$2', [workspaceId, skillId])).rows[0]?.head_version
  if (!head) throw new DomainError('SKILL_NOT_FOUND', 'The skill was not found in this workspace.', 404)
  const workspace = (await client.query<{ id: string }>(
    'select id from workspaces where id=$1', [workspaceId])).rows[0]
  if (!workspace) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
  const rows = (await client.query<AgentRow>(`select a.id,a.record,a.metadata_revision::text,c.record as configuration
    from agents a join agent_configuration_versions c on c.id=a.current_configuration_version_id and c.agent_id=a.id
    where a.workspace_id=$1 and a.archived_at is null order by a.id`, [workspaceId])).rows
  const consumers = new Map<string, string>()
  const outdated: { id: string; name: string; version: string; revision: number; configurationVersionId: string
    assignedSkills: { skillId: string; version: string }[] }[] = []
  for (const row of rows) {
    const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
    const assigned = configuration.assignedSkills.find(skill => skill.skillId === skillId)
    if (!assigned) continue
    consumers.set(row.id, configuration.id)
    if (assigned.version === head) continue
    outdated.push({ id: row.id, name: AgentSchema.parse(row.record).name, version: assigned.version,
      revision: Number(row.metadata_revision), configurationVersionId: configuration.id,
      assignedSkills: configuration.assignedSkills })
  }
  const outdatedIds = new Set(outdated.map(agent => agent.id))
  const workflowRows = (await client.query<{ id: string; record: unknown; revision: string; current_version_id: string;
    version: unknown }>(`select w.id,w.record,w.revision::text,w.current_version_id,v.record as version
    from workflows w join workflow_versions v on v.id=w.current_version_id and v.workspace_id=w.workspace_id
    where w.workspace_id=$1 and w.archived_at is null and v.execution_semantics_version=3 order by w.id`, [workspaceId])).rows
  const workflows = workflowRows.flatMap(row => {
    const version = WorkflowVersionV3Schema.parse(row.version)
    const pins = version.agentConfigurationVersionIds
    const graph = WorkflowDefinitionV3Schema.parse(row.record)
    const nodeOutdated = graph.nodes.some(node => node.kind !== 'job'
      && node.skills?.add?.some(skill => skill.skillId === skillId && skill.version !== head))
    const affected = Object.keys(pins).some(id => consumers.has(id)
      && (outdatedIds.has(id) || consumers.get(id) !== pins[id]))
    if (!affected && !nodeOutdated) return []
    return [{ id: row.id, name: graph.name, revision: Number(row.revision), versionId: row.current_version_id, graph,
      currentPins: Object.fromEntries(Object.keys(pins).map(id => [id, consumers.get(id) ?? pins[id]!])) }]
  })
  return { head, outdated, workflows }
}

function failure(kind: 'agent' | 'workflow', id: string, error: unknown) {
  const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR'
  const message = error instanceof DomainError ? error.message : 'The update could not be saved.'
  return { kind, id, code, message }
}
