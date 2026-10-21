import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { CodexMcpConnections } from '../src/modules/harnesses/codexMcpConnections.js'
import { managedChange } from '../src/modules/harnesses/nativeMcpCommon.js'
import { heldLauncher } from './helpers/launcherLock.js'

const native = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn() }))
vi.mock('../src/modules/harnesses/codexProtocol.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexProtocol.js')>(),
  qualifyCodex: async () => ({ binary: '/recorded/codex', protocol: {} }),
  assertCodexUnchanged: async () => {},
}))
vi.mock('../src/modules/harnesses/process.js', () => ({
  runCommand: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),
}))
vi.mock('../src/modules/harnesses/codexStdioTransport.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    async start() {}
    request(method: string, params: unknown, signal?: AbortSignal) { return native.request(method, params, signal) }
    async close() { native.close() }
  },
}))

it('cancels a managed launcher lock wait before submitting a native configuration write', async () => {
  const fixture = await heldLauncher()
  const controller = new AbortController()
  const file = join(dirname(fixture.launcher), 'config.toml')
  const endpoint = 'http://127.0.0.1:3000/mcp'
  native.close.mockClear()
  native.request.mockReset().mockImplementation(async method => {
    if (method === 'config/read') return { layers: [{ name: { type: 'user', file }, version: '1', config: {} }] }
    throw new Error('Unexpected native write')
  })
  vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(fixture.launcher))
  try {
    const adapter = new CodexMcpConnections('/recorded/codex', dirname(file))
    const snapshot = await adapter.read(controller.signal)
    const installing = adapter.apply(snapshot, managedChange('graphql', true, endpoint), controller.signal,
      { preset: 'graphql', endpoint })
    const rejected = expect(installing).rejects.toMatchObject({ name: 'NativeMcpNotSubmittedError' })
    await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(4))
    expect(await Promise.race([installing.then(() => 'finished', () => 'rejected'), delay(30, 'waiting')])).toBe('waiting')
    controller.abort(new Error('Settings deadline expired'))
    await rejected
    expect(native.request.mock.calls.map(call => call[0])).toEqual(Array(4).fill('config/read'))
    expect(native.close).toHaveBeenCalledTimes(2)
    await fixture.release()
    await delay(30)
    expect(await readFile(fixture.launcher, 'utf8')).toBe('original launcher')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    controller.abort()
    vi.unstubAllEnvs()
    await fixture.close()
  }
}, 5000)
