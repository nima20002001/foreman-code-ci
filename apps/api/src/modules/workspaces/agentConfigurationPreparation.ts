import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { withAdvancedDefaults, type HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'
import type { HarnessCatalogService } from '../harnesses/catalog.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from './admission.js'

interface ConfigurationInput {
  configuration: HarnessConfiguration
  selection: HarnessProfileSelection | undefined
  previousConfiguration?: HarnessConfiguration
}

/** Native profile setup may run nested commands and must precede database ownership. */
export function prepareAgentConfiguration(input: {
  accounts: ProviderAccountConfigurationService | undefined
  harnesses: Pick<HarnessCatalogService, 'qualifyConfiguration'>
  principal: () => ManagementPrincipal
  workspaceId: string
  source: 'http' | 'mcp'
  commandId: string
  load: (client: pg.PoolClient) => Promise<ConfigurationInput>
}) {
  let snapshot: ConfigurationInput
  let prepared: ConfigurationInput
  return {
    value: () => prepared,
    command: {
      prepare: async (pool: pg.Pool) => {
        snapshot = await withTransaction(pool, input.load)
        prepared = input.accounts ? await input.accounts.prepareProfile({ ...snapshot, pool,
          principal: input.principal(), source: input.source, commandId: input.commandId }) : snapshot
        const unchanged = snapshot.previousConfiguration && isDeepStrictEqual(
          withAdvancedDefaults(prepared.configuration), withAdvancedDefaults(snapshot.previousConfiguration))
        if (!prepared.selection && !unchanged) await input.harnesses.qualifyConfiguration(prepared.configuration)
      },
      preparedMutation: {
        releaseDuringPreparation: true as const,
        resourceLock: `admission:workspace:${input.workspaceId}`,
        validate: async (client: pg.PoolClient) => {
          await lockActiveWorkspace(client, input.workspaceId)
          if (!isDeepStrictEqual(snapshot, await input.load(client))) return false
          if (input.accounts) {
            const resolved = await input.accounts.resolve(prepared.configuration, prepared.selection, { sql: client })
            if (!isDeepStrictEqual(prepared.configuration, resolved)) {
              throw new DomainError('PROVIDER_ACCOUNT_CONFIGURATION_CHANGED',
                'The selected account changed during qualification. Read the account and retry.', 409)
            }
          }
          return true
        },
      },
    },
  }
}
