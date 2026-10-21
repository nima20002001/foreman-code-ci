import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { NativeProcessRegistry, type NativeProcessRecovery } from '../../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeMcpAdapter } from '../../src/modules/harnesses/nativeMcpCommon.js'
import { deviceManagedMcpFixture } from './deviceManagedMcp.js'

type NativeFixture = {
  adapter: NativeMcpAdapter
  owners: Set<string>
  failRead?: Error
}
const fixtures = new Map<string, NativeFixture>()

/** Models native owner admission and an exit that still requires registry confirmation. */
export class ManagedMcpCodexProcess implements NativeMcpAdapter {
  private readonly fixture: NativeFixture
  constructor(_binary: string, directory: string, private readonly recovery: NativeProcessRecovery) {
    const fixture = fixtures.get(directory)
    if (!fixture) throw new Error('Native MCP fixture unavailable')
    this.fixture = fixture
  }
  private start() {
    if (this.fixture.owners.has(this.recovery.owner)) {
      throw new Error('An earlier native process is still active or unconfirmed; recover it before starting another.')
    }
    this.fixture.owners.add(this.recovery.owner)
  }
  async read(signal: AbortSignal) {
    this.start()
    if (this.fixture.failRead) {
      const error = this.fixture.failRead
      delete this.fixture.failRead
      throw error
    }
    return this.fixture.adapter.read(signal)
  }
  async apply(...args: Parameters<NativeMcpAdapter['apply']>) {
    this.start()
    await this.fixture.adapter.apply(...args)
  }
}

export async function managedMcpNativeFixture() {
  const f = await deviceManagedMcpFixture()
  const native: NativeFixture = { adapter: f.adapters.codex, owners: new Set() }
  fixtures.set(f.directory, native)
  const registry = new NativeProcessRegistry(join(f.directory, 'processes'))
  vi.spyOn(registry, 'closeOwner').mockImplementation(async owner => native.owners.delete(owner))
  const configuration = { path: join(f.directory, 'workflow.json'), ownerUid: process.getuid!() }
  await writeFile(configuration.path, JSON.stringify({ schemaVersion: 1, codexBinary: '/fixture/codex',
    expectedVersion: '1.0.0', payloadPaths: [], appMcpLauncher: '/fixture/launcher' }), { mode: 0o600 })
  vi.stubEnv('CODEX_HOME', join(f.directory, 'codex-home'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(f.directory, 'claude-home'))
  return { ...f, native, registry, configuration,
    options: { stateDirectory: f.directory, configuration, availableConfiguration: () => configuration, registry },
    dispose: () => fixtures.delete(f.directory) }
}
