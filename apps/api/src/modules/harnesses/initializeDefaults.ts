import { asRecord } from '../../shared/records.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, HarnessDefaultsSchema, operatorHarnessDefaults,
  type HarnessDefaults, type AgentHarness } from '@foreman-code/contracts'
import { UnavailableHarnessDefaultsSchema, type HarnessOptions } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'
import { retryStartupDatabase } from '../../infrastructure/startupDatabase.js'
import { latestNativeModel, nativeModelDefaults } from './modelDefaults.js'
import { DomainError } from '../errors.js'
import { detectedClaudeProfilePath } from './claudeSdk/profilePath.js'
import { UNAVAILABLE_HARNESS_DEFAULTS_KEY } from '../settings/postgres.js'
import { ClaudeFullAccessConfigurationSchema } from '@foreman-code/contracts/claude'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

const missingModel = (value: unknown) => typeof asRecord(value).model !== 'string' || !String(asRecord(value).model).trim()
const liveUnavailableDefaults = (value: unknown) => UnavailableHarnessDefaultsSchema.parse(
  Array.isArray(value) ? value.filter(harness => harness !== 'opencode') : value)

/** Startup initialization is persisted once under the same settings locks.
 * Existing explicit model/effort/access choices and all immutable pins survive. */
export async function initializeNativeDefaults(input: {
  pool: pg.Pool
  options(harness: AgentHarness): Promise<HarnessOptions>
  appMcpEndpoint: string
  signal?: AbortSignal
}) {
  const initial = await retryStartupDatabase(() => input.pool.query<{ key: string; record: unknown }>(
    'select key,record from application_settings where key=any($1::text[])',
    [['harness-defaults', 'agent-defaults-v1', UNAVAILABLE_HARNESS_DEFAULTS_KEY]]), { signal: input.signal })
  const prior = new Map(initial.rows.map(row => [row.key, row.record]))
  const priorHarnesses = asRecord(prior.get('harness-defaults'))
  const required = new Set<AgentHarness>((['codex', 'claude'] as const).filter(harness => missingModel(priorHarnesses[harness])))
  for (const harness of liveUnavailableDefaults(prior.get(UNAVAILABLE_HARNESS_DEFAULTS_KEY) ?? [])) {
    // A discovered Claude model cannot resolve an unsupported access choice.
    if (harness === 'claude' && !missingModel(priorHarnesses.claude)
      && !ClaudeFullAccessConfigurationSchema.safeParse(priorHarnesses.claude).success) continue
    required.add(harness)
  }
  const priorAgents = asRecord(prior.get('agent-defaults-v1'))
  for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
    if (role === 'master' && !priorAgents.master) continue
    const configuration = asRecord(asRecord(priorAgents[role]).harness)
    if (configuration.harness === 'opencode') continue
    if (missingModel(configuration)) required.add((configuration.harness ?? (DEFAULT_AGENT_DEFAULTS[role] ?? DEFAULT_AGENT_DEFAULTS.orchestrator).harness.harness) as AgentHarness)
  }
  const pending = [...required]
  const available = new Map<AgentHarness, HarnessOptions>()
  await Promise.all(pending.map(async harness => {
    let options: HarnessOptions
    try {
      options = await input.options(harness)
    } catch (error) {
      logIgnoredError('harness', 'discover native defaults', error, { harness })
      // An absent or unauthenticated installation remains unconfigured.
      return
    }
    if (!options.authenticated || !options.models.length) return
    try {
      latestNativeModel(options)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'HARNESS_MODEL_DEFAULT_UNAVAILABLE') return
      throw error
    }
    available.set(harness, options)
  }))
  return retryStartupDatabase(() => withTransaction(input.pool, async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:harness-defaults'])
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:agent-defaults-v1'])
    const current = await client.query<{ key: string; record: unknown; revision: string }>(
      'select key,record,revision from application_settings where key=any($1::text[]) for update',
      [['harness-defaults', 'agent-defaults-v1', UNAVAILABLE_HARNESS_DEFAULTS_KEY]])
    const rows = new Map(current.rows.map(row => [row.key, row]))
    const raw = rows.get('harness-defaults')?.record
    const priorUnavailable = liveUnavailableDefaults(rows.get(UNAVAILABLE_HARNESS_DEFAULTS_KEY)?.record ?? [])
    const unavailable = new Set<AgentHarness>(priorUnavailable)
    const savedHarnesses = asRecord(raw)
    const next: HarnessDefaults = {
      codex: { ...DEFAULT_HARNESS_DEFAULTS.codex, ...asRecord(savedHarnesses.codex) },
      ...(savedHarnesses.claude ? { claude: savedHarnesses.claude as NonNullable<HarnessDefaults['claude']> } : {}),
    }
    for (const harness of pending) {
      if (!missingModel(asRecord(raw)[harness]) && !unavailable.has(harness)) continue
      const options = available.get(harness)
      if (!options) {
        if (harness !== 'claude' || asRecord(raw).claude) unavailable.add(harness)
        continue
      }
      const base = harness === 'claude' ? { harness: 'claude' as const, model: 'default', configDirectory: detectedClaudeProfilePath(), authMode: 'subscription' as const,
        permissionMode: 'default' as const, sandbox: 'read-only' as const, tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'], permissionRules: [], instructions: '',
        mcpServers: { 'foreman-code': { type: 'http' as const, url: input.appMcpEndpoint } } } : DEFAULT_HARNESS_DEFAULTS[harness]
      next[harness] = nativeModelDefaults({ ...base, ...asRecord(asRecord(raw)[harness]) } as typeof base, options) as never
      unavailable.delete(harness)
    }
    const defaults = HarnessDefaultsSchema.parse(next)
    if (defaults.claude && !ClaudeFullAccessConfigurationSchema.safeParse(defaults.claude).success) {
      unavailable.add('claude')
    }
    const save = async (key: string, value: unknown, versioned: boolean) => {
      const revision = Number(rows.get(key)?.revision ?? 0) + 1
      const versionId = versioned ? `${key}-v${revision}-${randomUUID()}` : null
      if (versionId) await client.query('insert into application_setting_versions(id,setting_key,version,record) values($1,$2,$3,$4::jsonb)',
        [versionId, key, revision, JSON.stringify(value)])
      await client.query(`insert into application_settings(key,record,revision,current_version_id,updated_at) values($1,$2::jsonb,$3,$4,now())
        on conflict(key) do update set record=excluded.record,revision=excluded.revision,current_version_id=excluded.current_version_id,updated_at=excluded.updated_at`,
      [key, JSON.stringify(value), revision, versionId])
      await client.query("insert into management_audit(principal_id,source,action,target_key,outcome,details) values(null,'system','harness.defaults.initialize',$1,'allowed',$2::jsonb)",
        [key, JSON.stringify({ revision, initializedHarnesses: [...available.keys()], unavailableHarnesses: [...unavailable] })])
    }
    const unavailableDefaults = UnavailableHarnessDefaultsSchema.parse([...unavailable].sort())
    const availabilityChanged = !isDeepStrictEqual(priorUnavailable, unavailableDefaults)
    if (!isDeepStrictEqual(raw ?? DEFAULT_HARNESS_DEFAULTS, defaults) || availabilityChanged) {
      await save('harness-defaults', defaults, false)
    }
    if (availabilityChanged) await save(UNAVAILABLE_HARNESS_DEFAULTS_KEY, unavailableDefaults, false)
    const rawAgents = rows.get('agent-defaults-v1')?.record
    const agents = { ...DEFAULT_AGENT_DEFAULTS, ...asRecord(rawAgents) }
    let changed = false
    for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
      if (role === 'master' && !asRecord(rawAgents).master) continue
      const saved = asRecord(asRecord(rawAgents)[role]), configuration = asRecord(saved.harness)
      if (rawAgents !== undefined && !missingModel(configuration)) continue
      const template = agents[role] ?? DEFAULT_AGENT_DEFAULTS.orchestrator
      const harness = (configuration.harness ?? template.harness.harness) as AgentHarness
      const model = defaults[harness]
      if (!model || !available.has(harness) || unavailable.has(harness)) continue
      const base = template.harness.harness === harness ? template.harness : role === 'operator' ? operatorHarnessDefaults(model) : model
      agents[role] = { ...template, ...saved, harness: nativeModelDefaults({ ...base, ...configuration } as typeof base, available.get(harness)!) } as never
      changed = true
    }
    if (changed) await save('agent-defaults-v1', AgentDefaultsSchema.parse(agents), true)
    return defaults
  }), { signal: input.signal })
}
