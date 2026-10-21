import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, applyOperatorChatSettings, OperatorConfigurationVersionSchema, withAdvancedDefaults,
  type HarnessConfiguration, type OperatorConfigurationVersion, type SendOperatorMessageRequest } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'

type Queryable = Pick<pg.PoolClient, 'query'>
async function version(query: Queryable, id: string): Promise<OperatorConfigurationVersion> {
  const result = await query.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1', [id])
  if (!result.rows[0]) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The selected Operator configuration no longer exists.', 409)
  return OperatorConfigurationVersionSchema.parse(result.rows[0].record)
}

/** Full saved template, never generic per-provider defaults. This method does no writes. */
export async function operatorMessageBase(query: Queryable, current: OperatorConfigurationVersion,
  input: SendOperatorMessageRequest): Promise<OperatorConfigurationVersion> {
  if (input.configurationVersionId && input.configurationVersionId !== current.id) throw new DomainError('CONVERSATION_REVISION_CONFLICT',
    'The source conversation configuration changed before admission.', 409)
  if (!input.settings || input.settings.harness === current.harness.harness) return current
  await query.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
  const defaults = (await query.query<{ record: unknown; revision: number }>(
    'select record,revision from application_settings where key=$1 for share', ['agent-defaults-v1'])).rows[0]
  const preset = AgentDefaultsSchema.parse(defaults?.record ?? DEFAULT_AGENT_DEFAULTS).operator
  if (input.defaultsRevision === undefined || input.defaultsRevision !== Number(defaults?.revision ?? 0)
    || preset.harness.harness !== input.settings.harness) throw new DomainError('CONVERSATION_REVISION_CONFLICT',
    'Operator defaults changed before this handoff. Review the current defaults before sending a new command.', 409)
  const found = await query.query<{ record: unknown }>(`select c.record from application_operators o
    join operator_configuration_versions c on c.id=o.current_configuration_version_id where o.id=$1 for share of o`, [current.operatorId])
  if (!found.rows[0]) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'Saved Operator defaults are unavailable. Refresh Settings before sending.', 409)
  const selected = OperatorConfigurationVersionSchema.parse(found.rows[0].record)
  if (!isDeepStrictEqual(withAdvancedDefaults(selected.harness), withAdvancedDefaults(preset.harness))
    || !isDeepStrictEqual(selected.harnessProfileSelection, preset.harnessProfileSelection)
    || !isDeepStrictEqual(selected.assignedSkills ?? [], preset.assignedSkills ?? [])) throw new DomainError('OPERATOR_DEFAULTS_CHANGED',
    'The saved Operator configuration does not match the reviewed defaults. Refresh Settings before sending.', 409)
  if (selected.operatorId !== current.operatorId) throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'The configuration belongs to a different Operator.', 409)
  if (input.settings && input.settings.harness !== selected.harness.harness) {
    throw new DomainError('OPERATOR_DEFAULTS_CHANGED', 'The saved Operator harness changed. Refresh its settings before reserving a new message; an existing command will not be rewritten.', 409)
  }
  return selected
}

/** Called only after the conversation lock, receipt comparison and idle admission check. */
export async function acceptOperatorConfiguration(query: Queryable, current: OperatorConfigurationVersion,
  input: SendOperatorMessageRequest, prior: { operator_configuration_version_id: string | null } | undefined,
  suppliedHarness?: HarnessConfiguration, validate?: (configuration: OperatorConfigurationVersion) => void,
  accounts?: ProviderAccountConfigurationService,
  preparedProfile?: HarnessProfileSelection,
): Promise<OperatorConfigurationVersion> {
  if (prior) {
    if (!prior.operator_configuration_version_id) throw new DomainError('OPERATOR_RETRY_CONFIGURATION_UNKNOWN',
      'This older retry has no recorded execution configuration. Its payload is retained, but it cannot be relaunched with guessed permissions. Review the original request before sending a new message.', 409)
    const accepted = await version(query, prior.operator_configuration_version_id)
    if (accepted.operatorId !== current.operatorId) throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'The accepted configuration belongs to a different Operator.', 409)
    validate?.(accepted)
    return accepted
  }
  const base = await operatorMessageBase(query, current, input)
  const settings = suppliedHarness ?? (input.settings ? applyOperatorChatSettings(base.harness, input.settings) : base.harness)
  const hasAccount = settings.harness !== 'opencode' && settings.accountId !== undefined
  const requested = accounts && hasAccount
    ? await accounts.resolve(settings, preparedProfile ?? base.harnessProfileSelection, { sql: query }) : settings
  const harness = isDeepStrictEqual(withAdvancedDefaults(base.harness), withAdvancedDefaults(requested)) ? base.harness : requested
  if (base.harnessProfileSelection && !preparedProfile && !isDeepStrictEqual(base.harness, harness)) {
    throw new DomainError('HARNESS_PROFILE_SELECTION_CONFLICT',
      'This Operator conversation is pinned to its saved harness profile and model. Send with the pinned settings, '
      + 'or save the desired defaults and start a new conversation.', 409)
  }
  const showThinking = input.settings?.showThinking ?? base.showThinking ?? false
  const harnessProfileSelection = preparedProfile ?? base.harnessProfileSelection
  if (JSON.stringify(base.harness) === JSON.stringify(harness) && showThinking === (base.showThinking ?? false)
    && isDeepStrictEqual(harnessProfileSelection, base.harnessProfileSelection)) {
    validate?.(base)
    return base
  }
  const candidate = { ...base, harness, showThinking,
    ...(harnessProfileSelection ? { harnessProfileSelection } : {}) }
  validate?.(candidate)
  await query.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
  const latest = await query.query<{ version: number }>('select coalesce(max(version),0)+1 as version from operator_configuration_versions where operator_id=$1', [base.operatorId])
  const accepted = OperatorConfigurationVersionSchema.parse({ ...candidate, id: randomUUID(), version: Number(latest.rows[0]!.version),
    contentHash: `sha256:${createHash('sha256').update(JSON.stringify({ harness, showThinking,
      ...(harnessProfileSelection ? { harnessProfileSelection } : {}) })).digest('hex')}`, createdAt: new Date().toISOString() })
  await query.query('insert into operator_configuration_versions (id,operator_id,version,record) values ($1,$2,$3,$4::jsonb)',
    [accepted.id, accepted.operatorId, accepted.version, JSON.stringify(accepted)])
  return accepted
}
