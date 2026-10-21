import { z } from 'zod'
import { HarnessSettingsSearchSchema } from '@foreman-code/contracts/management'
import { AccountProviderSchema, ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'
import { DeviceProvisioningTargetSchema } from '@foreman-code/contracts/device-resources'

export const ProviderAccountsSettingsSearchSchema = HarnessSettingsSearchSchema.extend({
  accountProvider: AccountProviderSchema.optional(),
  accountId: ProviderAccountIdSchema.optional(),
  operationId: z.uuid().optional(),
  accountTarget: DeviceProvisioningTargetSchema.optional(),
})
