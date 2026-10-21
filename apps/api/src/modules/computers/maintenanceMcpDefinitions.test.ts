import { expect, it } from 'vitest'
import type { MaintainedHarness, SyncedMcpServer } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer, settle } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

const http = (url = 'https://docs.example/mcp', token: string | null = null): SyncedMcpServer => ({
  name: 'docs', transport: 'http', url, bearerTokenEnvVar: token,
})
const stdio = (command = 'server', args = ['serve']): SyncedMcpServer => ({
  name: 'docs', transport: 'stdio', command, args, envVars: [],
})

async function sync(computer: ReturnType<typeof fakeComputer>, harness: MaintainedHarness, server: SyncedMcpServer) {
  await computer.maintenance.start({ kind: 'sync-mcp', servers: { [harness]: [server] } })
  return (await settle(computer)).tasks[0]!
}

function definition(computer: ReturnType<typeof fakeComputer>, harness: MaintainedHarness) {
  if (harness === 'codex') return computer.codexDefinitions.get('docs')
  return computer.claudeMcp.get('docs')
}

const changes: [string, SyncedMcpServer, SyncedMcpServer][] = [
  ['URL', http(), http('https://updated.example/mcp')],
  ['executable', stdio(), stdio('updated-server')],
  ['arguments', stdio(), stdio('server', ['serve', '--verbose'])],
  ['HTTP to stdio', http(), stdio()],
  ['stdio to HTTP', stdio(), http()],
]

it.each((['codex', 'claude'] as const).flatMap(harness => changes.map(change => [harness, ...change] as const)))(
  'updates a managed %s definition after a %s change and verifies native values', async (harness, _kind, before, after) => {
    const computer = fakeComputer()
    expect(await sync(computer, harness, before)).toMatchObject({ state: 'succeeded' })
    const original = definition(computer, harness)
    computer.maintenance = new ComputerMaintenance(computer.ports)
    expect(await sync(computer, harness, after)).toMatchObject({ state: 'succeeded', summary: expect.stringContaining('Updated docs') })
    expect(definition(computer, harness)).not.toEqual(original)
    expect(definition(computer, harness)).toMatchObject(after.transport === 'http'
      ? { url: after.url } : { command: after.command, args: after.args })
    const mutations = computer.calls.filter(call => ['add', 'add-json', 'remove'].includes(call.args[1]!)).length
    expect(await sync(computer, harness, after)).toMatchObject({ state: 'succeeded', summary: expect.stringContaining('Already in sync') })
    expect(computer.calls.filter(call => ['add', 'add-json', 'remove'].includes(call.args[1]!))).toHaveLength(mutations)
  },
)

it.each([['OLD_TOKEN', 'UPDATED_TOKEN'], ['OLD_TOKEN', null], [null, 'UPDATED_TOKEN']])(
  'updates the managed Codex bearer variable from %s to %s', async (before, after) => {
    const computer = fakeComputer()
    await sync(computer, 'codex', http(undefined, before))
    expect(await sync(computer, 'codex', http(undefined, after))).toMatchObject({ state: 'succeeded' })
    expect(definition(computer, 'codex')).toMatchObject({ bearer_token_env_var: after })
  },
)

it.each(['codex', 'claude'] as const)('preserves an unmanaged %s entry with the same name', async harness => {
  const computer = fakeComputer()
  const local = { type: 'stdio', command: 'local-server', args: ['local'] }
  if (harness === 'codex') {
    computer.codexMcp.add('docs')
    computer.codexDefinitions.set('docs', local)
  } else computer.claudeMcp.set('docs', local)
  expect(await sync(computer, harness, http())).toMatchObject({ state: 'succeeded' })
  expect(definition(computer, harness)).toEqual(local)
  expect(computer.calls.filter(call => ['add', 'add-json', 'remove'].includes(call.args[1]!))).toEqual([])
})

it.each(['codex', 'claude'] as const)('fails %s sync when native readback retains the old definition, then retries', async harness => {
  const computer = fakeComputer()
  await sync(computer, harness, http())
  const original = definition(computer, harness)
  const run = computer.ports.run
  computer.ports.run = async (binary, args, options) => {
    const result = await run(binary, args, options)
    if (args[0] === 'mcp' && ['add', 'add-json'].includes(args[1]!)) {
      if (harness === 'codex') computer.codexDefinitions.set('docs', original)
      else computer.claudeMcp.set('docs', original)
    }
    return result
  }
  const updated = http('https://updated.example/mcp')
  expect(await sync(computer, harness, updated)).toMatchObject({ state: 'failed', summary: expect.stringContaining('readback') })
  computer.ports.run = run
  expect(await sync(computer, harness, updated)).toMatchObject({ state: 'succeeded' })
  expect(definition(computer, harness)).toMatchObject({ url: updated.transport === 'http' ? updated.url : '' })
})

it.each(['codex', 'claude'] as const)('retains ownership after %s replacement fails so a later sync retries', async harness => {
  const computer = fakeComputer()
  await sync(computer, harness, http())
  computer.fail((_binary, args) => ['add', 'add-json'].includes(args[1]!))
  const updated = http('https://updated.example/mcp')
  expect(await sync(computer, harness, updated)).toMatchObject({ state: 'failed' })
  computer.fail(() => false)
  computer.maintenance = new ComputerMaintenance(computer.ports)
  expect(await sync(computer, harness, updated)).toMatchObject({ state: 'succeeded' })
  expect(definition(computer, harness)).toMatchObject({ url: 'https://updated.example/mcp' })
})

it('reports a failed Codex add even when it saved the definition before a connection error', async () => {
  const computer = fakeComputer()
  const run = computer.ports.run
  computer.ports.run = async (binary, args, options) => {
    const result = await run(binary, args, options)
    if (args[0] === 'mcp' && args[1] === 'add') {
      return { ...result, code: 1, stderr: 'Connection reset while inspecting the server' }
    }
    return result
  }
  const task = await sync(computer, 'codex', http())
  expect(task).toMatchObject({ state: 'failed', summary: 'codex mcp add docs failed.' })
  expect(task.outputTail).toContain('Connection reset')
  expect(task.summary).not.toContain('sign in')
})
