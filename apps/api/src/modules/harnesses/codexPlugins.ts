import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { CodexPluginDetailResult, CodexPluginSummary } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { assertCodexUnchanged, qualifyCodex } from './codexProtocol.js'
import { runCommand } from './process.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { inspectCodexPluginCatalog, pluginCommandEnvironment } from './codexPluginConfiguration.js'
import { backupNativeUserFile, readNativeUserFile } from './nativeConfigFiles.js'
import { BoundedPluginFiles, safePluginPart } from './boundedPluginFiles.js'
import { inspectCodexPluginBundle } from './codexPluginInspection.js'
import { pluginHash } from './codexPluginIdentity.js'
import { NativePluginCatalogSchema, normalizeCodexPluginCatalog, type CodexPluginCatalog } from './codexPluginCatalog.js'

export type { CodexPluginCatalog } from './codexPluginCatalog.js'
export type CodexPluginMutation = { acknowledged: true; version: string | null }
export interface CodexPluginAdapter {
  readonly recoveryIdentity: string
  list(signal: AbortSignal): Promise<CodexPluginCatalog>
  detail(plugin: CodexPluginSummary, signal?: AbortSignal): Promise<CodexPluginDetailResult['contents']>
  change(pluginId: string, action: 'install' | 'remove', signal: AbortSignal, reviewed: CodexPluginCatalog): Promise<CodexPluginMutation>
}

export function validatePluginMutation(value: unknown, pluginId: string, action: 'install' | 'remove'): CodexPluginMutation {
  const base = z.object({ pluginId: z.string(), name: z.string(), marketplaceName: z.string() })
  const result = action === 'install' ? base.extend({ version: z.string().min(1), installedPath: z.string().min(1),
    authPolicy: z.enum(['ON_INSTALL', 'ON_USE']) }).parse(value) : base.parse(value)
  if (result.pluginId !== pluginId || `${result.name}@${result.marketplaceName}` !== pluginId) throw new Error('Native plugin result has a different selector.')
  return { acknowledged: true, version: 'version' in result ? String(result.version) : null }
}

export class NativeCodexPlugins implements CodexPluginAdapter {
  constructor(private readonly binary: string | (() => string), private readonly directory: string,
    private readonly processRecovery?: NativeProcessRecovery) {}
  get recoveryIdentity(): string {
    if (!this.processRecovery || process.platform !== 'linux') return ''
    return pluginHash([resolve(this.processRecovery.root), this.processRecovery.owner])
  }
  private async command(args: string[], signal: AbortSignal, mutation = false) {
    const environment = pluginCommandEnvironment()
    if (mutation && (!this.processRecovery || process.platform !== 'linux')) throw new DomainError('CODEX_PLUGIN_RECOVERY_UNAVAILABLE', 'Persistent process recovery is required before changing plugins.', 503)
    const binary = typeof this.binary === 'string' ? this.binary : this.binary()
    const qualified = await qualifyCodex(binary, this.directory, environment, true, signal)
    await assertCodexUnchanged(qualified)
    return runCommand(qualified.binary, args, this.directory, signal, environment,
      { maxOutputBytes: 8_000_000, ...(mutation && this.processRecovery ? { recovery: this.processRecovery } : {}) })
  }
  private cache() { return resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugins', 'cache') }
  private async cachedIds(signal: AbortSignal): Promise<string[]> {
    try {
      const cache = this.cache()
      // BoundedPluginFiles contains every traversed child, including marketplace/skills symlinks.
      const files = await BoundedPluginFiles.create(resolve(cache, '..'), signal)
      const ids: string[] = []
      for (const marketplace of await files.directories('cache') ?? []) {
        if (!safePluginPart(marketplace)) continue
        for (const name of await files.directories(`cache/${marketplace}`) ?? []) {
          if (safePluginPart(name)) ids.push(`${name}@${marketplace}`)
          if (ids.length > 1_000) throw new Error('Too many local plugin records.')
        }
      }
      return ids
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error // Failed inventory inspection must never imply an empty inventory.
    }
  }
  async list(signal: AbortSignal): Promise<CodexPluginCatalog> {
    const binary = typeof this.binary === 'string' ? this.binary : this.binary()
    const { result, configuration } = await inspectCodexPluginCatalog(binary, this.directory, signal)
    if (result.exitCode !== 0) throw new DomainError('CODEX_PLUGIN_CATALOG_UNAVAILABLE', 'Codex could not list its plugin catalog.', 503)
    try {
      const native = NativePluginCatalogSchema.parse(JSON.parse(result.stdout))
      return normalizeCodexPluginCatalog(native, configuration,
        result.stderr.trim() ? 'partial' : 'complete', await this.cachedIds(signal))
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof DomainError) throw error
      throw new DomainError('CODEX_PLUGIN_CATALOG_INVALID', 'Codex plugin discovery or local inventory could not be fully inspected.', 502, undefined, { cause: error })
    }
  }
  async change(pluginId: string, action: 'install' | 'remove', signal: AbortSignal, reviewed: CodexPluginCatalog): Promise<CodexPluginMutation> {
    // The qualified CLI has no artifact argument. Recheck the exact reviewed source immediately before dispatch.
    const current = await this.list(signal)
    if (current.revision !== reviewed.revision) throw new DomainError('REVISION_CONFLICT', 'The plugin source or native settings changed. Review the new details.', 409)
    await backupNativeUserFile(current.configuration.file, await readNativeUserFile(current.configuration.file))
    const result = await this.command(['plugin', action === 'install' ? 'add' : 'remove', pluginId, '--json'], signal, true)
    // The persistent guardian terminates after its native child exits, so its
    // exitCode can be null even when Codex emitted a complete acknowledgement.
    if (result.exitCode !== 0 && result.exitCode !== null) throw new DomainError('CODEX_PLUGIN_NATIVE_FAILED', 'Codex reported a failed plugin change. Reconcile the original request before another write.', 409)
    try { return validatePluginMutation(JSON.parse(result.stdout), pluginId, action) }
    catch { throw new DomainError('CODEX_PLUGIN_RESULT_INVALID', 'Codex did not return a valid acknowledgement for this plugin.', 502) }
  }
  async detail(plugin: CodexPluginSummary, signal?: AbortSignal): Promise<CodexPluginDetailResult['contents']> {
    if (!plugin.installed || plugin.verification === 'unverified' || !safePluginPart(plugin.name) || !safePluginPart(plugin.marketplaceName)) return { status: 'unknown' }
    const version = plugin.version ?? 'local'
    if (!safePluginPart(version)) return { status: 'unknown' }
    return inspectCodexPluginBundle(resolve(this.cache(), plugin.marketplaceName, plugin.name, version), signal)
  }
}
