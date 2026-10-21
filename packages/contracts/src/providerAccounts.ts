import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { HarnessModelOptionSchema, HarnessOptionsResultSchema } from './harnessOptions.js'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'

export const AccountProviderSchema = z.enum(['codex', 'claude'])
const ProviderAccountAuthModeSchema = z.enum(['subscription', 'api-key'])
const ProviderAccountStatusSchema = z.enum(['signed-out', 'signed-in', 'login-pending', 'unavailable'])
export const ProviderAccountIdSchema = z.string().uuid()
const Revision = z.number().int().safe().nonnegative()
const Reference = z.string().trim().min(1).max(200)
const ProfileReference = Reference.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const ProviderAccountSubjectSchema = z.object({
  subject: Reference,
  provenance: z.literal('qualified-native'),
  qualificationId: Reference,
  observedAt: z.string().datetime(),
}).strict()
export const ProviderAccountBindingSchema = z.object({
  kind: z.literal('slot'),
  accountId: ProviderAccountIdSchema,
  provider: AccountProviderSchema,
  target: DeviceProvisioningTargetSchema,
  profileRef: ProfileReference,
  bindingRevision: Revision.min(1),
  subject: ProviderAccountSubjectSchema.nullable(),
}).strict()
const ProviderAccountLegacyBindingSchema = z.object({
  kind: z.literal('legacy-profile'),
  provider: AccountProviderSchema,
  target: DeviceProvisioningTargetSchema.nullable(),
  profileRef: ProfileReference.nullable(),
  historicalSubject: z.literal('unknown'),
  accountId: ProviderAccountIdSchema.optional(),
}).strict()
export const AcceptedProviderAccountBindingSchema = z.discriminatedUnion('kind', [
  ProviderAccountBindingSchema, ProviderAccountLegacyBindingSchema,
])
export const ProviderAccountObservationSchema = z.object({
  bindingRevision: Revision.min(1),
  generation: Revision.min(1),
  sequence: Revision,
  observedAt: z.string().datetime(),
  status: ProviderAccountStatusSchema,
  identity: z.string().max(200).nullable(),
  subject: ProviderAccountSubjectSchema.nullable(),
  readiness: z.enum(['ready', 'sign-in-required', 'qualification-required', 'unavailable', 'unknown']),
}).strict()
export const ProviderAccountDefaultSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  provider: AccountProviderSchema,
  accountId: ProviderAccountIdSchema.nullable(),
  revision: Revision,
}).strict()
export const ProviderAccountSchema = z.object({
  id: ProviderAccountIdSchema,
  provider: AccountProviderSchema,
  name: z.string().trim().min(1).max(100),
  authMode: ProviderAccountAuthModeSchema,
  isDefault: z.boolean(),
  status: ProviderAccountStatusSchema,
  identity: z.string().max(200).nullable(),
  revision: z.number().int().nonnegative(),
  binding: ProviderAccountBindingSchema.optional(),
  observation: ProviderAccountObservationSchema.optional(),
  removedAt: z.string().datetime().nullable().optional(),
  legacyProfile: z.boolean().optional(),
  possibleDuplicateAccountIds: z.array(ProviderAccountIdSchema).max(100).optional(),
}).strict()
export const ProviderAccountsSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  accounts: z.array(ProviderAccountSchema).max(100),
  defaults: z.array(ProviderAccountDefaultSchema).max(200).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.accounts.map(account => account.id)).size !== value.accounts.length) {
    context.addIssue({ code: 'custom', path: ['accounts'], message: 'Account IDs must be unique.' })
  }
  for (const provider of AccountProviderSchema.options) {
    if (value.accounts.filter(account => account.provider === provider && account.isDefault).length > 1) {
      context.addIssue({ code: 'custom', path: ['accounts'], message: 'A provider may have only one default account.' })
    }
  }
})
export const ProviderAccountCommandInputSchema = z.object({
  commandId: optionalCommandId(z.string().trim().min(8).max(200)),
  expectedRevision: z.number().int().nonnegative(),
  target: DeviceProvisioningTargetSchema.optional(),
}).strict()
export const ProviderAccountCreateInputSchema = ProviderAccountCommandInputSchema.extend({
  provider: AccountProviderSchema,
  name: ProviderAccountSchema.shape.name,
  authMode: ProviderAccountAuthModeSchema,
}).refine(value => value.provider !== 'codex' || value.authMode === 'subscription', {
  path: ['authMode'], message: 'Codex accounts use ChatGPT subscription sign-in.',
})
export const ProviderAccountRenameInputSchema = ProviderAccountCommandInputSchema.extend({
  name: ProviderAccountSchema.shape.name,
  expectedLabelRevision: Revision.optional(),
})
export const ProviderAccountListInputSchema = z.object({
  target: DeviceProvisioningTargetSchema.optional(),
  provider: AccountProviderSchema.optional(),
  cursor: ProviderAccountIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeRemoved: z.boolean().default(false),
}).strict()
export const ProviderAccountPageSchema = z.object({
  target: DeviceProvisioningTargetSchema.optional(),
  revision: Revision,
  accounts: z.array(ProviderAccountSchema).max(100),
  defaults: z.array(ProviderAccountDefaultSchema).max(200),
  nextCursor: ProviderAccountIdSchema.nullable(),
}).strict()
export const ProviderAccountGetInputSchema = z.object({
  accountId: ProviderAccountIdSchema, target: DeviceProvisioningTargetSchema.optional(),
}).strict()
export const ProviderAccountRegisterInputSchema = ProviderAccountCommandInputSchema.extend({
  provider: AccountProviderSchema,
  name: ProviderAccountSchema.shape.name,
  authMode: ProviderAccountAuthModeSchema,
  profileRef: ProfileReference,
  qualificationId: Reference,
}).strict()
export const ProviderAccountDefaultInputSchema = ProviderAccountCommandInputSchema.extend({
  expectedDefaultRevision: Revision.optional(),
}).strict()
const ProviderAccountAuthenticationStateSchema = z.enum([
  'reserved', 'awaiting-human', 'observing', 'completed', 'canceled', 'expired', 'failed', 'outcome-unknown',
])
export const ProviderAccountAuthenticationOperationSchema = z.object({
  id: z.uuid(),
  commandId: ProviderAccountCommandInputSchema.shape.commandId.removeDefault(),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  binding: ProviderAccountBindingSchema,
  intent: z.enum(['sign-in', 'sign-out']),
  state: ProviderAccountAuthenticationStateSchema,
  revision: Revision.min(1),
  generation: Revision.min(1),
  nativeSequence: Revision,
  cancelRequested: z.boolean(),
  nativeClosed: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().describe('Authentication operation expiry, one hour after creation; retries retain the original expiry.'),
  humanActionRequired: z.boolean(),
}).strict().refine(value => value.state !== 'canceled' || value.nativeClosed, {
  message: 'Canceled authentication requires native closure.',
})
export const ProviderAccountAuthenticationPrepareInputSchema = ProviderAccountCommandInputSchema.extend({
  intent: z.enum(['sign-in', 'sign-out']).default('sign-in'),
}).strict()
export const ProviderAccountAuthenticationReadInputSchema = z.object({
  operationId: z.uuid(), target: DeviceProvisioningTargetSchema.optional(),
}).strict()
export const ProviderAccountAuthenticationCancelInputSchema = ProviderAccountCommandInputSchema.extend({
  operationId: z.uuid(),
}).strict()
export const ProviderAccountAuthenticationResultSchema = z.object({
  value: ProviderAccountAuthenticationOperationSchema, replayed: z.boolean(),
}).strict()
export const ProviderAccountNativeAuthenticationObservationSchema = z.object({
  operationId: z.uuid(), binding: ProviderAccountBindingSchema,
  generation: Revision.min(1), sequence: Revision,
  state: ProviderAccountAuthenticationStateSchema,
  nativeClosed: z.boolean(),
  account: ProviderAccountObservationSchema.optional(),
}).strict()
export const ProviderAccountModelsInputSchema = ProviderAccountGetInputSchema
const AccountModelOptionSchema = HarnessModelOptionSchema.extend({
  id: Reference, providerId: Reference.optional(), name: Reference,
  reasoningEfforts: z.array(Reference).max(100).default([]),
  variants: z.array(Reference).max(100).default([]), serviceTiers: z.array(Reference).max(100).default([]),
  releasedAt: z.string().max(200).optional(),
})
export const ProviderAccountModelsSchema = z.object({
  binding: ProviderAccountBindingSchema,
  generation: Revision.min(1), observedAt: z.string().datetime(),
  models: z.array(AccountModelOptionSchema).max(500),
  options: HarnessOptionsResultSchema.extend({
    providerVersion: Reference, models: z.array(HarnessModelOptionSchema).max(500),
    nativeAgents: z.array(Reference).max(100), settings: HarnessOptionsResultSchema.shape.settings.max(100),
    restrictions: z.array(z.string().max(500)).max(100),
  }).optional(),
}).strict().refine(value => !value.options || value.options.harness === value.binding.provider, {
  message: 'Native model options must name the selected account provider.',
})
export const ProviderAccountDiscoveryInputSchema = z.object({
  target: DeviceProvisioningTargetSchema.optional(), provider: AccountProviderSchema.optional(),
}).strict()
const ProviderAccountCapabilitySchema = z.object({
  provider: AccountProviderSchema,
  actions: z.array(z.enum(['create', 'register', 'status', 'models', 'sign-in', 'sign-out', 'cancel', 'human-handoff'])),
  qualified: z.boolean(), reason: z.string().min(1).max(500).nullable(),
}).strict()
const ProviderAccountTargetSchema = z.object({
  target: DeviceProvisioningTargetSchema, label: z.string().min(1).max(200),
  generation: Revision.min(1), connected: z.boolean(), canRead: z.boolean(), canManage: z.boolean(),
  providers: z.array(ProviderAccountCapabilitySchema).max(2),
}).strict()
export const ProviderAccountTargetsSchema = z.object({ targets: z.array(ProviderAccountTargetSchema).max(200) }).strict()
export const ProviderAccountProfileChoiceSchema = z.object({
  profileRef: ProfileReference, qualificationId: Reference, provider: AccountProviderSchema,
  authMode: ProviderAccountAuthModeSchema, label: z.string().min(1).max(200),
}).strict()
export const ProviderAccountNativeDiscoverySchema = z.object({
  generation: Revision.min(1), providers: z.array(ProviderAccountCapabilitySchema).max(2),
  profiles: z.array(ProviderAccountProfileChoiceSchema).max(100),
}).strict()
export const ProviderAccountProfilesSchema = z.object({
  target: DeviceProvisioningTargetSchema, profiles: z.array(ProviderAccountProfileChoiceSchema).max(100),
}).strict()
export const ProviderAccountEligibilitySchema = z.object({
  accountId: ProviderAccountIdSchema, target: DeviceProvisioningTargetSchema,
  canManage: z.boolean(), canReauthenticate: z.boolean(), reason: z.string().max(500).nullable(),
}).strict()
export const ProviderAccountAuthenticationListInputSchema = ProviderAccountGetInputSchema.extend({
  cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export const ProviderAccountAuthenticationPageSchema = z.object({
  target: DeviceProvisioningTargetSchema, accountId: ProviderAccountIdSchema,
  currentOperation: ProviderAccountAuthenticationOperationSchema.nullable(),
  operations: z.array(ProviderAccountAuthenticationOperationSchema).max(100), nextCursor: z.uuid().nullable(),
}).strict()
/** Ephemeral local human response. Never an MCP result or persisted account record. */
export const ProviderAccountHumanHandoffSchema = z.object({
  operationId: z.uuid(), kind: z.literal('local-browser'), expiresAt: z.string().datetime(),
  message: z.string().min(1).max(500),
}).strict()
export type ProviderAccountCapability = z.infer<typeof ProviderAccountCapabilitySchema>
export type ProviderAccountProfileChoice = z.infer<typeof ProviderAccountProfileChoiceSchema>
export type ProviderAccountTarget = z.infer<typeof ProviderAccountTargetSchema>
export type ProviderAccountHumanHandoff = z.infer<typeof ProviderAccountHumanHandoffSchema>
export const ProviderAccountWorkerAuthorityRequestSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('authorize'), operation: ProviderAccountAuthenticationOperationSchema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('binding'), binding: ProviderAccountBindingSchema }).strict(),
])
export const PROVIDER_ACCOUNT_WORKER_NAMESPACE = 'provider-accounts-v1'
export const PROVIDER_ACCOUNT_WORKER_VERSION = 1
export const ProviderAccountWorkerRequestSchema = z.object({
  version: z.literal(1), target: DeviceProvisioningTargetSchema,
  connection: DeviceConnectionIdentitySchema,
  request: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('discover'), provider: AccountProviderSchema.optional() }).strict(),
    z.object({ kind: z.literal('provision'), account: ProviderAccountSchema }).strict(),
    z.object({ kind: z.literal('register'), provider: AccountProviderSchema, authMode: ProviderAccountAuthModeSchema, profileRef: ProfileReference,
      qualificationId: Reference }).strict(),
    z.object({ kind: z.literal('status'), binding: ProviderAccountBindingSchema }).strict(),
    z.object({ kind: z.literal('models'), binding: ProviderAccountBindingSchema }).strict(),
    z.object({ kind: z.literal('prepare'), operation: ProviderAccountAuthenticationOperationSchema }).strict(),
    z.object({ kind: z.literal('observe'), operation: ProviderAccountAuthenticationOperationSchema }).strict(),
    z.object({ kind: z.literal('cancel'), operation: ProviderAccountAuthenticationOperationSchema }).strict(),
  ]),
}).strict()
/** This input belongs only to the local human HTTP endpoint; it is never an MCP tool input. */
export const ProviderAccountApiKeyInputSchema = ProviderAccountCommandInputSchema.extend({
  apiKey: z.string().trim().min(20).max(4096).refine(value =>
    !/\s/.test(value) && !Array.from(value).some(character => character.charCodeAt(0) < 32)),
})
export const ProviderAccountUpdateResultSchema = z.object({
  value: ProviderAccountsSnapshotSchema,
  replayed: z.boolean(),
}).strict()
export const ProviderAccountToolCommandSchema = ProviderAccountCommandInputSchema.extend({
  accountId: ProviderAccountIdSchema,
})
export const ProviderAccountToolRenameSchema = ProviderAccountRenameInputSchema.extend({
  accountId: ProviderAccountIdSchema,
})
export const PROVIDER_ACCOUNT_TOOLS = [
  'provider_accounts_list', 'provider_account_create', 'provider_account_rename',
  'provider_account_default_set', 'provider_account_login', 'provider_account_logout', 'provider_account_refresh',
  'provider_accounts_page', 'provider_account_get', 'provider_account_register', 'provider_account_remove',
  'provider_account_auth_prepare', 'provider_account_auth_status', 'provider_account_auth_cancel', 'provider_account_models',
  'provider_account_targets', 'provider_account_profiles', 'provider_account_eligibility', 'provider_account_auth_list',
] as const

export type AccountProvider = z.infer<typeof AccountProviderSchema>
export type ProviderAccountAuthMode = z.infer<typeof ProviderAccountAuthModeSchema>
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>
export type ProviderAccountsSnapshot = z.infer<typeof ProviderAccountsSnapshotSchema>
export type ProviderAccountCommandInput = z.infer<typeof ProviderAccountCommandInputSchema>
export type ProviderAccountCreateInput = z.infer<typeof ProviderAccountCreateInputSchema>
export type ProviderAccountRenameInput = z.infer<typeof ProviderAccountRenameInputSchema>
export type ProviderAccountApiKeyInput = z.infer<typeof ProviderAccountApiKeyInputSchema>
export type ProviderAccountBinding = z.infer<typeof ProviderAccountBindingSchema>
export type AcceptedProviderAccountBinding = z.infer<typeof AcceptedProviderAccountBindingSchema>
export type ProviderAccountObservation = z.infer<typeof ProviderAccountObservationSchema>
export type ProviderAccountAuthenticationOperation = z.infer<typeof ProviderAccountAuthenticationOperationSchema>
export type ProviderAccountNativeAuthenticationObservation = z.infer<typeof ProviderAccountNativeAuthenticationObservationSchema>
export type ProviderAccountModels = z.infer<typeof ProviderAccountModelsSchema>
export type ProviderAccountWorkerRequest = z.infer<typeof ProviderAccountWorkerRequestSchema>
