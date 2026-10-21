import { realpath } from 'node:fs/promises'
import { workspaceStorageRoot } from '../workspaces/storage.js'
import { randomUUID } from 'node:crypto'

import {
  AgentDefaultsSchema,
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_WORKFLOW_APPROVAL_HANDLER,
  WorkflowDefaultsSchema,
  withAdvancedDefaults,
  type AgentDefaults,
  type WorkflowDefaults,
} from '@foreman-code/contracts'
import type pg from 'pg'
import {
  AgentDefaultsUpdateInputSchema, WorkspaceDefaultsSchema, DEFAULT_WORKSPACE_DEFAULTS, type WorkspaceDefaults,
} from '@foreman-code/contracts/management'
import { GeneralSettingsSchema, DEFAULT_GENERAL_SETTINGS, type GeneralSettings } from '@foreman-code/contracts/management'
import {
  PromptTextSchema, DEFAULT_PROMPT_TEXT, type PromptText, type PromptSettingSnapshot,
} from '@foreman-code/contracts/management'

import { CircleAccountsSchema, DEFAULT_CIRCLE_ACCOUNTS, type CircleAccounts } from '@foreman-code/contracts/management'
import { CircleCreditAllowanceSchema, DEFAULT_CIRCLE_CREDIT_ALLOWANCE,
  type CircleCreditAllowance } from '@foreman-code/contracts/management'
import { RemoteExecutionSettingsSchema, DEFAULT_REMOTE_EXECUTION_SETTINGS,
  type RemoteExecutionSettings } from '@foreman-code/contracts/management'

import { inTransaction, withTransaction } from '../../infrastructure/transaction.js'

import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'

const KEYS = { agents: 'agent-defaults-v1', workflows: 'workflow-defaults-v1', workspaces: 'workspace-defaults-v1' } as const

export interface VersionedSetting<T> { value: T; versionId: string | null; revision: number }

async function readSetting<T>(sql: GraphSqlClient, key: string, schema: { parse(value: unknown): T },
  fallback: T): Promise<VersionedSetting<T>> {
  const result = await sql.query<{ record: unknown; revision: string; current_version_id: string | null }>(
    'select record, revision, current_version_id from application_settings where key = $1', [key],
  )
  const row = result.rows[0]
  if (!row) return { value: schema.parse(fallback), revision: 0, versionId: null }
  return { value: schema.parse(row.record), revision: Number(row.revision), versionId: row.current_version_id }
}

export function readSystemPromptSetting(sql: GraphSqlClient): Promise<PromptSettingSnapshot> {
  return readSetting(sql, 'system-prompt', PromptTextSchema, DEFAULT_PROMPT_TEXT)
}

/** Versioned application defaults. Callers copy values; stored versions never mutate consumers. */
export class PostgresFoundationSettingsRepository {
  constructor(private readonly pool: pg.Pool, private readonly projectRoot?: string) {}

  getSystemPrompt(client?: GraphSqlClient): Promise<VersionedSetting<PromptText>> {
    return readSystemPromptSetting(client ?? this.pool)
  }

  updateSystemPrompt(value: PromptText, expectedRevision: number | undefined, client: pg.ClientBase) {
    return this.write('system-prompt', PromptTextSchema.parse(value), expectedRevision, client)
  }

  getOperatorInitialPrompt(client?: GraphSqlClient): Promise<VersionedSetting<PromptText>> {
    return this.read('operator-initial-prompt', PromptTextSchema, DEFAULT_PROMPT_TEXT, client)
  }

  updateOperatorInitialPrompt(value: PromptText, expectedRevision: number | undefined, client: pg.ClientBase) {
    return this.write('operator-initial-prompt', PromptTextSchema.parse(value), expectedRevision, client)
  }

  getRemoteExecutionSettings(client?: pg.ClientBase): Promise<VersionedSetting<RemoteExecutionSettings>> {
    return this.read('remote-execution-settings', RemoteExecutionSettingsSchema, DEFAULT_REMOTE_EXECUTION_SETTINGS, client)
  }

  updateRemoteExecutionSettings(value: RemoteExecutionSettings, expectedRevision: number | undefined, client: pg.ClientBase) {
    return this.write('remote-execution-settings', RemoteExecutionSettingsSchema.parse(value), expectedRevision, client)
  }

  getGeneralSettings(client?: pg.ClientBase): Promise<VersionedSetting<GeneralSettings>> {
    return this.read('general-settings', GeneralSettingsSchema, DEFAULT_GENERAL_SETTINGS, client)
  }

  updateGeneralSettings(value: GeneralSettings, expectedRevision: number | undefined, client: pg.ClientBase) {
    return this.write('general-settings', GeneralSettingsSchema.parse(value), expectedRevision, client)
  }

  getCircleAccounts(client?: pg.ClientBase): Promise<VersionedSetting<CircleAccounts>> {
    return this.read('circle-accounts', CircleAccountsSchema, DEFAULT_CIRCLE_ACCOUNTS, client)
  }

  updateCircleAccounts(value: CircleAccounts, expectedRevision: number | undefined, client: pg.ClientBase) {
    return this.write('circle-accounts', CircleAccountsSchema.parse(value), expectedRevision, client)
  }

  getCircleCreditAllowance(client?: pg.ClientBase): Promise<VersionedSetting<CircleCreditAllowance>> {
    return this.read('circle-credit-allowance', CircleCreditAllowanceSchema, DEFAULT_CIRCLE_CREDIT_ALLOWANCE, client)
  }

  updateCircleCreditAllowance(value: CircleCreditAllowance, expectedRevision: number | undefined, client: pg.ClientBase) {
    return this.write('circle-credit-allowance', CircleCreditAllowanceSchema.parse(value), expectedRevision, client)
  }

  getAgentDefaults(client?: pg.ClientBase): Promise<VersionedSetting<AgentDefaults>> {
    return this.read(KEYS.agents, AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, client).then((snapshot) => ({
      ...snapshot,
      value: {
        ...(snapshot.value.master ? { master: { ...snapshot.value.master, harness: withAdvancedDefaults(snapshot.value.master.harness) } } : {}),
        orchestrator: { ...snapshot.value.orchestrator, harness: withAdvancedDefaults(snapshot.value.orchestrator.harness) },
        coder: { ...snapshot.value.coder, harness: withAdvancedDefaults(snapshot.value.coder.harness) },
        operator: { ...snapshot.value.operator, harness: withAdvancedDefaults(snapshot.value.operator.harness) },
      },
    }))
  }

  getWorkspaceDefaults(client?: pg.ClientBase): Promise<VersionedSetting<WorkspaceDefaults>> {
    return this.read(KEYS.workspaces, WorkspaceDefaultsSchema, DEFAULT_WORKSPACE_DEFAULTS, client)
      .then(async (snapshot) => {
        let parentPath = snapshot.value.parentPath ?? this.projectRoot ?? workspaceStorageRoot()
        if (this.projectRoot) {
          try {
            parentPath = await realpath(parentPath)
          }
          catch {
            throw new DomainError('WORKSPACE_DEFAULT_UNAVAILABLE',
              'The saved workspace parent folder is unavailable. Restore it or choose another folder in Settings.', 503,
              { parentPath: snapshot.value.parentPath ?? parentPath, revision: snapshot.revision,
                versionId: snapshot.versionId })
          }
        }
        return { ...snapshot, value: { ...snapshot.value, parentPath } }
      })
  }

  async updateWorkspaceDefaults(value: WorkspaceDefaults, expectedRevision: number | undefined, client?: pg.ClientBase): Promise<VersionedSetting<WorkspaceDefaults>> {
    if (!client) return withTransaction(this.pool, (transaction) => this.updateWorkspaceDefaults(value, expectedRevision, transaction))
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['workspace-folder-lifecycle'])
    const accepted = WorkspaceDefaultsSchema.parse(value)
    if (this.projectRoot && accepted.parentPath) {
      accepted.parentPath = await realpath(accepted.parentPath)
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace-folder:${accepted.parentPath}`])
      accepted.parentPath = await realpath(accepted.parentPath)
    }
    return this.write(KEYS.workspaces, accepted, expectedRevision, client)
  }

  getWorkflowDefaults(client?: pg.ClientBase): Promise<VersionedSetting<WorkflowDefaults>> {
    return this.read(KEYS.workflows, WorkflowDefaultsSchema,
      { approvalHandler: DEFAULT_WORKFLOW_APPROVAL_HANDLER }, client)
  }

  updateAgentDefaults(value: AgentDefaults, expectedRevision: number | undefined, client?: pg.ClientBase) {
    const accepted = AgentDefaultsUpdateInputSchema.shape.value.parse(value)
    return this.write(KEYS.agents, accepted, expectedRevision, client)
  }

  updateWorkflowDefaults(value: WorkflowDefaults, expectedRevision: number | undefined, client?: pg.ClientBase) {
    return this.write(KEYS.workflows, WorkflowDefaultsSchema.parse(value), expectedRevision, client)
  }

  updateManagedAgentDefaults(client: pg.PoolClient, value: AgentDefaults, expectedRevision: number | undefined) {
    return this.updateAgentDefaults(value, expectedRevision, client)
  }

  updateManagedWorkflowDefaults(client: pg.PoolClient, value: WorkflowDefaults, expectedRevision: number | undefined) {
    return this.updateWorkflowDefaults(value, expectedRevision, client)
  }

  private async read<T>(key: string, schema: { parse(value: unknown): T }, fallback: T, client?: GraphSqlClient): Promise<VersionedSetting<T>> {
    return readSetting(client ?? this.pool, key, schema, fallback)
  }

  private async write<T>(key: string, value: T, expectedRevision: number | undefined, supplied?: pg.ClientBase): Promise<VersionedSetting<T>> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new DomainError('REVISION_INVALID', 'Expected revision must be a nonnegative integer.', 400)
    }
    return inTransaction(this.pool, supplied, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`setting:${key}`])
      const current = await client.query<{ revision: string }>(
        'select revision from application_settings where key = $1 for update', [key],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (expectedRevision !== undefined && revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Defaults changed since they were read.', 409, { currentRevision: revision })
      const nextRevision = revision + 1
      const versionId = `${key}-v${nextRevision}-${randomUUID()}`
      await client.query(
        `insert into application_setting_versions (id, setting_key, version, record)
         values ($1, $2, $3, $4::jsonb)`, [versionId, key, nextRevision, JSON.stringify(value)],
      )
      await client.query(
        `insert into application_settings (key, record, revision, current_version_id, updated_at)
         values ($1, $2::jsonb, 1, $3, now())
         on conflict (key) do update set record = excluded.record,
           revision = application_settings.revision + 1, current_version_id = excluded.current_version_id,
           updated_at = excluded.updated_at`, [key, JSON.stringify(value), versionId],
      )
      return { value, revision: nextRevision, versionId }
    })
  }
}
