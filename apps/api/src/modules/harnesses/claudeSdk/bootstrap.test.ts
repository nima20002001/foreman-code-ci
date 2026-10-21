import { afterEach, expect, it, vi } from 'vitest'

const selected = vi.hoisted(() => ({ packages: [] as string[] }))
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  return { ...actual, createRequire: () => ({ resolve: (name: string) => {
    if (name === '@anthropic-ai/claude-agent-sdk') return '/opt/fixture/node_modules/.pnpm/sdk/sdk.mjs'
    selected.packages.push(name)
    return '/opt/fixture/claude'
  } }) }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: async (path: string) => path }
})
vi.mock('./currentPin.js', () => ({
  createClaudeCurrentPinResolver: vi.fn(),
  discoverInstalledClaudeSdk: async (sdk: { selectedExecutable: string }) => sdk,
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['2.40', undefined])('reads libc once across repeated production discovery for glibc %s', async glibc => {
  vi.resetModules()
  selected.packages.length = 0
  const getReport = vi.fn(() => ({ header: { glibcVersionRuntime: glibc } }))
  // A proxy keeps process's event-emitter methods, which the logger registers at import.
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) =>
    key === 'platform' ? 'linux' : key === 'report' ? { getReport } : Reflect.get(target, key, target) }))
  const { createClaudeProductionDiscovery } = await import('./bootstrap.js')
  const discovery = () => createClaudeProductionDiscovery({
    registry: () => { throw new Error('Passive discovery must not use the registry') },
    factories: () => { throw new Error('Passive discovery must not use native factories') },
    workingDirectory: '/opt/fixture',
  })
  const environment = { generation: 'generation', provenance: 'systemd' as const, cwd: '/opt/fixture', path: '/usr/bin' }
  const host = { kind: 'main' as const, mainId: 'main' }
  for (let index = 0; index < 3; index++) {
    expect(await discovery().discover(host, environment)).toMatchObject({ selectedExecutable: '/opt/fixture/claude' })
  }
  expect(getReport).toHaveBeenCalledTimes(1)
  const target = glibc ? `linux-${process.arch}` : `linux-${process.arch}-musl`
  expect(selected.packages).toEqual(Array(3).fill(`@anthropic-ai/claude-agent-sdk-${target}/claude`))
})
