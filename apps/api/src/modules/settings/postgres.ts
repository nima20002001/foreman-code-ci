import {
  DEFAULT_HARNESS_DEFAULTS,
  HarnessDefaultsSchema,
  RetiredOpenCodeConfigurationSchema,
  withAdvancedDefaults,
  type AgentHarness,
  type HarnessDefaults,
} from '@foreman-code/contracts'
import type pg from 'pg'
import type { ConfiguredHarnessInstance } from '../harnesses/instanceRegistry.js'
import { UnavailableHarnessDefaultsSchema } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'

import { DomainError } from '../errors.js'

const SETTINGS_KEY = 'harness-defaults'
/** Stock templates do not prove that native discovery selected a default. */
export const UNAVAILABLE_HARNESS_DEFAULTS_KEY = 'harness-default-model-unavailable'

/** Complete legacy templates on read without changing their explicit permission choice. */
export function normalizeHarnessDefaults(record: unknown): HarnessDefaults {
  const candidate = structuredClone(record === undefined ? DEFAULT_HARNESS_DEFAULTS : record) as HarnessDefaults
  // Startup's native initializer persists actual discovered values. Until it
  // completes, missing legacy fields can still be inventoried without executing.
  for (const harness of ['codex'] as const) {
    if (!candidate[harness]) candidate[harness] = structuredClone(DEFAULT_HARNESS_DEFAULTS[harness]) as never
    else if (typeof candidate[harness].model !== 'string' || !candidate[harness].model.trim()) candidate[harness].model = DEFAULT_HARNESS_DEFAULTS[harness].model
  }
  const defaults = HarnessDefaultsSchema.parse({ codex: candidate.codex,
    ...(candidate.claude ? { claude: candidate.claude } : {}) })
  return { codex: withAdvancedDefaults(defaults.codex),
    ...(defaults.claude ? { claude: withAdvancedDefaults(defaults.claude) } : {}) }
}

export class PostgresSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getHarnessDefaults(): Promise<HarnessDefaults> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from application_settings where key = $1',
      [SETTINGS_KEY],
    )
    return normalizeHarnessDefaults(result.rows[0]?.record)
  }

  async getManagedHarnessDefaults(client?: pg.ClientBase): Promise<{
    defaults: HarnessDefaults; revision: number; unavailable?: AgentHarness[]; retiredDefaults?: ConfiguredHarnessInstance[]
  }> {
    const result = await (client ?? this.pool).query<{ record: unknown; revision: string; unavailable: unknown;
      retired: { opencode?: unknown } | null; retired_revision: string | null }>(
      `select record, revision,
        (select record from application_settings where key = $2) as unavailable,
        (select record from application_settings where key = 'retired-harness-defaults') as retired,
        (select revision from application_settings where key = 'retired-harness-defaults') as retired_revision
       from application_settings where key = $1`,
      [SETTINGS_KEY, UNAVAILABLE_HARNESS_DEFAULTS_KEY],
    )
    const saved = result.rows[0];
    const unavailable = UnavailableHarnessDefaultsSchema.parse(
      ((saved?.unavailable as string[] | undefined) ?? []).filter(harness => harness !== 'opencode'),
    );
    const retiredDefaults: ConfiguredHarnessInstance[] = [];
    if (saved?.retired?.opencode) {
      retiredDefaults.push({
        instanceId: 'local-default:opencode', instanceRevision: String(saved.retired_revision),
        driverId: 'opencode', enabled: false,
        configuration: RetiredOpenCodeConfigurationSchema.parse(saved.retired.opencode),
      });
    }
    return {
      defaults: normalizeHarnessDefaults(result.rows[0]?.record),
      revision: Number(result.rows[0]?.revision ?? 0),
      ...(unavailable.length ? { unavailable } : {}),
      ...(retiredDefaults.length ? { retiredDefaults } : {}),
    }
  }

  async updateManagedHarnessDefaults(
    client: pg.PoolClient,
    input: HarnessDefaults,
    expectedRevision: number | undefined,
    options: { unavailable?: AgentHarness[] } = {},
  ): Promise<{ defaults: HarnessDefaults; revision: number }> {
    const defaults = HarnessDefaultsSchema.parse(input)
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:harness-defaults'])
    const current = await client.query<{ revision: string }>(
      'select revision from application_settings where key = $1 for update', [SETTINGS_KEY],
    )
    const revision = Number(current.rows[0]?.revision ?? 0)
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409, { currentRevision: revision })
    }
    const result = await client.query<{ revision: string }>(
      `insert into application_settings (key, record, revision, updated_at)
       values ($1, $2::jsonb, 1, now())
       on conflict (key) do update set record = excluded.record,
         revision = application_settings.revision + 1, updated_at = excluded.updated_at
       where application_settings.revision = $3
       returning revision`,
      [SETTINGS_KEY, JSON.stringify(defaults), revision],
    )
    if (!result.rows[0]) {
      const latest = await client.query<{ revision: string }>(
        'select revision from application_settings where key = $1', [SETTINGS_KEY],
      )
      throw new DomainError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409, {
        currentRevision: Number(latest.rows[0]?.revision ?? 0),
      })
    }
    const unavailable = UnavailableHarnessDefaultsSchema.parse(options.unavailable ?? [])
    if (unavailable.length) {
      await client.query(`insert into application_settings (key,record,revision,updated_at) values($1,$2::jsonb,1,now())
        on conflict(key) do update set record=excluded.record,revision=application_settings.revision+1,updated_at=excluded.updated_at`,
      [UNAVAILABLE_HARNESS_DEFAULTS_KEY, JSON.stringify(unavailable)])
    } else {
      await client.query('delete from application_settings where key = $1', [UNAVAILABLE_HARNESS_DEFAULTS_KEY])
    }
    return { defaults, revision: Number(result.rows[0].revision) }
  }

  async saveHarnessDefaults(input: HarnessDefaults): Promise<HarnessDefaults> {
    const defaults = HarnessDefaultsSchema.parse(input)
    await withTransaction(this.pool, async client => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:harness-defaults'])
      await client.query(
        `insert into application_settings (key, record, revision, updated_at)
         values ($1, $2::jsonb, 1, now())
         on conflict (key) do update set record = excluded.record,
           revision = application_settings.revision + 1, updated_at = excluded.updated_at`,
        [SETTINGS_KEY, JSON.stringify(defaults)],
      )
      await client.query('delete from application_settings where key = $1', [UNAVAILABLE_HARNESS_DEFAULTS_KEY])
    })
    return defaults
  }
}
