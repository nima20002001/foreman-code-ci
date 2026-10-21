import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import {
  CircleAccountAddInputSchema, CircleAccountRemoveInputSchema, CircleAccountsSchema, ManagedCircleAccountsSchema,
  DEFAULT_CIRCLE_ACCOUNT_ID, type CircleAccount, type CircleAccountAddInput, type CircleAccountRemoveInput,
  type CircleAccounts, type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { CircleAccountRegistry, CircleAccountRegistryChanged, CircleAccountStatusReader } from '../ci-host/circleAccounts.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_BUSY_TICKET } from '../ci-host/deadlines.js'
import type { PostgresFoundationSettingsRepository, VersionedSetting } from './foundation.js'

/** Metadata and command receipts share one transaction; credential files are never mutated here. */
export class CircleAccountsManagementService implements CircleAccountRegistry {
  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly status: CircleAccountStatusReader,
    private readonly changed?: CircleAccountRegistryChanged,
  ) {}

  async list(): Promise<CircleAccount[]> {
    return (await this.settings.getCircleAccounts()).value.accounts
  }

  async get(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.readback(await this.settings.getCircleAccounts())
  }

  async add(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: CircleAccountAddInput) {
    requireAuthorization(principal, 'settings:update')
    const input = CircleAccountAddInputSchema.parse(raw)
    const result = await this.commands.execute({
      principal, source, operation: 'circle.account.add', commandId: input.commandId,
      targetKey: input.account.id, payload: input,
      authorize: client => this.authorize(client, principal),
      perform: async client => {
        await this.lock(client)
        const current = await this.settings.getCircleAccounts(client)
        const existing = current.value.accounts.find(account => account.id === input.account.id)
        if (existing && !isDeepStrictEqual(existing.organizations, input.account.organizations)) {
          await this.requireUnused(client, input.account.id)
        }
        const accounts = current.value.accounts.filter(account => account.id !== input.account.id)
        accounts.push(input.account)
        accounts.sort((left, right) => {
          if (left.id === DEFAULT_CIRCLE_ACCOUNT_ID) return -1
          if (right.id === DEFAULT_CIRCLE_ACCOUNT_ID) return 1
          return left.id.localeCompare(right.id)
        })
        const parsed = CircleAccountsSchema.safeParse({ accounts })
        if (!parsed.success) {
          throw new DomainError('CIRCLE_ACCOUNT_INVALID',
            'Keep the default login and at most one second login with distinct organization bindings.', 400)
        }
        const saved = await this.settings.updateCircleAccounts(parsed.data, input.expectedRevision, client)
        return saved
      },
    })
    if (!result.replayed) await this.changed?.(input.account.id)
    return { ...result, value: await this.readback(result.value) }
  }

  async remove(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: CircleAccountRemoveInput) {
    requireAuthorization(principal, 'settings:update')
    const input = CircleAccountRemoveInputSchema.parse(raw)
    const result = await this.commands.execute({
      principal, source, operation: 'circle.account.remove', commandId: input.commandId,
      targetKey: input.id, payload: input,
      authorize: client => this.authorize(client, principal),
      perform: async client => {
        await this.lock(client)
        const current = await this.settings.getCircleAccounts(client)
        await this.requireUnused(client, input.id)
        const saved = await this.settings.updateCircleAccounts({
          accounts: current.value.accounts.filter(account => account.id !== input.id),
        }, input.expectedRevision, client)
        return saved
      },
    })
    if (!result.replayed) await this.changed?.(input.id)
    return { ...result, value: await this.readback(result.value) }
  }

  private async readback(snapshot: VersionedSetting<CircleAccounts>) {
    const accounts = await Promise.all(snapshot.value.accounts.map(async saved => {
      const { id, label, role, organizations } = saved
      const account = { id, label, role, organizations }
      return { ...await this.status.read(account), ...account }
    }))
    return ManagedCircleAccountsSchema.parse({ ...snapshot, value: { accounts } })
  }

  private async authorize(client: pg.PoolClient, principal: ManagementPrincipal) {
    requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
  }

  private async lock(client: pg.ClientBase) {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['circle-accounts'])
  }

  private async requireUnused(client: pg.ClientBase, id: string) {
    const result = await client.query(
      `select id from ci_runs where (state = 'queued' or ${CI_BUSY_TICKET} or record->>'collection' = 'pending')
       and (record #>> '{computer,hostRef,circleAccountId}' = $1
         or record #>> '{smokeComputer,circleAccountId}' = $1
         or record #>> '{setupRetry,failedComputer,circleAccountId}' = $1
         or exists (select 1 from jsonb_array_elements(coalesce(record->'executionHistory','[]'::jsonb)) as history
           where history #>> '{hostRef,circleAccountId}' = $1)
         or split_part(host_key, ':', 3) like $2
         or split_part(record->>'dispatchHostKey', ':', 3) like $2
         or split_part(record->>'plannedHostKey', ':', 3) like $2
         or ($1 = 'default' and (record #>> '{computer,hostRef,provider}' = 'circleci'
           and coalesce(record #>> '{computer,hostRef,circleAccountId}', 'default') = 'default'
           or record #>> '{smokeComputer,provider}' = 'circleci'
           and coalesce(record #>> '{smokeComputer,circleAccountId}', 'default') = 'default'
           or record #>> '{setupRetry,failedComputer,provider}' = 'circleci'
           and coalesce(record #>> '{setupRetry,failedComputer,circleAccountId}', 'default') = 'default'
           or exists (select 1 from jsonb_array_elements(coalesce(record->'executionHistory','[]'::jsonb)) as history
             where history #>> '{hostRef,provider}' = 'circleci'
               and coalesce(history #>> '{hostRef,circleAccountId}', 'default') = 'default')
           or split_part(host_key, ':', 3) ~ '^circleci(@|$)'
           or split_part(record->>'dispatchHostKey', ':', 3) ~ '^circleci(@|$)'
           or split_part(record->>'plannedHostKey', ':', 3) ~ '^circleci(@|$)')))
       limit 1`, [id, `circleci~${id}@%`],
    )
    if (result.rows.length) {
      throw new DomainError('CIRCLE_ACCOUNT_IN_USE',
        'This CircleCI account has assigned jobs or results awaiting collection. Wait before changing its bindings or removing it.', 409)
    }
  }
}
