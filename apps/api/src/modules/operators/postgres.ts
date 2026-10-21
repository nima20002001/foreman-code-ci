import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'

import {
  HarnessConfigurationSchema,
  RETIRED_OPENCODE_MESSAGE,
  OperatorAgentSchema,
  OperatorConfigurationVersionSchema,
  type HarnessConfiguration,
  type OperatorAgent,
  type OperatorConfigurationVersion,
  type WorkspaceSkillReference,
  type NativeTools,
} from '@foreman-code/contracts'
import type pg from 'pg'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { canonicalJsonNumericKeysFirstLegacy, canonicalJsonValueLegacy } from '@foreman-code/contracts/canonical-json'

import { inTransaction } from '../../infrastructure/transaction.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'

import { DomainError } from '../errors.js'
import { harnessProfileSelectionConflict } from '../harnesses/instanceSettings/selectionConflict.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'
import { resolveWorkspaceSkills } from '../skills/catalog.js'
import { composeInstructionText, instructionsTooLarge } from '../skills/instructions.js'

const OPERATOR_ID = 'application-operator'

// Sort provider-owned map keys too: schema parsing normalizes fields, not record key order.
// Persisted configuration hashes depend on the frozen numeric-keys-first legacy form.
function hash(value: unknown) { return `sha256:${createHash('sha256').update(canonicalJsonNumericKeysFirstLegacy(value)).digest('hex')}` }

function acceptedConfiguration(value: HarnessConfiguration): HarnessConfiguration {
  if (value.harness === 'opencode') throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  // Persisted settings do not grant execution; admission validates the selected native profile.
  return HarnessConfigurationSchema.parse(value)
}

/** Pins exact skill snapshots for the Operator. Previously pinned references stay valid if archived later. */
export async function operatorSkillContent(client: pg.ClientBase, references: readonly WorkspaceSkillReference[] | undefined,
  retained: readonly WorkspaceSkillReference[] = []) {
  if (!references?.length) return {}
  const content = { assignedSkills: [...references], resolvedSkills: await resolveWorkspaceSkills(client, references, retained), instructionDelivery: 'native-v1' as const }
  if (instructionsTooLarge(composeInstructionText(content))) {
    throw new DomainError('AGENT_INSTRUCTIONS_TOO_LARGE', 'Operator skills exceed the 512 KiB limit. Remove skills or shorten them.', 400)
  }
  return content
}

export class PostgresOperatorRepository {
  constructor(private readonly pool: pg.Pool, private readonly accountConfigurations?: ProviderAccountConfigurationService) {}

  /** Read-only inspection must not create an Operator before a conversation exists. */
  async inspectionConfiguration(expectedDefaultsRevision?: number): Promise<OperatorConfigurationVersion> {
    const found = await this.pool.query<{ record: unknown; defaults_revision: string | number }>(
      `select c.record,coalesce((select revision from application_settings where key='agent-defaults-v1'),0) as defaults_revision
       from application_operators o join operator_configuration_versions c
       on c.id=o.current_configuration_version_id where o.id=$1`, [OPERATOR_ID])
    if (found.rows[0]) {
      if (expectedDefaultsRevision !== undefined && Number(found.rows[0].defaults_revision) !== expectedDefaultsRevision) {
        throw new DomainError('OPERATOR_DEFAULTS_CHANGED', 'Operator defaults changed. Refresh the saved settings before sending.', 409)
      }
      return OperatorConfigurationVersionSchema.parse(found.rows[0].record)
    }
    const snapshot = await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults()
    if (expectedDefaultsRevision !== undefined && snapshot.revision !== expectedDefaultsRevision) {
      throw new DomainError('OPERATOR_DEFAULTS_CHANGED', 'Operator defaults changed. Refresh the saved settings before sending.', 409)
    }
    const defaults = snapshot.value.operator
    return OperatorConfigurationVersionSchema.parse({ id: `${OPERATOR_ID}-inspection`, operatorId: OPERATOR_ID, version: 1,
      harness: defaults.harness, showThinking: defaults.showThinking ?? false,
      ...(defaults.nativeTools ? { nativeTools: defaults.nativeTools } : {}),
      ...(defaults.harnessProfileSelection ? { harnessProfileSelection: defaults.harnessProfileSelection } : {}),
      contentHash: defaults.harnessProfileSelection || defaults.nativeTools
        ? hash({ harness: defaults.harness, harnessProfileSelection: defaults.harnessProfileSelection, nativeTools: defaults.nativeTools }) : hash(defaults.harness),
      createdAt: new Date().toISOString() })
  }

  async ensure(supplied?: pg.ClientBase): Promise<{ operator: OperatorAgent; configuration: OperatorConfigurationVersion }> {
    return inTransaction(this.pool, supplied, (client) => this.ensureWithClient(client))
  }

  async ensureWithClient(client: pg.ClientBase): Promise<{ operator: OperatorAgent; configuration: OperatorConfigurationVersion }> {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
    const found = await client.query<{ record: unknown; configuration: unknown }>(
      `select o.record, c.record as configuration from application_operators o
       join operator_configuration_versions c on c.id = o.current_configuration_version_id where o.id = $1`, [OPERATOR_ID],
    )
    if (found.rows[0]) {
      return { operator: OperatorAgentSchema.parse(found.rows[0].record), configuration: OperatorConfigurationVersionSchema.parse(found.rows[0].configuration) }
    }
    const createdAt = new Date().toISOString()
    const defaults = (await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults(client)).value.operator
    const requested = this.accountConfigurations
      ? await this.accountConfigurations.resolve(defaults.harness, defaults.harnessProfileSelection, { sql: client })
      : defaults.harness
    const harness = acceptedConfiguration(requested)
    const nativePolicy = defaults.nativeTools ? { nativeTools: defaults.nativeTools } : {}
    const profile = defaults.harnessProfileSelection ? { harnessProfileSelection: defaults.harnessProfileSelection } : {}
    // Saved defaults were authorized and resolved when saved; keep those exact references.
    const skills = await operatorSkillContent(client, defaults.assignedSkills, defaults.assignedSkills)
    const content = { harness: canonicalJsonValueLegacy(harness), ...skills, ...profile, ...nativePolicy }
    const contentHash = 'assignedSkills' in skills || defaults.harnessProfileSelection || defaults.nativeTools
      ? `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}` : hash(harness)
    const configuration = OperatorConfigurationVersionSchema.parse({
      id: `${OPERATOR_ID}-config-v1-${randomUUID()}`, operatorId: OPERATOR_ID, version: 1,
      harness, showThinking: defaults.showThinking ?? false, ...skills, ...profile, ...nativePolicy,
      contentHash, createdAt,
    })
    const operator = OperatorAgentSchema.parse({
      id: OPERATOR_ID, role: 'operator', name: 'Operator', currentConfigurationVersionId: configuration.id,
      createdAt, updatedAt: createdAt,
    })
    await client.query(
      'insert into application_operators (id, current_configuration_version_id, record) values ($1, $2, $3::jsonb)',
      [operator.id, configuration.id, JSON.stringify(operator)],
    )
    await client.query(
      `insert into operator_configuration_versions (id, operator_id, version, record)
       values ($1, $2, $3, $4::jsonb)`,
      [configuration.id, operator.id, configuration.version, JSON.stringify(configuration)],
    )
    return { operator, configuration }
  }

  async update(input: HarnessConfiguration, expectedConfigurationVersionId: string, supplied?: pg.ClientBase) {
    const harness = acceptedConfiguration(input)
    return inTransaction(this.pool, supplied, (client) => this.updateWithClient(client, harness, expectedConfigurationVersionId))
  }

  async updateWithClient(client: pg.ClientBase, harness: HarnessConfiguration, expectedConfigurationVersionId: string, showThinking = false,
    assignedSkills?: readonly WorkspaceSkillReference[], harnessProfileSelection?: HarnessProfileSelection | null,
    nativeTools?: NativeTools | null) {
      harness = acceptedConfiguration(harness)
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
      const row = await client.query<{ record: unknown; current_configuration_version_id: string }>(
        'select record, current_configuration_version_id from application_operators where id = $1 for update', [OPERATOR_ID],
      )
      const operator = OperatorAgentSchema.parse(row.rows[0]?.record)
      if (row.rows[0]?.current_configuration_version_id !== expectedConfigurationVersionId) {
        throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'Operator settings changed since they were read.', 409)
      }
      const previous = (await client.query<{ record: unknown }>('select record from operator_configuration_versions where id = $1', [expectedConfigurationVersionId])).rows[0]
      const previousConfiguration = previous ? OperatorConfigurationVersionSchema.parse(previous.record) : undefined
      const policy = nativeTools === null ? undefined : nativeTools ?? previousConfiguration?.nativeTools
      const nativePolicy = policy ? { nativeTools: policy } : {}
      const selection = harnessProfileSelection === null ? undefined : harnessProfileSelection ?? previousConfiguration?.harnessProfileSelection
      if (this.accountConfigurations) {
        harness = await this.accountConfigurations.resolve(harness, selection, { sql: client })
      }
      if (selection && harnessProfileSelection === undefined && !isDeepStrictEqual(previousConfiguration?.harness, harness)) {
        throw harnessProfileSelectionConflict(
          'The harness configuration changed while retaining the previous profile selection.')
      }
      const skills = await operatorSkillContent(client, assignedSkills, previousConfiguration?.assignedSkills ?? [])
      const versionRow = await client.query<{ version: number }>('select coalesce(max(version), 0) + 1 as version from operator_configuration_versions where operator_id = $1', [OPERATOR_ID])
      const version = Number(versionRow.rows[0]?.version ?? 1)
      const createdAt = new Date().toISOString()
      const profile = selection ? { harnessProfileSelection: selection } : {}
      const content = { harness: canonicalJsonValueLegacy(harness), showThinking, ...skills, ...profile, ...nativePolicy }
      const contentHash = `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`
      const configuration = OperatorConfigurationVersionSchema.parse({
        id: `${OPERATOR_ID}-config-v${version}-${randomUUID()}`, operatorId: OPERATOR_ID, version,
        harness, showThinking, ...skills, ...profile, ...nativePolicy, contentHash, createdAt,
      })
      await client.query('insert into operator_configuration_versions (id, operator_id, version, record) values ($1,$2,$3,$4::jsonb)', [configuration.id, OPERATOR_ID, version, JSON.stringify(configuration)])
      const next = OperatorAgentSchema.parse({ ...operator, currentConfigurationVersionId: configuration.id, updatedAt: createdAt })
      await client.query('update application_operators set current_configuration_version_id=$2, record=$3::jsonb, updated_at=now() where id=$1', [OPERATOR_ID, configuration.id, JSON.stringify(next)])
      return { operator: next, configuration }
  }
}
