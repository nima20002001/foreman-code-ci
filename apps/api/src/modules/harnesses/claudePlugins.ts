import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { createHash } from 'node:crypto'
import {
  ClaudePluginChangeInputSchema, ClaudePluginChangeResultSchema, ClaudePluginListInputSchema,
  ClaudePluginListResultSchema, ClaudePluginMarketplaceAddInputSchema, ClaudePluginMarketplaceAddResultSchema,
  type ClaudePluginChangeInput, type ClaudePluginListInput,
  type ClaudePluginMarketplaceAddInput, type ClaudePluginSummary, type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import type pg from 'pg'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { claudeBinary, claudeCliResult, readClaudePlugins, type PluginPorts, type ClaudePluginCatalog } from '../computers/claudePlugins.js'
import { DomainError } from '../errors.js'
import { QualificationCache } from './qualificationCache.js'

function revision(catalog: ClaudePluginCatalog): string {
  const plugins = catalog.plugins.filter(plugin => plugin.installed)
    .map(({ pluginId, version, enabled }) => ({ pluginId, version, enabled }))
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  const marketplaces = [...catalog.marketplaces].sort((a, b) => a.name.localeCompare(b.name))
  return createHash('sha256').update(JSON.stringify({ plugins, marketplaces })).digest('hex')
}

export class ClaudePluginSettingsService {
  private readonly catalogs = new QualificationCache<ClaudePluginCatalog>(30_000, 2, Date.now, true)
  constructor(private readonly ports: PluginPorts, private readonly commands: PostgresCommandCoordinator) {}

  private async catalog(signal: AbortSignal, options: { refresh?: boolean | undefined } = {}) {
    try {
      return await this.catalogs.get('catalog', (active) => readClaudePlugins(this.ports,
        AbortSignal.any([active, AbortSignal.timeout(120_000)])), { signal, refresh: options.refresh })
    } catch (error) {
      this.catalogs.forget('catalog')
      throw error
    }
  }

  async warmup(): Promise<void> {
    try { await this.catalog(AbortSignal.timeout(120_000)) }
    catch (error) { logIgnoredError('harness', 'warm Claude plugin catalog', error); throw error }
  }

  async list(principal: ManagementPrincipal, raw: ClaudePluginListInput, signal = AbortSignal.timeout(120_000)) {
    requireAuthorization(principal, 'harnesses:read')
    const input = ClaudePluginListInputSchema.parse(raw)
    const catalog = await this.catalog(signal, { refresh: input.refresh })
    const query = input.query.toLocaleLowerCase()
    const items = catalog.plugins.filter(plugin => plugin.installed === (input.view === 'installed'))
      .filter(plugin => `${plugin.name} ${plugin.marketplaceName} ${plugin.description ?? ''}`
        .toLocaleLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name))
    return ClaudePluginListResultSchema.parse({
      items: items.slice(input.offset, input.offset + input.limit), total: items.length,
      nextOffset: input.offset + input.limit < items.length ? input.offset + input.limit : null,
      marketplaces: catalog.marketplaces, checkedAt: new Date().toISOString(), revision: revision(catalog),
    })
  }

  async change(principal: ManagementPrincipal, raw: ClaudePluginChangeInput, source: 'http' | 'mcp' = 'http') {
    const input = ClaudePluginChangeInputSchema.parse(raw)
    await this.authorize(principal, source, 'claude_plugin_change', input.pluginId)
    try {
      const started = await this.startChange(principal, source, 'claude.plugin.change', input, input.pluginId)
      const result = await this.commands.execute({
        principal, source, operation: 'claude.plugin.change', commandId: input.commandId,
        targetKey: `claude-plugin:${input.pluginId}`, payload: input,
        authorize: client => this.authorizeLive(client, principal.id),
        perform: async client => {
          if (started.replayed) return this.changeReadback(input)
          await this.checkRevision(client, input.expectedRevision)
          const flags = input.action === 'install' && input.acceptCommand ? ['--accept-command', input.acceptCommand] : []
          const native = await this.run(['plugin', input.action, input.pluginId, '--scope', 'user', '--json', ...flags])
          if (native?.shownCommand) {
            return ClaudePluginChangeResultSchema.parse({
              pluginId: input.pluginId, action: input.action, status: 'command_review', plugin: null,
              message: 'Review the marketplace install command, then retry with its hash and a new command ID.',
              command: {
                text: native.shownCommand.command ?? native.shownCommand.text ?? native.message ?? '',
                sha256: native.shownCommand.sha256,
              },
            })
          }
          if (native?.outcome !== 'ok') {
            throw new DomainError('CLAUDE_PLUGIN_CHANGE_FAILED', native?.message ?? 'Claude could not change this plugin.', 409)
          }
          return this.changeReadback(input)
        },
      })
      if (!result.replayed || result.value.status !== 'uncertain') return result.value
      return (await this.commands.execute({
        principal, source, operation: 'claude.plugin.change.readback', commandId: input.commandId,
        targetKey: `claude-plugin:${input.pluginId}`, payload: input,
        authorize: client => this.authorizeLive(client, principal.id),
        perform: async () => {
          const readback = await this.changeReadback(input)
          if (readback.status !== 'applied') {
            throw new DomainError('CLAUDE_PLUGIN_UNCERTAIN', readback.message, 409)
          }
          return readback
        },
      })).value
    } finally {
      this.catalogs.clear()
    }
  }

  async addMarketplace(principal: ManagementPrincipal, raw: ClaudePluginMarketplaceAddInput, source: 'http' | 'mcp' = 'http') {
    const input = ClaudePluginMarketplaceAddInputSchema.parse(raw)
    await this.authorize(principal, source, 'claude_plugin_marketplace_add', input.source)
    try {
      const started = await this.startChange(principal, source, 'claude.plugin.marketplace_add', input, input.source)
      const result = await this.commands.execute({
        principal, source, operation: 'claude.plugin.marketplace_add', commandId: input.commandId,
        targetKey: `claude-marketplace:${input.source}`, payload: input,
        authorize: client => this.authorizeLive(client, principal.id),
        perform: async client => {
          if (started.replayed) return this.marketplaceReadback(input.source)
          await this.checkRevision(client, input.expectedRevision)
          const native = await this.run(['plugin', 'marketplace', 'add', input.source, '--json'])
          if (native?.outcome !== 'ok') {
            throw new DomainError('CLAUDE_MARKETPLACE_ADD_FAILED', native?.message ?? 'Could not add this marketplace.', 409)
          }
          return this.marketplaceReadback(input.source)
        },
      })
      if (!result.replayed || result.value.status !== 'uncertain') return result.value
      return (await this.commands.execute({
        principal, source, operation: 'claude.plugin.marketplace_add.readback', commandId: input.commandId,
        targetKey: `claude-marketplace:${input.source}`, payload: input,
        authorize: client => this.authorizeLive(client, principal.id),
        perform: async () => {
          const readback = await this.marketplaceReadback(input.source)
          if (readback.status !== 'applied') throw new DomainError('CLAUDE_PLUGIN_UNCERTAIN', readback.message, 409)
          return readback
        },
      })).value
    } finally {
      this.catalogs.clear()
    }
  }

  private startChange(
    principal: ManagementPrincipal, source: 'http' | 'mcp', operation: string,
    input: ClaudePluginChangeInput | ClaudePluginMarketplaceAddInput, targetKey: string,
  ) {
    return this.commands.execute({
      principal, source, operation: `${operation}.started`, commandId: input.commandId, targetKey, payload: input,
      authorize: client => this.authorizeLive(client, principal.id),
      perform: async client => {
        await this.checkRevision(client, input.expectedRevision)
        return { started: true }
      },
    })
  }

  private async changeReadback(input: ClaudePluginChangeInput) {
    let plugin: ClaudePluginSummary | null = null
    try {
      const catalog = await readClaudePlugins(this.ports, AbortSignal.timeout(120_000))
      plugin = catalog.plugins.find(item => item.pluginId === input.pluginId) ?? null
      const installedMatches = Boolean(plugin?.installed) === (input.action !== 'uninstall')
      const enabledMatches = input.action === 'uninstall' || plugin?.enabled === (input.action !== 'disable')
      if (installedMatches && enabledMatches) {
        return ClaudePluginChangeResultSchema.parse({
          pluginId: input.pluginId, action: input.action, status: 'applied', plugin,
          message: 'The Claude plugin list confirms this change.',
        })
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
    }
    return ClaudePluginChangeResultSchema.parse({
      pluginId: input.pluginId, action: input.action, status: 'uncertain', plugin,
      message: 'The change could not be confirmed. Retry the same command ID to read its result without repeating it.',
    })
  }

  private async marketplaceReadback(source: string) {
    try {
      const catalog = await readClaudePlugins(this.ports, AbortSignal.timeout(120_000))
      if (catalog.marketplaces.some(item => item.source === source)) {
        return ClaudePluginMarketplaceAddResultSchema.parse({
          marketplaces: catalog.marketplaces, status: 'applied', message: 'The marketplace was added.',
        })
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
    }
    return ClaudePluginMarketplaceAddResultSchema.parse({
      marketplaces: [], status: 'uncertain',
      message: 'The marketplace addition could not be confirmed. Retry the same command ID to check it without adding it again.',
    })
  }

  private async checkRevision(client: pg.PoolClient, expected: string | undefined) {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['claude-plugin-settings'])
    if (expected !== undefined && revision(await readClaudePlugins(this.ports, AbortSignal.timeout(120_000))) !== expected) {
      throw new DomainError('REVISION_CONFLICT', 'Claude plugins changed. Read the list again before editing.', 409)
    }
  }

  private async authorizeLive(client: pg.PoolClient, principalId: string) {
    const principal = await readLiveManagementPrincipal(client, principalId)
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
  }

  private async authorize(principal: ManagementPrincipal, source: 'http' | 'mcp', action: string, targetKey: string) {
    try {
      requireAuthorization(principal, 'harnesses:update')
      requireAuthorization(principal, 'harnesses:read')
    } catch (error) {
      await this.commands.recordDenied(principal.id, source, action, targetKey)
      throw error
    }
  }

  private async run(args: string[]) {
    const result = await this.ports.run(await claudeBinary(this.ports), args, {
      signal: AbortSignal.timeout(300_000), timeoutMs: 300_000,
    })
    const native = claudeCliResult(result.stdout)
    if (result.code !== 0 && !native?.shownCommand) {
      throw new DomainError('CLAUDE_PLUGIN_CHANGE_FAILED', native?.message ?? 'The Claude plugin command failed.', 409)
    }
    return native
  }
}
