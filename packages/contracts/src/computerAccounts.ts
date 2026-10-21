import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'

export const COMPUTER_ACCOUNTS_NAMESPACE = 'computer-accounts-v1'
const ComputerAccountToolSchema = z.enum(['codex', 'claude', 'github'])
/** Identity facts only: never tokens, keys or credential paths. */
const ComputerAccountSchema = z.object({
  tool: ComputerAccountToolSchema,
  installed: z.boolean(),
  /** null when the tool is installed but its sign-in state could not be read. */
  signedIn: z.boolean().nullable(),
  account: z.string().max(320).nullable(),
  /** Short public facts such as sign-in method, provider names or a mount path. */
  details: z.array(z.string().max(200)).max(16),
}).strict()
export const ComputerAccountsSchema = z.object({
  accounts: z.array(ComputerAccountSchema).max(ComputerAccountToolSchema.options.length),
  observedAt: z.string().datetime(),
}).strict()
export const ComputerAccountsRequestSchema = z.object({
  operation: z.literal('read'), refresh: z.boolean().optional(),
}).strict()
const ComputerAccountsEntrySchema = z.object({
  target: DeviceProvisioningTargetSchema,
  /** null when the computer is offline or did not answer in time. */
  accounts: ComputerAccountsSchema.nullable(),
}).strict()
export const ComputerAccountsListSchema = z.object({
  computers: z.array(ComputerAccountsEntrySchema).max(101),
  /** Continue after this paired device; Main appears only on the first page. */
  nextCursor: z.uuid().nullable().optional(),
}).strict()
export const ComputerAccountsListInputSchema = z.object({
  refresh: z.boolean().optional(),
  cursor: z.uuid().optional(),
  target: DeviceProvisioningTargetSchema.optional(),
}).strict().refine(input => !input.target || !input.cursor, 'Choose a target or a page cursor, not both.')
export const ComputerAccountsReadInputSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  refresh: z.boolean().optional(),
}).strict()
export type ComputerAccount = z.infer<typeof ComputerAccountSchema>
export type ComputerAccounts = z.infer<typeof ComputerAccountsSchema>
export type ComputerAccountsList = z.infer<typeof ComputerAccountsListSchema>

export const COMPUTER_GITHUB_NAMESPACE = 'computer-github-v1'
/** Device-code sign-in to github.com with the GitHub CLI on one computer. The token never leaves that computer. */
const ExpectedGitHubAccountSchema = z.string().min(1).max(320).nullable()
export const GitHubLoginRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('login-start') }).strict(),
  z.object({ operation: z.literal('login-status'), loginId: z.uuid() }).strict(),
  z.object({ operation: z.literal('logout'), expectedAccount: ExpectedGitHubAccountSchema }).strict(),
  z.object({ operation: z.literal('setup-git'), loginId: z.uuid() }).strict(),
])
export const GitHubLoginStateSchema = z.object({
  loginId: z.uuid().nullable(),
  state: z.enum(['waiting', 'signed-in', 'signed-out', 'git-setup-failed', 'failed', 'expired']),
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).nullable(),
  verificationUrl: z.url().nullable(),
  expiresAt: z.string().datetime().nullable(),
  account: z.string().max(320).nullable(),
  message: z.string().max(500).nullable(),
}).strict()
export const ComputerGitHubInputSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const ComputerGitHubLogoutInputSchema = ComputerGitHubInputSchema.extend({
  expectedAccount: ExpectedGitHubAccountSchema.describe('Account observed before logout; null only when signed out. Retain on retry.'),
}).strict()
export const ComputerGitHubStatusInputSchema = ComputerGitHubInputSchema.extend({ loginId: z.uuid() }).strict()
export type GitHubLoginRequest = z.infer<typeof GitHubLoginRequestSchema>
export type GitHubLoginState = z.infer<typeof GitHubLoginStateSchema>

export * from './computerSync.js'
