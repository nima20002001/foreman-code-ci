import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { inTransaction } from '../src/infrastructure/transaction.js'
import { providerAccountsMigration } from '../src/modules/provider-accounts/migration.js'
import { LocalProviderCredentials } from '../src/modules/provider-accounts/localCredentials.js'
import { ProviderAccountsRepository } from '../src/modules/provider-accounts/repository.js'
import { ProviderAccountsService, type ProviderAccountOperationNativePort } from '../src/modules/provider-accounts/service.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator, commandInputHash } from '../src/modules/commands/postgres.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
beforeAll(async () => {
  database = await currentDatabase({ beforeMigration: providerAccountsMigration.version })
}, 30_000)

it('migrates account metadata additively and retains legacy profiles, historical hashes, tombstones and original operations', async () => {
  const db = database
  try {
    const migrationIndex = migrations.findIndex(migration => migration.version === providerAccountsMigration.version)
    const appliedBefore = await db.pool.query<{ version: number }>('select version from application_migrations')
    expect(appliedBefore.rows.map(row => row.version).sort((a, b) => a - b))
      .toEqual(migrations.slice(0, migrationIndex).map(migration => migration.version).sort((a, b) => a - b))
    const credentials = new LocalProviderCredentials(join(db.directory, 'accounts'))
    const repository = new ProviderAccountsRepository(db.pool, () => credentials.hostId())
    const account: ProviderAccount = { id: randomUUID(), provider: 'codex', name: 'Legacy account', authMode: 'subscription',
      isDefault: true, status: 'signed-out', identity: null, revision: 1 }
    await credentials.create(account)
    const legacyMetadata = { revision: 1, accounts: [account] }
    const settingKey = await repository.key()
    const settingVersionId = randomUUID()
    await db.pool.query('insert into application_setting_versions(id,setting_key,version,record) values($1,$2,1,$3::jsonb)',
      [settingVersionId, settingKey, JSON.stringify(legacyMetadata)])
    await db.pool.query('insert into application_settings(key,record,revision,current_version_id) values($1,$2::jsonb,1,$3)',
      [settingKey, JSON.stringify(legacyMetadata), settingVersionId])
    const owner = await new PostgresAccessService(db.pool).issue({ name: 'Migration caller', audience: 'operator',
      expiresAt: new Date('2099-01-01'), grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
    const commands = new PostgresCommandCoordinator(db.pool)
    const historicalCommand = { commandId: randomUUID(), savedProfile: 'original-profile' }
    const historicalReceipt = await commands.execute({ principal: owner.principal, source: 'http', operation: 'saved-profile',
      commandId: historicalCommand.commandId, targetKey: 'legacy-configuration', payload: historicalCommand,
      perform: async () => ({ nativeSessionId: 'original-session', result: 'original-result' }) })
    await applyApplicationMigrations(db.pool)
    const native: ProviderAccountOperationNativePort = { status: async () => ({ status: 'signed-out', identity: null }),
      login: async () => {}, logout: async () => {}, cancelLogin: async () => {}, close: async () => {},
      prepareAuthentication: async input => ({ operationId: input.operation.id, binding: input.operation.binding,
        generation: 1, sequence: 1, state: 'awaiting-human', nativeClosed: false }),
      observeAuthentication: async input => ({ operationId: input.operation.id, binding: input.operation.binding,
        generation: 1, sequence: input.operation.nativeSequence + 1, state: 'outcome-unknown', nativeClosed: false }) }
    const service = () => new ProviderAccountsService(db.pool, new ProviderAccountsRepository(db.pool,
      () => credentials.hostId()), credentials, native, commands)
    const accounts = service()
    const migrated = await accounts.get(owner.principal, { accountId: account.id })
    expect(migrated).toMatchObject(account)
    expect(migrated.binding).toMatchObject({ accountId: account.id, subject: null, profileRef: account.id })
    const legacy = await inTransaction(db.pool, undefined, sql => accounts.acceptedBindings.accept(sql,
      'run-node', 'legacy-run:node', DEFAULT_HARNESS_DEFAULTS.codex))
    const pinned = await inTransaction(db.pool, undefined, sql => accounts.acceptedBindings.accept(sql,
      'run-node', 'accepted-run:node', { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: account.id }))
    const second = (await accounts.create(owner.principal, 'http', { commandId: randomUUID(), expectedRevision: 1,
      provider: 'codex', authMode: 'subscription', name: 'Second' })).value.accounts[1]!
    await accounts.setDefault(owner.principal, 'http', second.id, { commandId: randomUUID(), expectedRevision: 2 })
    expect(await service().runtimeBinding('run-node', 'legacy-run:node', DEFAULT_HARNESS_DEFAULTS.codex)).toEqual(legacy)
    expect(legacy).toMatchObject({ kind: 'legacy-profile', historicalSubject: 'unknown' })
    const auth = await accounts.prepareAuthentication(owner.principal, 'http', second.id,
      { commandId: randomUUID(), expectedRevision: 3, intent: 'sign-in' })
    await accounts.remove(owner.principal, 'http', account.id, { commandId: randomUUID(), expectedRevision: 4 })
    expect(await service().runtimeBinding('run-node', 'accepted-run:node', DEFAULT_HARNESS_DEFAULTS.codex)).toEqual(pinned)
    expect((await service().get(owner.principal, { accountId: account.id })).removedAt).toEqual(expect.any(String))
    expect(await service().authenticationStatus(owner.principal, { operationId: auth.value.id }))
      .toMatchObject({ id: auth.value.id, commandId: auth.value.commandId, binding: auth.value.binding })
    const historical = (await db.pool.query<{ record: unknown }>(
      'select record from application_setting_versions where id=$1', [settingVersionId])).rows[0]!.record
    expect(historical).toEqual(legacyMetadata)
    const replay = await commands.execute({ principal: owner.principal, source: 'mcp', operation: 'saved-profile',
      commandId: historicalCommand.commandId, targetKey: 'legacy-configuration', payload: historicalCommand,
      perform: async () => { throw new Error('Historical command replay must not create another session') } })
    expect(replay).toEqual({ value: historicalReceipt.value, replayed: true })
    const receipt = (await db.pool.query<{ input_hash: string }>(
      'select input_hash from management_command_receipts where principal_id=$1 and command_id=$2',
      [owner.principal.id, historicalCommand.commandId])).rows[0]!
    expect(receipt.input_hash).toBe(commandInputHash(historicalCommand))
    await applyApplicationMigrations(db.pool)
    expect(await service().runtimeBinding('run-node', 'accepted-run:node', DEFAULT_HARNESS_DEFAULTS.codex))
      .toEqual(pinned)
    expect(await commands.execute({ principal: owner.principal, source: 'mcp', operation: 'saved-profile',
      commandId: historicalCommand.commandId, targetKey: 'legacy-configuration', payload: historicalCommand,
      perform: async () => { throw new Error('Migration retry must preserve the original result') } }))
      .toEqual({ value: historicalReceipt.value, replayed: true })
  } finally { await db.close() }
}, 30_000)
