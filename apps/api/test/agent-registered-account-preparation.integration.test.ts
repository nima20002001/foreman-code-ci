import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import { withTransaction } from '../src/infrastructure/transaction.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'
import { ProviderAccountConfigurationService } from '../src/modules/harnesses/providerAccountConfiguration.js'
import { privateDirectory, writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { LocalProviderCredentials } from '../src/modules/provider-accounts/localCredentials.js'
import { NativeProviderAccountCommands } from '../src/modules/provider-accounts/nativeCommands.js'
import { createProductionAccountSelection, type AccountIsolationQualification } from '../src/modules/provider-accounts/productionSelection.js'
import { ProviderAccountsRepository } from '../src/modules/provider-accounts/repository.js'
import { ProviderAccountsService } from '../src/modules/provider-accounts/service.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { qualifyConfiguration } from './helpers/concurrentMutations.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

it.skipIf(!postgresEnabled)('creates a registered-account Agent through MCP with native discovery outside account locks', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  try {
    const mainId = randomUUID()
    const accountId = randomUUID()
    const root = privateDirectory(join(f.db.directory, 'registered-profile'))
    const repository = new ProviderAccountsRepository(f.db.pool, async () => mainId)
    const target = await repository.target()
    const account: ProviderAccount = { id: accountId, provider: 'codex', authMode: 'subscription',
      name: 'Registered account', isDefault: true, status: 'signed-in', identity: null, revision: 1,
      binding: { kind: 'slot', provider: 'codex', accountId, profileRef: 'registered-profile',
        bindingRevision: 1, subject: null, target } }
    await withTransaction(f.db.pool, client => repository.write(client, { revision: 0, accounts: [account] }, 0))
    const record: AccountIsolationQualification = {
      qualificationId: 'storage-isolation', provider: 'codex', generation: 1, target,
      expiresAt: '2099-01-01T00:00:00.000Z', isolation: true, storage: 'provider-file',
      scope: { kind: 'existing-profile', homePath: root, userHome: root,
        choice: { profileRef: 'registered-profile', qualificationId: 'storage-isolation', provider: 'codex',
          authMode: 'subscription', label: 'Registered profile' } },
      actions: ['status'],
      override: { instanceId: randomUUID(), instanceRevision: 'qualified', revision: 1, presetId: 'codex',
        driverId: 'codex', enabled: true, configuration: DEFAULT_HARNESS_DEFAULTS.codex,
        configurationFingerprint: 'configuration', qualification: 'qualified', target: {
          hostRef: target.hostRef, applicationInstallationId: mainId,
          harnessInstallationId: 'codex-installation', installationFingerprint: 'installation' } },
    }
    const path = join(root, 'qualification.json')
    writeRecord(path, { version: 1, records: [record] })
    let refreshes = 0
    const discoveryAccountLocks: boolean[] = []
    const selection = createProductionAccountSelection({ path,
      managedPaths: () => ({ homePath: root, userHome: root }),
      models: async () => { throw new Error('Model discovery is outside this account fixture') },
      // Installation inspection is a native boundary; account resolution and transactions are real.
      pin: () => ({ installation: { launcher: { resolvedLauncher: '/fixture/codex' } } }) as RegistryHarnessSelection,
      validate: async () => {
        const result = await f.db.pool.query<{ held: boolean }>(`select exists(
          select 1 from pg_locks where locktype='advisory' and granted
            and database=(select oid from pg_database where datname=current_database())
            and classid=((hashtext($1)::bigint >> 32) & 4294967295)
            and objid=(hashtext($1)::bigint & 4294967295)) as held`, [await repository.key()])
        discoveryAccountLocks.push(result.rows[0]!.held)
        expect(result.rows[0]!.held, 'Native discovery must release the account transaction').toBe(false)
        refreshes++
      },
    })
    const commands = new NativeProviderAccountCommands(selection)
    const accounts = new ProviderAccountsService(f.db.pool, repository, new LocalProviderCredentials(root), {
      resolveProfile: account => commands.resolveProfile(account),
      requireRuntimeAccount: input => commands.requireRuntimeAccount(input),
      status: async () => ({ status: 'signed-in', identity: null }),
      login: async () => { throw new Error('Login is outside this fixture') },
      logout: async () => { throw new Error('Logout is outside this fixture') },
      cancelLogin: async () => { throw new Error('Login is outside this fixture') },
      close: async () => {},
    }, f.commands)
    const harnesses = new HarnessCatalogService({ qualify: async configuration => {
      await accounts.resolve('codex', accountId)
      return qualifyConfiguration(configuration)
    } }, new PostgresSettingsRepository(f.db.pool), f.commands, root)
    const services = f.services as OperatorServices
    services.extensions!.agents = new OperatorAgentMutationService(f.db.pool, f.commands, harnesses,
      undefined, new ProviderAccountConfigurationService(accounts))
    const workspaceId = f.f.scope.workspaceId
    const input = { workspaceId, agentId: randomUUID(), commandId: randomUUID(), name: 'Registered Agent',
      productRole: 'coder', configuration: DEFAULT_HARNESS_DEFAULTS.codex }
    const denied = await f.access.issue({ name: 'Agent reader', audience: 'operator', expiresAt: new Date('2099-01-01'),
      grants: [{ actions: ['agents:read'], scope: { workspaceIds: [workspaceId] } }] })
    const reader = await f.connect(denied.token)
    await expectMcpAccessDenied(reader.callTool({ name: 'agent_create', arguments: input }))
    expect(refreshes).toBe(0)
    const response = await f.client.callTool({ name: 'agent_create', arguments: input })
    expect(discoveryAccountLocks, 'Native discovery must run without account locks').not.toContain(true)
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const created = AgentMutationResultSchema.parse(decodeMcpToolResult(response))
    expect(refreshes).toBeGreaterThan(0)
    expect(created.value.agent.harnessConfiguration).toMatchObject({ accountId })
    const readback = await f.client.callTool({ name: 'agent_get', arguments: { workspaceId, agentId: input.agentId } })
    expect(readback.isError, JSON.stringify(readback)).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ agent: created.value.agent })
  } finally { await f.close() }
}, 30_000)
