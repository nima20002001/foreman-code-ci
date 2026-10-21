import { join } from 'node:path'
import { ProviderAccountIdSchema, ProviderAccountSchema } from '@foreman-code/contracts/provider-accounts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { assertWorkerProviderAccountBinding } from '../provider-accounts/workerOperations.js'
import { DomainError } from '../errors.js'
import { readRecord } from './recovery/storage.js'

export function readInstalledWorkerAccountBinding(input: {
  stateDirectory: string
  provider: 'codex' | 'claude'
  accountId: string
  current(): Readonly<DeviceSessionBinding>
}) {
  ProviderAccountIdSchema.parse(input.accountId)
  const raw = readRecord(join(input.stateDirectory, 'provider-account-slots', `${input.accountId}.json`))
  const account = raw === undefined ? undefined : ProviderAccountSchema.parse(raw)
  if (!account || account.id !== input.accountId || account.provider !== input.provider || account.removedAt
    || !account.binding) throw new DomainError(
    'PROVIDER_ACCOUNT_UNAVAILABLE', 'The selected Worker account is unavailable.', 409)
  assertWorkerProviderAccountBinding(account.binding, input.current())
  return account.binding
}
