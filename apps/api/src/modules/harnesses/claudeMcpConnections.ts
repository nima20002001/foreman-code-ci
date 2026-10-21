import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { HarnessMcpChange, HarnessMcpManagedPreset } from '@foreman-code/contracts/management'
import { APP_MCP_TOKEN } from './appMcpLauncher.js'
import { backupNativeUserFile, readNativeUserFile, resolveNativeUserFile, syncNativeConfigDirectory } from './nativeConfigFiles.js'
import { applyMcpEdits, fingerprint, mcpEdits, record, type NativeMcpAdapter, type NativeMcpSnapshot } from './nativeMcpCommon.js'
import { DomainError } from '../errors.js'

/** Claude's user file retains login metadata and all unrelated native MCP connections. */
export class ClaudeMcpConnections implements NativeMcpAdapter {
  constructor(private readonly file: string) {}
  async read(signal: AbortSignal): Promise<NativeMcpSnapshot> {
    signal.throwIfAborted()
    const text = await readNativeUserFile(this.file, { whenMissing: '{}' })
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new DomainError('MCP_CONFIG_INVALID', 'Claude user configuration must be an object.', 409)
    }
    const userConfig = record(value)
    if (userConfig.mcpServers !== undefined && (!userConfig.mcpServers
      || typeof userConfig.mcpServers !== 'object' || Array.isArray(userConfig.mcpServers))) {
      throw new DomainError('MCP_CONFIG_INVALID', 'Claude MCP configuration must be an object.', 409)
    }
    const raw = record(userConfig.mcpServers)
    const user = Object.fromEntries(Object.entries(raw).map(([name, value]) => {
      const entry = record(value)
      const env = record(entry.env)
      if (env[APP_MCP_TOKEN] !== '${FOREMAN_CODE_MCP_TOKEN}' || Object.keys(env).length !== 1) return [name, entry]
      const settings = { ...entry }
      delete settings.env
      delete settings.type
      return [name, { ...settings, env_vars: [APP_MCP_TOKEN] }]
    }))
    return { harness: 'claude', userConfig: { ...userConfig, mcpServers: user }, user, effective: user, file: this.file,
      version: fingerprint(userConfig), revision: fingerprint(userConfig) }
  }
  async apply(snapshot: NativeMcpSnapshot, change: HarnessMcpChange, signal: AbortSignal,
    managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): Promise<void> {
    if ((await this.read(signal)).revision !== snapshot.revision) throw new DomainError('REVISION_CONFLICT', 'Claude configuration changed.', 409)
    const changes = mcpEdits(snapshot, change, managed)
    const native = changes.map(edit => {
      if (!edit.value || !Array.isArray(edit.value.env_vars)) return edit
      const entry = { ...edit.value }
      delete entry.env_vars
      return { ...edit, value: { ...entry, type: 'stdio', env: { [APP_MCP_TOKEN]: '${FOREMAN_CODE_MCP_TOKEN}' } } }
    })
    const source = record(JSON.parse(await readNativeUserFile(this.file, { whenMissing: '{}' })))
    const updated = { ...source, mcpServers: applyMcpEdits(record(source.mcpServers), native) }
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const file = await resolveNativeUserFile(this.file)
    const original = await readNativeUserFile(file, { whenMissing: '{}' })
    await backupNativeUserFile(file, original)
    const temporary = `${file}.${randomUUID()}`
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try { await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`); await handle.sync() }
      finally { await handle.close() }
      signal.throwIfAborted()
      if ((await this.read(signal)).revision !== snapshot.revision) throw new DomainError('REVISION_CONFLICT', 'Claude configuration changed.', 409)
      await rename(temporary, file)
      await syncNativeConfigDirectory(file)
    } finally { await rm(temporary, { force: true }) }
  }
}
