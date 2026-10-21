import { optionalCommandId } from './commands.js'
import { z } from 'zod'

const PluginId = z.string().min(3).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/)
const CommandId = z.string().uuid()
const Revision = z.string().regex(/^[a-f0-9]{64}$/)

/** Git sources copied to another computer cannot contain inline credentials. */
export const PluginMarketplaceSourceSchema = z.string().trim().min(3).max(500).refine(value => {
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/u.test(value)) return true
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(value)) return true
  try {
    const url = new URL(value)
    const supported = url.protocol === 'https:' || url.protocol === 'ssh:'
    const usernameAllowed = !url.username || (url.protocol === 'ssh:' && url.username === 'git')
    return supported && Boolean(url.hostname) && usernameAllowed && !url.password && !url.search && !url.hash
      && !/\s/u.test(value)
  } catch {
    return false
  }
}, 'Use owner/repo or a Git URL without credentials, query parameters or fragments.')

/** One Claude Code plugin from the user's configured marketplaces. Native Claude Code is the source of truth. */
const ClaudePluginSummarySchema = z.object({
  pluginId: PluginId, name: z.string(), marketplaceName: z.string(), description: z.string().nullable(),
  version: z.string().nullable(), installed: z.boolean(), enabled: z.boolean(), installCount: z.number().int().nonnegative().nullable(),
}).strict()
export type ClaudePluginSummary = z.infer<typeof ClaudePluginSummarySchema>

const ClaudePluginMarketplaceSchema = z.object({ name: z.string(), source: z.string().nullable() }).strict()
export type ClaudePluginMarketplace = z.infer<typeof ClaudePluginMarketplaceSchema>

export const ClaudePluginListInputSchema = z.object({
  view: z.enum(['installed', 'available']).default('installed'), query: z.string().trim().max(100).default(''),
  refresh: z.preprocess(value => value === 'true' ? true : value, z.boolean().optional()),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(48).default(24),
}).strict()
export type ClaudePluginListInput = z.infer<typeof ClaudePluginListInputSchema>
export const ClaudePluginListResultSchema = z.object({
  items: z.array(ClaudePluginSummarySchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  marketplaces: z.array(ClaudePluginMarketplaceSchema).max(100), checkedAt: z.string().datetime({ offset: true }),
  revision: Revision,
}).strict()

const ClaudePluginActionSchema = z.enum(['install', 'uninstall', 'enable', 'disable'])
export const ClaudePluginChangeInputSchema = z.object({
  pluginId: PluginId, action: ClaudePluginActionSchema, commandId: optionalCommandId(CommandId), expectedRevision: Revision.optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  /** sha256 of a marketplace-declared install command that Claude Code showed in a previous result. */
  acceptCommand: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type ClaudePluginChangeInput = z.infer<typeof ClaudePluginChangeInputSchema>
export const ClaudePluginChangeResultSchema = z.object({
  pluginId: PluginId, action: ClaudePluginActionSchema,
  /** command_review: the plugin installs by running a marketplace-declared command; read it, then retry with acceptCommand. */
  status: z.enum(['applied', 'command_review', 'uncertain']), message: z.string().max(2000),
  command: z.object({ text: z.string().max(4000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  plugin: ClaudePluginSummarySchema.nullable(),
}).strict()

export const ClaudePluginMarketplaceAddInputSchema = z.object({
  /** owner/repo, a Git or HTTPS URL. Local paths stay machine-specific and are not accepted here. */
  source: PluginMarketplaceSourceSchema,
  commandId: optionalCommandId(CommandId), expectedRevision: Revision.optional().describe('Omit for last write wins; supply to reject a stale revision.'),
}).strict()
export type ClaudePluginMarketplaceAddInput = z.infer<typeof ClaudePluginMarketplaceAddInputSchema>
export const ClaudePluginMarketplaceAddResultSchema = z.object({
  marketplaces: z.array(ClaudePluginMarketplaceSchema).max(100),
  status: z.enum(['applied', 'uncertain']), message: z.string().max(2000),
}).strict()
