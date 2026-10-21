import type pg from 'pg'
import {
  AgentSchema, AgentConfigurationVersionSchema, agentTemplateForRole, projectHarnessEffort,
  validateHarnessWorkflowCompatibility, CodexSessionCompatibilitySchema,
  type Agent, type HarnessConfiguration,
} from '@foreman-code/contracts'
import {
  AgentCreateInputSchema, AgentUpdateInputSchema, AgentCloneInputSchema,
  type AgentCreateInput, type AgentUpdateInput, type AgentCloneInput, type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { hasAction, isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { HostHarnessOverrideService } from '../harnesses/instanceSettings/service.js'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { HarnessCatalogService } from '../harnesses/catalog.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import { lockActiveWorkspace } from './admission.js'
import { lockAgentConfigurations, saveAgentConfiguration } from './agentConfiguration.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'
import { prepareAgentConfiguration } from './agentConfigurationPreparation.js'

export function agentWithConfiguration(agent: Agent, configuration: HarnessConfiguration): Agent {
  return AgentSchema.parse({...agent, harness: configuration.harness, model: configuration.model,
    effort: projectHarnessEffort(configuration),
    fastMode: configuration.harness === 'codex' ? configuration.serviceTier === 'priority' : undefined,
    harnessConfiguration: configuration})
}

export async function readAgentForReuse(client: pg.ClientBase, principal: ManagementPrincipal, workspaceId: string, agentId: string) {
  if (!hasAction(principal, 'agents:read')) throw new DomainError('ACCESS_DENIED', 'Agent read permission is required.', 403)
  const references = await client.query<{id: string}>(
    `select id from workflows where workspace_id=$1 and exists(
      select 1 from jsonb_array_elements(record->'nodes') n where n->>'agentId'=$2) order by id`, [workspaceId,agentId],
  )
  if (!isAuthorized(principal, 'agents:read', {workspaceId})
    && !references.rows.some((row) => isAuthorized(principal,'agents:read',{workspaceId,workflowId:row.id}))) {
    throw new DomainError('AGENT_NOT_FOUND', 'The Agent is not visible in this scope.', 404)
  }
  const rows = await client.query<{record: unknown;metadata_revision: string;current_configuration_version_id: string|null;configuration_record: unknown;archived_at: Date|null}>(
    `select a.record,a.metadata_revision,a.current_configuration_version_id,a.archived_at,c.record as configuration_record
     from agents a left join agent_configuration_versions c on c.id=a.current_configuration_version_id
       and c.workspace_id=a.workspace_id and c.agent_id=a.id where a.workspace_id=$1 and a.id=$2 for share of a`, [workspaceId,agentId],
  )
  const row = rows.rows[0]
  if (!row) throw new DomainError('AGENT_NOT_FOUND', 'The Agent was not found.', 404)
  if (row.archived_at) throw new DomainError('AGENT_ARCHIVED', 'Restore the archived Agent before reusing it.', 409)
  if (!row.current_configuration_version_id || !row.configuration_record) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'The Agent has no persisted configuration to reuse.', 409)
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration_record)
  if (configuration.id !== row.current_configuration_version_id || configuration.agentId !== agentId || configuration.workspaceId !== workspaceId) {
    throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'The saved Agent configuration identity is invalid.', 409)
  }
  const agent = agentWithConfiguration(AgentSchema.parse({...AgentSchema.parse(row.record), productRole: configuration.productRole,
    configurationVersionId: configuration.id, prompt: configuration.prompt, assignedSkills: configuration.assignedSkills,
    graphqlTools: configuration.graphqlTools, nativeTools: configuration.nativeTools,
    harnessProfileSelection: configuration.harnessProfileSelection}), configuration.harness)
  return {agent, baseRevision: Number(row.metadata_revision), workflowIds: references.rows.map((item) => item.id)}
}

export function authorizeAgentConfiguration(principal: ManagementPrincipal, workspaceId: string, configuration: HarnessConfiguration, assignedSkills: Agent['assignedSkills']): void {
  if (configuration.harness === 'codex' && configuration.sandbox === 'danger-full-access') requireAuthorization(principal,'harnesses:update',{workspaceId})
  if (assignedSkills?.length) requireAuthorization(principal,'skills:read',{workspaceId})
  // An Agent may be configured before its workflow assigns approval authority.
  // Each executable workflow validates the immutable configuration in context.
  validateHarnessWorkflowCompatibility(configuration)
  if (configuration.harness === 'codex') CodexSessionCompatibilitySchema.parse({configuration,requiresResume:true})
}

export async function assertAgentIdle(client: pg.ClientBase, workspaceId: string, agentId: string): Promise<void> {
  const active = await client.query(
    `select id from runs where workspace_id=$1 and execution_state <> 'completed'
     and (record->'agentConfigurationVersionIds') ? $2 limit 1`, [workspaceId,agentId],
  )
  if (active.rows.length) throw new DomainError('AGENT_BUSY', 'Settle active Runs before mutating this Agent.', 409)
}

export class OperatorAgentMutationService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly harnesses: Pick<HarnessCatalogService,'qualifyConfiguration'>,
    private readonly profiles?: Pick<HostHarnessOverrideService, 'validateSelection'>,
    private readonly accountConfigurations?: ProviderAccountConfigurationService) {}

  private validateProfile(principal: ManagementPrincipal) {
    return async (selection: HarnessProfileSelection, configuration: HarnessConfiguration, client: pg.PoolClient) => {
      if (!this.profiles) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE', 'Selected host profile validation is not composed.', 503)
      await this.profiles.validateSelection(principal, selection, configuration, client)
    }
  }

  private async authorizeWrite(client: pg.PoolClient, principal: ManagementPrincipal, workspaceId: string, agentId: string) {
    await lockActiveWorkspace(client,workspaceId)
    await lockAgentConfigurations(client,[agentId])
    principal = await readLiveManagementPrincipal(client, principal.id)
    requireAuthorization(principal,'agents:update',{workspaceId})
    const current = await readAgentForReuse(client,principal,workspaceId,agentId)
    for (const workflowId of current.workflowIds) {
      requireAuthorization(principal,'graph:read',{workspaceId,workflowId})
      requireAuthorization(principal,'graph:edit',{workspaceId,workflowId})
    }
    await assertAgentIdle(client,workspaceId,agentId)
    return current
  }

  create(principal: ManagementPrincipal, raw: AgentCreateInput, source: 'http' | 'mcp' = 'mcp') {
    const input = AgentCreateInputSchema.parse(raw)
    requireAuthorization(principal,'agents:create',{workspaceId:input.workspaceId})
    requireAuthorization(principal,'agents:read',{workspaceId:input.workspaceId})
    let livePrincipal = principal
    const preparation = prepareAgentConfiguration({ harnesses: this.harnesses,
      accounts: this.accountConfigurations, principal: () => livePrincipal, workspaceId: input.workspaceId,
      source, commandId: input.commandId, load: async client => {
        await lockActiveWorkspace(client, input.workspaceId)
        await lockAgentConfigurations(client, [input.agentId])
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:create', { workspaceId: input.workspaceId })
        requireAuthorization(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })
        const existing = await client.query('select id from agents where id=$1', [input.agentId])
        if (existing.rows.length) throw new DomainError('AGENT_ID_CONFLICT', 'The Agent ID already exists.', 409)
        const defaults = agentTemplateForRole((await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults(client)).value, input.productRole)
        const configuration = input.configuration ?? defaults.harness
        authorizeAgentConfiguration(livePrincipal, input.workspaceId, configuration, input.assignedSkills)
        return { configuration,
          selection: input.harnessProfileSelection ?? (input.configuration ? undefined : defaults.harnessProfileSelection) }
      } })
    return this.commands.execute({principal,source,operation:'agent.create',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:agent:${input.agentId}`,payload:input,
      ...preparation.command,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:create', { workspaceId: input.workspaceId })
        requireAuthorization(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })
      },
      perform:async(client) => {
        await lockActiveWorkspace(client,input.workspaceId)
        await lockAgentConfigurations(client,[input.agentId])
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:create', { workspaceId: input.workspaceId })
        requireAuthorization(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })
        const existing = await client.query('select id from agents where id=$1',[input.agentId])
        if (existing.rows.length) throw new DomainError('AGENT_ID_CONFLICT','The Agent ID already exists.',409)
        const defaults = await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults(client)
        const { configuration, selection: harnessProfileSelection } = preparation.value()
        authorizeAgentConfiguration(livePrincipal,input.workspaceId,configuration,input.assignedSkills)
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        const agent = await saveAgentConfiguration(client,input.workspaceId,agentWithConfiguration(AgentSchema.parse({
          id:input.agentId,name:input.name,productRole:input.productRole,description:input.description,role:input.role,
          prompt:input.prompt ?? {},assignedSkills:input.assignedSkills ?? [], harnessProfileSelection,
          nativeTools: input.nativeTools ?? agentTemplateForRole(defaults.value, input.productRole).nativeTools,
          ...(input.graphqlTools ? {graphqlTools:input.graphqlTools} : {}),
        }),configuration), false, this.validateProfile(livePrincipal))
        const revision = await client.query<{metadata_revision:string}>('select metadata_revision from agents where id=$1',[agent.id])
        return {agent,metadataRevision:Number(revision.rows[0]!.metadata_revision)}
      },
    })
  }

  update(principal: ManagementPrincipal, raw: AgentUpdateInput, source: 'http' | 'mcp' = 'mcp') {
    const input = AgentUpdateInputSchema.parse(raw)
    requireAuthorization(principal,'agents:update',{workspaceId:input.workspaceId})
    let livePrincipal = principal
    const preparation = prepareAgentConfiguration({ harnesses: this.harnesses,
      accounts: this.accountConfigurations, principal: () => livePrincipal, workspaceId: input.workspaceId,
      source, commandId: input.commandId, load: async client => {
        const current = await this.authorizeWrite(client, livePrincipal, input.workspaceId, input.agentId)
        this.assertRevision(current, input.expectedRevision, input.expectedConfigurationVersionId)
        const configuration = input.configuration ?? current.agent.harnessConfiguration!
        authorizeAgentConfiguration(livePrincipal, input.workspaceId, configuration,
          input.assignedSkills ?? current.agent.assignedSkills)
        return { configuration,
          selection: input.harnessProfileSelection ?? current.agent.harnessProfileSelection,
          previousConfiguration: current.agent.harnessConfiguration! }
      } })
    return this.commands.execute({principal,source,operation:'agent.update',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:agent:${input.agentId}`,payload:input,
      ...preparation.command,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:update', { workspaceId: input.workspaceId })
        if (!isAuthorized(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })) {
          await readAgentForReuse(client, livePrincipal, input.workspaceId, input.agentId)
        }
      },
      perform:async(client) => {
        const current = await this.authorizeWrite(client,livePrincipal,input.workspaceId,input.agentId)
        this.assertRevision(current,input.expectedRevision,input.expectedConfigurationVersionId)
        const { configuration, selection: harnessProfileSelection } = preparation.value()
        authorizeAgentConfiguration(livePrincipal,input.workspaceId,configuration,input.assignedSkills ?? current.agent.assignedSkills)
        const edited = agentWithConfiguration(AgentSchema.parse({...current.agent, harnessProfileSelection,
          ...(input.name !== undefined ? {name:input.name} : {}),
          ...(input.description !== undefined ? {description:input.description ?? undefined} : {}),
          ...(input.role !== undefined ? {role:input.role ?? undefined} : {}),
          ...(input.prompt !== undefined ? {prompt:input.prompt} : {}),
          ...(input.assignedSkills !== undefined ? {assignedSkills:input.assignedSkills} : {}),
          ...(input.graphqlTools !== undefined ? {graphqlTools:input.graphqlTools} : {}),
          ...(input.nativeTools !== undefined ? {nativeTools:input.nativeTools} : {}),
        }),configuration)
        const result = await this.persist(client,input.workspaceId,edited,livePrincipal)
        return { ...result, affectedWorkflowIds: current.workflowIds }
      },
    })
  }

  clone(principal: ManagementPrincipal, raw: AgentCloneInput) {
    const input = AgentCloneInputSchema.parse(raw)
    requireAuthorization(principal,'agents:create',{workspaceId:input.workspaceId})
    let livePrincipal = principal
    const preparation = prepareAgentConfiguration({ harnesses: this.harnesses,
      accounts: this.accountConfigurations, principal: () => livePrincipal, workspaceId: input.workspaceId,
      source: 'mcp', commandId: input.commandId, load: async client => {
        await lockActiveWorkspace(client, input.workspaceId)
        await lockAgentConfigurations(client, [input.agentId, input.sourceAgentId])
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:create', { workspaceId: input.workspaceId })
        const current = await readAgentForReuse(client, livePrincipal, input.workspaceId, input.sourceAgentId)
        this.assertRevision(current, input.expectedSourceRevision, input.expectedSourceConfigurationVersionId)
        const existing = await client.query('select id from agents where id=$1', [input.agentId])
        if (existing.rows.length) throw new DomainError('AGENT_ID_CONFLICT', 'The clone Agent ID already exists.', 409)
        authorizeAgentConfiguration(livePrincipal, input.workspaceId, current.agent.harnessConfiguration!, current.agent.assignedSkills)
        return { configuration: current.agent.harnessConfiguration!, selection: current.agent.harnessProfileSelection }
      } })
    return this.commands.execute({principal,source:'mcp',operation:'agent.clone',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:agent:${input.agentId}`,payload:input,
      ...preparation.command,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:create', { workspaceId: input.workspaceId })
        if (!isAuthorized(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })) {
          await readAgentForReuse(client, livePrincipal, input.workspaceId, input.sourceAgentId)
        }
      },
      perform:async(client) => {
        await lockActiveWorkspace(client,input.workspaceId)
        await lockAgentConfigurations(client,[input.agentId,input.sourceAgentId])
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:create', { workspaceId: input.workspaceId })
        if (!isAuthorized(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })) {
          await readAgentForReuse(client, livePrincipal, input.workspaceId, input.sourceAgentId)
        }
        const current = await readAgentForReuse(client,livePrincipal,input.workspaceId,input.sourceAgentId)
        this.assertRevision(current,input.expectedSourceRevision,input.expectedSourceConfigurationVersionId)
        const existing = await client.query('select id from agents where id=$1',[input.agentId])
        if (existing.rows.length) throw new DomainError('AGENT_ID_CONFLICT','The clone Agent ID already exists.',409)
        const source = current.agent
        const { configuration, selection } = preparation.value()
        authorizeAgentConfiguration(livePrincipal,input.workspaceId,configuration,source.assignedSkills)
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        const agent = await saveAgentConfiguration(client,input.workspaceId,AgentSchema.parse({
          id:input.agentId,name:input.name,description:source.description,role:source.role,productRole:source.productRole,
          harnessConfiguration:configuration,harnessProfileSelection:selection,prompt:source.prompt,assignedSkills:source.assignedSkills,
          graphqlTools:source.graphqlTools,
          nativeTools: source.nativeTools,
        }),false,this.validateProfile(livePrincipal))
        const revision = await client.query<{metadata_revision:string}>('select metadata_revision from agents where id=$1',[agent.id])
        return {agent,metadataRevision:Number(revision.rows[0]!.metadata_revision)}
      },
    })
  }

  restore(principal: ManagementPrincipal, input: {workspaceId:string;agentId:string;versionId:string;commandId:string;expectedRevision:number;expectedConfigurationVersionId:string}) {
    requireAuthorization(principal,'agents:update',{workspaceId:input.workspaceId})
    let livePrincipal = principal
    const preparation = prepareAgentConfiguration({ harnesses: this.harnesses,
      accounts: this.accountConfigurations, principal: () => livePrincipal, workspaceId: input.workspaceId,
      source: 'mcp', commandId: input.commandId, load: async client => {
        const current = await this.authorizeWrite(client, livePrincipal, input.workspaceId, input.agentId)
        this.assertRevision(current, input.expectedRevision, input.expectedConfigurationVersionId)
        const rows = await client.query<{ record: unknown }>(
          'select record from agent_configuration_versions where workspace_id=$1 and agent_id=$2 and id=$3',
          [input.workspaceId, input.agentId, input.versionId])
        if (!rows.rows[0]) throw new DomainError('AGENT_VERSION_NOT_FOUND', 'The historical Agent version was not found.', 404)
        const version = AgentConfigurationVersionSchema.parse(rows.rows[0].record)
        if (version.productRole !== current.agent.productRole) {
          throw new DomainError('AGENT_ROLE_RESTORE_UNSUPPORTED', 'Restore role-changing history through an explicitly validated graph change.', 409)
        }
        authorizeAgentConfiguration(livePrincipal, input.workspaceId, version.harness, version.assignedSkills)
        return { configuration: version.harness, selection: version.harnessProfileSelection }
      } })
    return this.commands.execute({principal,source:'mcp',operation:'agent.configuration.restore',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:agent:${input.agentId}`,payload:input,
      ...preparation.command,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'agents:update', { workspaceId: input.workspaceId })
        if (!isAuthorized(livePrincipal, 'agents:read', { workspaceId: input.workspaceId })) {
          await readAgentForReuse(client, livePrincipal, input.workspaceId, input.agentId)
        }
      },
      perform:async(client) => {
        const current = await this.authorizeWrite(client,livePrincipal,input.workspaceId,input.agentId)
        this.assertRevision(current,input.expectedRevision,input.expectedConfigurationVersionId)
        const rows = await client.query<{record:unknown}>('select record from agent_configuration_versions where workspace_id=$1 and agent_id=$2 and id=$3',[input.workspaceId,input.agentId,input.versionId])
        if (!rows.rows[0]) throw new DomainError('AGENT_VERSION_NOT_FOUND','The historical Agent version was not found.',404)
        const version = AgentConfigurationVersionSchema.parse(rows.rows[0].record)
        // Role changes can invalidate Orchestrator assignments. A restore does not
        // silently redesign those assignments across shared workflows.
        if (version.productRole !== current.agent.productRole) throw new DomainError('AGENT_ROLE_RESTORE_UNSUPPORTED','Restore role-changing history through an explicitly validated graph change.',409)
        const { configuration, selection } = preparation.value()
        authorizeAgentConfiguration(livePrincipal,input.workspaceId,configuration,version.assignedSkills)
        return this.persist(client,input.workspaceId,agentWithConfiguration(AgentSchema.parse({...current.agent,
          prompt:version.prompt,assignedSkills:version.assignedSkills,graphqlTools:version.graphqlTools,
          nativeTools:version.nativeTools,harnessProfileSelection:selection}),configuration),livePrincipal)
      },
    })
  }

  private assertRevision(current: {baseRevision:number;agent:Agent}, expectedRevision:number, expectedConfigurationVersionId:string): void {
    if (current.baseRevision !== expectedRevision) throw new DomainError('AGENT_REVISION_CONFLICT','The Agent metadata changed.',409)
    if (current.agent.configurationVersionId !== expectedConfigurationVersionId) throw new DomainError('AGENT_CONFIGURATION_CONFLICT','The Agent configuration changed.',409)
  }
  private async persist(client:pg.PoolClient,workspaceId:string,edited:Agent,principal:ManagementPrincipal) {
    principal = await readLiveManagementPrincipal(client, principal.id)
    const agent = await saveAgentConfiguration(client,workspaceId,edited,true,this.validateProfile(principal))
    const rows = await client.query<{metadata_revision:string}>(
      'update agents set metadata_revision=metadata_revision+1 where workspace_id=$1 and id=$2 returning metadata_revision',[workspaceId,agent.id],
    )
    return {agent,metadataRevision:Number(rows.rows[0]!.metadata_revision)}
  }
}
