import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { errorMessage } from '../../shared/errorMessage.js'
import { AgentDefaultsSchema, withAdvancedDefaults, CodexSessionCompatibilitySchema, validateHarnessWorkflowCompatibility, type AgentDefaults, type WorkflowDefaults } from '@foreman-code/contracts'
import { WorkspaceDefaultsUpdateInputSchema, type WorkspaceDefaultsUpdateInput, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { GeneralSettingsUpdateInputSchema, type GeneralSettingsUpdateInput } from '@foreman-code/contracts/management'
import { CircleCreditAllowanceUpdateInputSchema, type CircleCreditAllowanceUpdateInput } from '@foreman-code/contracts/management'
import { PromptSettingUpdateInputSchema, type PromptSettingUpdateInput } from '@foreman-code/contracts/management'
import { isDeepStrictEqual } from 'node:util'

import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { assertClaudeFullAccess } from '../harnesses/nativeWorkflowConfiguration.js'
import type { HostHarnessOverrideService } from '../harnesses/instanceSettings/service.js'
import type { HarnessCatalogService } from '../harnesses/catalog.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from './foundation.js'
import { operatorSkillContent, type PostgresOperatorRepository } from '../operators/postgres.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'

export class FoundationSettingsManagementService {
  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly harnesses?: Pick<HarnessCatalogService, 'qualifyConfiguration'>,
    private readonly operators?: PostgresOperatorRepository,
    private readonly profiles?: Pick<HostHarnessOverrideService, 'validateSelection'> & Partial<Pick<HostHarnessOverrideService, 'selectionForConfiguration' | 'prepareOperatorConfiguration'>>,
    private readonly accountConfigurations?: ProviderAccountConfigurationService,
  ) {}

  getSystemPrompt(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getSystemPrompt()
  }

  updateSystemPrompt(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: PromptSettingUpdateInput) {
    requireAuthorization(principal, 'settings:update')
    const input = PromptSettingUpdateInputSchema.parse(raw)
    return this.commands.execute({
      principal, source, operation: 'system.prompt.update', commandId: input.commandId,
      targetKey: 'system-prompt', payload: input,
      authorize: async client => {
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
      },
      perform: client => this.settings.updateSystemPrompt(input.value, input.expectedRevision, client),
    })
  }

  getOperatorInitialPrompt(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getOperatorInitialPrompt()
  }

  updateOperatorInitialPrompt(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: PromptSettingUpdateInput) {
    requireAuthorization(principal, 'settings:update')
    const input = PromptSettingUpdateInputSchema.parse(raw)
    return this.commands.execute({
      principal, source, operation: 'operator.initial.prompt.update', commandId: input.commandId,
      targetKey: 'operator-initial-prompt', payload: input,
      authorize: async client => {
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
      },
      perform: client => this.settings.updateOperatorInitialPrompt(input.value, input.expectedRevision, client),
    })
  }

  getGeneralSettings(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getGeneralSettings()
  }

  updateGeneralSettings(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: GeneralSettingsUpdateInput) {
    requireAuthorization(principal, 'settings:update')
    const input = GeneralSettingsUpdateInputSchema.parse(raw)
    return this.commands.execute({
      principal, source, operation: 'general.settings.update', commandId: input.commandId,
      targetKey: 'general-settings', payload: input,
      authorize: async client => {
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
      },
      perform: client => this.settings.updateGeneralSettings(input.value, input.expectedRevision, client),
    })
  }

  getCircleCreditAllowance(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getCircleCreditAllowance()
  }

  updateCircleCreditAllowance(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: CircleCreditAllowanceUpdateInput) {
    requireAuthorization(principal, 'settings:update')
    const input = CircleCreditAllowanceUpdateInputSchema.parse(raw)
    return this.commands.execute({
      principal, source, operation: 'circle.credit.allowance.update', commandId: input.commandId,
      targetKey: 'circle-credit-allowance', payload: input,
      authorize: async client => {
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
      },
      perform: client => this.settings.updateCircleCreditAllowance(input.value, input.expectedRevision, client),
    })
  }

  getWorkspaceDefaults(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getWorkspaceDefaults()
  }

  async getWorkspaceCreationDefaults(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'workspaces:create')
    return (await this.settings.getWorkspaceDefaults()).value
  }

  updateWorkspaceDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceDefaultsUpdateInput) {
    requireAuthorization(principal, 'settings:update')
    const accepted = WorkspaceDefaultsUpdateInputSchema.parse(input)
    let livePrincipal = principal
    return this.commands.execute({ principal, source, operation: 'workspace.defaults.update', commandId: accepted.commandId,
      targetKey: 'workspace-defaults-v1', payload: accepted,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'settings:update')
      },
      perform: async client => {
        const result = await this.settings.updateWorkspaceDefaults(accepted.value, accepted.expectedRevision, client)
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
        return result
      },
    })
  }

  getAgentDefaults(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getAgentDefaults()
  }

  getWorkflowDefaults(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getWorkflowDefaults()
  }

  updateAgentDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    commandId: string; expectedRevision?: number | undefined; value: AgentDefaults
  }) {
    requireAuthorization(principal, 'settings:update')
    let livePrincipal = principal
    let previous: Awaited<ReturnType<PostgresFoundationSettingsRepository['getAgentDefaults']>>
    let value: AgentDefaults
    const unchangedProfile = (role: keyof AgentDefaults) => {
      const next = value[role], prior = previous.value[role]
      return !!next && !!prior && isDeepStrictEqual(next.harnessProfileSelection, prior.harnessProfileSelection)
        && isDeepStrictEqual(withAdvancedDefaults(next.harness), withAdvancedDefaults(prior.harness))
    }
    return this.commands.execute({
      principal, source, operation: 'agent.defaults.update', commandId: input.commandId,
      targetKey: 'agent-defaults-v1', payload: input,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'settings:update')
      },
      prepare: async pool => {
        value = AgentDefaultsSchema.parse(input.value)
        previous = await this.settings.getAgentDefaults()
        if (input.expectedRevision !== undefined && previous.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Agent defaults changed since they were read.', 409)
        }
        await withTransaction(pool, async client => {
          if (this.accountConfigurations) {
            for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
              const template = value[role]
              if (!template || unchangedProfile(role)) continue
              template.harness = await this.accountConfigurations.resolve(template.harness,
                template.harnessProfileSelection, { sql: client })
            }
          }
        })
        for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
          const template = value[role]
          if (template) assertClaudeFullAccess(template.harness)
        }
        for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
          const template = value[role]
          if (!template) continue
          const prior = previous.value[role]
          const configuration = template.harness
          if (role === 'operator' && configuration.harness === 'claude'
            && template.harnessProfileSelection?.target.hostRef.kind === 'main'
            && isDeepStrictEqual(template.harnessProfileSelection, prior?.harnessProfileSelection)
            && !isDeepStrictEqual(withAdvancedDefaults(configuration), prior ? withAdvancedDefaults(prior.harness) : undefined)) {
            // A newly edited default cannot reuse its previous exact proof.
            // Accepted conversations and the saved source profile stay pinned.
            delete template.harnessProfileSelection
          }
          if (role === 'operator' && configuration.harness === 'claude' && !template.harnessProfileSelection) {
            const resolved = await withTransaction(pool, client =>
              this.profiles?.selectionForConfiguration?.(livePrincipal, configuration, client) ?? Promise.resolve(undefined))
              ?? await this.profiles?.prepareOperatorConfiguration?.(livePrincipal, source, configuration, input.commandId)
            if (resolved) template.harnessProfileSelection = resolved
          }
          const selection = template.harnessProfileSelection
          // Even unchanged legacy defaults must satisfy Operator chat's resumability boundary.
          // Validate before the unchanged-configuration shortcut or any persistent write.
          if (role === 'operator' && configuration.harness === 'codex') {
            CodexSessionCompatibilitySchema.parse({ configuration, requiresResume: true })
          }
          if (unchangedProfile(role)) continue
          if (selection) {
            if (!this.profiles) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE', 'Selected host profile validation is not composed.', 503)
            continue
          }
          if (isDeepStrictEqual(prior ? withAdvancedDefaults(prior.harness) : undefined, withAdvancedDefaults(configuration))) continue
          if (!this.harnesses) throw new DomainError('HARNESS_QUALIFICATION_UNAVAILABLE', 'Native qualification is unavailable; changed configurations were not saved.', 503)
          if (role !== 'operator') {
            validateHarnessWorkflowCompatibility(configuration, 'user')
            if (configuration.harness === 'codex') CodexSessionCompatibilitySchema.parse({ configuration, requiresResume: true })
          }
          try { await this.harnesses.qualifyConfiguration(configuration) } catch (error) {
            throw new DomainError('AGENT_DEFAULTS_UNQUALIFIED', `The ${role} template was not saved: ${errorMessage(error, 'Native qualification failed.')}`, 409, undefined, { cause: error })
          }
        }
      },
      preparedMutation: {
        releaseDuringPreparation: true,
        resourceLock: 'setting:agent-defaults-v1',
        validate: async client => {
          await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:agent-defaults-v1'])
          const current = await this.settings.getAgentDefaults(client)
          return isDeepStrictEqual(previous, current)
        },
      },
      perform: async client => {
        await this.validatePreparedDefaults(client, livePrincipal, value, previous.value)
        const operators = this.operators
        const skills = value.operator.assignedSkills ?? []
        const skillsChanged = !isDeepStrictEqual(previous.value.operator.assignedSkills ?? [], skills)
        const operatorChanged = !isDeepStrictEqual(previous.value.operator.harnessProfileSelection, value.operator.harnessProfileSelection) || skillsChanged || !isDeepStrictEqual(withAdvancedDefaults(previous.value.operator.harness), withAdvancedDefaults(value.operator.harness))
          || (previous.value.operator.showThinking ?? false) !== (value.operator.showThinking ?? false)
          || !isDeepStrictEqual(previous.value.operator.nativeTools, value.operator.nativeTools)
        if (operatorChanged) {
          // Republishing unchanged references still requires authority over their source workspaces.
          for (const reference of skills) requireAuthorization(livePrincipal, 'skills:read', { workspaceId: reference.workspaceId })
          await operatorSkillContent(client, skills, previous.value.operator.assignedSkills)
        }
        const current = operatorChanged ? await operators?.ensureWithClient(client) : undefined
        const result = await this.settings.updateManagedAgentDefaults(client, value, input.expectedRevision)
        if (operators && current && (!isDeepStrictEqual(current.configuration.harnessProfileSelection, value.operator.harnessProfileSelection)
          || !isDeepStrictEqual(current.configuration.harness, value.operator.harness)
          || (current.configuration.showThinking ?? false) !== (value.operator.showThinking ?? false)
          || !isDeepStrictEqual(current.configuration.assignedSkills ?? [], skills)
          || !isDeepStrictEqual(current.configuration.nativeTools, value.operator.nativeTools))) {
          await operators.updateWithClient(
            client, value.operator.harness, current.operator.currentConfigurationVersionId,
            value.operator.showThinking ?? false, skills, value.operator.harnessProfileSelection ?? null,
            value.operator.nativeTools ?? null,
          )
        }
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
        return result
      },
    })
  }

  private async validatePreparedDefaults(client: pg.PoolClient, principal: ManagementPrincipal,
    value: AgentDefaults, previous: AgentDefaults): Promise<void> {
    for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
      const template = value[role], prior = previous[role]
      if (!template) continue
      const configuration = template.harness
      const selection = template.harnessProfileSelection
      const unchanged = !!prior && isDeepStrictEqual(selection, prior.harnessProfileSelection)
        && isDeepStrictEqual(withAdvancedDefaults(configuration), withAdvancedDefaults(prior.harness))
      if (unchanged) continue
      if (this.accountConfigurations) {
        const resolved = await this.accountConfigurations.resolve(configuration, selection, { sql: client })
        if (!isDeepStrictEqual(configuration, resolved)) {
          throw new DomainError('PROVIDER_ACCOUNT_CONFIGURATION_CHANGED',
            'The selected account changed during qualification. Read the account and retry.', 409)
        }
      }
      if (selection) {
        if (!this.profiles) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE',
          'Selected host profile validation is not composed.', 503)
        await this.profiles.validateSelection(principal, selection, configuration, client)
      }
    }
  }

  updateWorkflowDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    commandId: string; expectedRevision?: number | undefined; value: WorkflowDefaults
  }) {
    requireAuthorization(principal, 'settings:update')
    let livePrincipal = principal
    return this.commands.execute({
      principal, source, operation: 'workflow.defaults.update', commandId: input.commandId,
      targetKey: 'workflow-defaults-v1', payload: input,
      authorize: async client => {
        livePrincipal = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(livePrincipal, 'settings:update')
      },
      perform: async client => {
        const result = await this.settings.updateManagedWorkflowDefaults(client, input.value, input.expectedRevision)
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
        return result
      },
    })
  }
}
