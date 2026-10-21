import { z } from 'zod'
import {
  CircleAccountIdSchema, CircleAccountRoleSchema, CircleSchedulingRoleSchema,
  DEFAULT_CIRCLE_ACCOUNT_ID, circleCreditsShape, circleSchedulingShape,
} from '../circleCredits.js'
import { optionalCommandId } from './commands.js'

export { CircleAccountIdSchema, DEFAULT_CIRCLE_ACCOUNT_ID } from '../circleCredits.js'
export const CircleOrganizationOwnerSchema = z.string().trim().min(1).max(39)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/)
const organizationOwners = z.array(CircleOrganizationOwnerSchema)
  .refine(owners => new Set(owners.map(owner => owner.toLowerCase())).size === owners.length,
    'Organization owners must be unique.')
export const CircleAccountSchema = z.object({
  id: CircleAccountIdSchema,
  label: z.string().trim().min(1).max(60),
  role: CircleAccountRoleSchema.default('standby'),
  organizations: organizationOwners.max(3),
}).strict().refine(account => account.id === DEFAULT_CIRCLE_ACCOUNT_ID
  ? account.role === 'primary' && (account.organizations.length === 0 || account.organizations.length === 3)
  : account.role === 'standby' && account.organizations.length === 3,
'The primary identity is default; each configured account binds three organizations.')
export const CircleAccountsSchema = z.object({
  accounts: z.array(CircleAccountSchema).min(1).max(2),
}).strict().refine(value => value.accounts.filter(account => account.id === DEFAULT_CIRCLE_ACCOUNT_ID).length === 1
  && new Set(value.accounts.map(account => account.id)).size === value.accounts.length,
'Keep one primary and at most one standby account.').refine(value => {
  const owners = value.accounts.flatMap(account => account.organizations.map(owner => owner.toLowerCase()))
  return new Set(owners).size === owners.length
}, 'An organization can belong to only one CircleCI login.')
export const DEFAULT_CIRCLE_ACCOUNTS = CircleAccountsSchema.parse({
  accounts: [{ id: DEFAULT_CIRCLE_ACCOUNT_ID, label: 'Primary', role: 'primary', organizations: [] }],
})
export const CircleOrganizationReadSchema = z.object({
  account: CircleOrganizationOwnerSchema,
  circleAccountId: CircleAccountIdSchema,
  ready: z.boolean(),
  running: z.number().int().nonnegative(),
  ...circleSchedulingShape,
  schedulingRole: CircleSchedulingRoleSchema,
  schedulingReason: z.string().max(300),
  ...circleCreditsShape,
}).strict()
/** Observed org status can be partial; organizations retains the saved bindings. */
export const CircleAccountReadSchema = CircleAccountSchema.safeExtend({
  tokenConfigured: z.boolean(),
  ready: z.boolean(),
  reasons: z.array(z.string().max(300)),
  orgs: z.array(CircleOrganizationReadSchema),
}).strict()
export const ManagedCircleAccountsSchema = z.object({
  value: z.object({ accounts: z.array(CircleAccountReadSchema).min(1).max(2) }).strict(),
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict()
const revision = z.number().int().nonnegative().optional()
  .describe('Omit for last write wins; supply to reject a stale revision.')
const commandId = optionalCommandId(z.string().trim().min(8).max(200))
/** Metadata only. Local human setup provisions API tokens in private CLI profiles outside Foreman. */
export const CircleAccountAddInputSchema = z.object({
  account: CircleAccountSchema,
  expectedRevision: revision,
  commandId,
}).strict()
export const CircleAccountRemoveInputSchema = z.object({
  id: CircleAccountIdSchema.refine(id => id !== DEFAULT_CIRCLE_ACCOUNT_ID, 'The primary account cannot be removed.'),
  expectedRevision: revision,
  commandId,
}).strict()
export const CircleAccountsUpdateResultSchema = z.object({
  value: ManagedCircleAccountsSchema,
  replayed: z.boolean(),
}).strict()
export type CircleAccount = z.infer<typeof CircleAccountSchema>
export type CircleAccounts = z.infer<typeof CircleAccountsSchema>
export type CircleAccountRead = z.infer<typeof CircleAccountReadSchema>
export type CircleOrganizationRead = z.infer<typeof CircleOrganizationReadSchema>
export type ManagedCircleAccounts = z.infer<typeof ManagedCircleAccountsSchema>
export type CircleAccountAddInput = z.infer<typeof CircleAccountAddInputSchema>
export type CircleAccountRemoveInput = z.infer<typeof CircleAccountRemoveInputSchema>
