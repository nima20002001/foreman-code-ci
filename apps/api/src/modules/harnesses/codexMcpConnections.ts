import { installAppLauncher } from './appMcpLauncher.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { backupNativeUserFile, readNativeUserFile, resolveNativeUserFile } from './nativeConfigFiles.js'
import { runCommand } from './process.js'
import type { HarnessMcpChange, HarnessMcpManagedPreset } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { CodexStdioTransport } from './codexStdioTransport.js'
import { assertCodexUnchanged, qualifyCodex } from './codexProtocol.js'
import { applyMcpEdits, fingerprint, mcpEdits, record, type NativeMcpAdapter, type NativeMcpSnapshot } from './nativeMcpCommon.js'
import { withNativeMcpDelivery } from './nativeMcpDelivery.js'

/** A second definition can survive user-entry removal, even when its current values are identical. */
export function codexMcpOwnership(layers: unknown[], userLayer: Record<string, unknown>, user: Record<string, unknown>) {
  const otherLayers = layers.map(record).filter((layer) => layer !== userLayer && !layer.disabledReason)
  return Object.fromEntries(Object.keys(user).map((name) => [name,
    !otherLayers.some((layer) => Object.hasOwn(record(record(layer.config).mcp_servers), name))]))
}

/** No workflow/Operator credentials, thread, model turn or legacy exec invocation. */
export class CodexMcpConnections implements NativeMcpAdapter {
  constructor(private readonly binary: string | (() => string), private readonly directory: string,
    private readonly processRecovery?: NativeProcessRecovery,
    private readonly installLauncher: (signal: AbortSignal) => Promise<void> = installAppLauncher,
    private readonly environment: NodeJS.ProcessEnv = process.env) {}
  private async control<T>(work: (transport: CodexStdioTransport, binary: string, environment: NodeJS.ProcessEnv) => Promise<T>, signal: AbortSignal): Promise<T> {
    const environment: NodeJS.ProcessEnv = { ...this.environment, NO_COLOR: '1' }
    for (const key of Object.keys(environment)) if (/^(?:GRAPHQL_|FOREMAN_CODE_|OPERATOR_|DATABASE_URL$|TEST_DATABASE_URL$|PGPASSWORD$)/.test(key)) delete environment[key]
    const binary = typeof this.binary === 'string' ? this.binary : this.binary()
    const qualified = await qualifyCodex(binary, this.directory, environment, false, signal)
    await assertCodexUnchanged(qualified)
    const transport = new CodexStdioTransport(qualified.binary, this.directory, environment, qualified.protocol,
      async () => { throw new DomainError('MCP_UNEXPECTED_INTERACTION', 'A configuration operation requested an unexpected interaction.', 409) },
      () => undefined, () => undefined, 30_000, this.processRecovery)
    try { await transport.start(signal); return await work(transport, qualified.binary, environment) } finally { await transport.close() }
  }
  private async inspect(transport: CodexStdioTransport, binary: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<NativeMcpSnapshot> {
    const result = record(await transport.request('config/read', { includeLayers: true, cwd: this.directory }, signal))
    if (!Array.isArray(result.layers)) throw new DomainError('MCP_CONFIG_LAYERS_UNAVAILABLE', 'Codex did not expose configuration-layer ownership.', 503)
    const userLayer = result.layers.map(record).find((layer) => record(layer.name).type === 'user')
    if (!userLayer || typeof userLayer.version !== 'string' || typeof record(userLayer.name).file !== 'string') {
      throw new DomainError('MCP_USER_CONFIG_UNAVAILABLE', 'Create the native Codex user configuration before managing connections here.', 409)
    }
    const userConfig = record(userLayer.config)
    const user = record(userConfig.mcp_servers)
    // ConfigReadResponse.config can omit untyped keys. Native mcp list exposes
    // resolved transport/auth references; neither values nor layer order imply ownership.
    const listing = await runCommand(binary, ['mcp', 'list', '--json'], this.directory, signal, environment)
    if (listing.exitCode !== 0) throw new DomainError('MCP_CONFIG_UNAVAILABLE', 'Codex could not list its native MCP connections.', 503)
    const payload: unknown = JSON.parse(listing.stdout)
    if (!Array.isArray(payload) || payload.length > 500) throw new DomainError('MCP_CATALOG_INVALID', 'Codex returned an invalid MCP catalog.', 502)
    const effective: Record<string, unknown> = Object.create(null)
    for (const item of payload) {
      const entry = record(item)
      const transport = record(entry.transport)
      if (typeof entry.name !== 'string' || typeof entry.enabled !== 'boolean'
        || !['stdio', 'streamable_http'].includes(String(transport.type)) || Object.hasOwn(effective, entry.name)) {
        throw new DomainError('MCP_CATALOG_INVALID', 'Codex returned an unsupported MCP catalog entry.', 502)
      }
      effective[entry.name] = { ...transport, enabled: entry.enabled, disabled_reason: entry.disabled_reason }
    }
    const after = record(await transport.request('config/read', { includeLayers: true, cwd: this.directory }, signal))
    if (fingerprint(result.layers) !== fingerprint(after.layers)) throw new DomainError('REVISION_CONFLICT', 'Native configuration changed while it was inspected.', 409)
    const file = String(record(userLayer.name).file)
    const ownership = codexMcpOwnership(result.layers, userLayer, user)
    return { harness: 'codex', user, userConfig, effective, file, version: userLayer.version, ownership,
      revision: fingerprint([userLayer.version, effective, file, result.layers]) }
  }
  read(signal: AbortSignal): Promise<NativeMcpSnapshot> { return this.control((transport, binary, environment) => this.inspect(transport, binary, environment, signal), signal) }
  async apply(snapshot: NativeMcpSnapshot, change: HarnessMcpChange, signal: AbortSignal,
    managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): Promise<void> {
    return withNativeMcpDelivery(async (writing) => {
      const edits = mcpEdits(snapshot, change, managed)
      await this.control(async (transport, binary, environment) => {
        const current = await this.inspect(transport, binary, environment, signal)
        if (current.revision !== snapshot.revision) throw new DomainError('REVISION_CONFLICT', 'Native MCP configuration changed. Refresh and review a new change.', 409)
        const file = await resolveNativeUserFile(current.file)
        const source = await readNativeUserFile(file, { whenMissing: '', requireDirectory: true })
        await backupNativeUserFile(file, source)
        signal.throwIfAborted()
        if (managed?.preset === 'graphql' && change.kind === 'add') await this.installLauncher(signal)
        signal.throwIfAborted()
        // A later error cannot establish whether the native write was delivered.
        writing()
        await transport.request('config/batchWrite', { edits: edits.map((edit) => ({ keyPath: `mcp_servers.${edit.name}`, value: edit.value ?? null, mergeStrategy: 'replace' })),
          expectedVersion: current.version, filePath: file, reloadUserConfig: true }, signal)
        const after = await this.inspect(transport, binary, environment, signal)
        const expected = applyMcpEdits(current.user, edits)
        if (fingerprint({ ...current.userConfig, mcp_servers: expected }) !== fingerprint({ ...after.userConfig, mcp_servers: after.user })) throw new DomainError('MCP_WRITE_UNCONFIRMED', 'The native write could not be confirmed. Do not retry it automatically.', 409)
      }, signal)
    })
  }
}
