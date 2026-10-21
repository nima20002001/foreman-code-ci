import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
import { createWorkerRuntimeDrain } from '../src/modules/devices/installedWorkerDomains.js'
import { fakeComputer, fakeFleet, mcpRequest, pluginRequest, settle } from './helpers/fleetSync.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const signal = () => AbortSignal.timeout(10_000)

describe('maintenance command recovery', () => {
  it('replays completed receiver work after restart and recent-task eviction', async () => {
    const computer = fakeComputer()
    const commandId = randomUUID()
    const request = mcpRequest(['docs'])
    const original = await computer.maintenance.start(request, commandId)
    await settle(computer)
    const completed = (await computer.maintenance.status(signal())).tasks.find(task => task.id === original.id)
    for (let index = 0; index < 21; index++) {
      await computer.maintenance.start(mcpRequest(['docs']))
      await settle(computer)
    }
    computer.maintenance = new ComputerMaintenance(computer.ports)
    expect((await computer.maintenance.status(signal())).tasks.some(task => task.id === original.id)).toBe(false)
    expect(await computer.maintenance.start(request, commandId)).toEqual(completed)
    expect(computer.calls.filter(call => call.args[0] === 'mcp' && call.args[1] === 'add')).toHaveLength(1)
    await expect(computer.maintenance.start(mcpRequest(['changed']), commandId))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })

  it('recovers an interrupted command without repeating an accepted native operation', async () => {
    const computer = fakeComputer()
    const blocked = gate()
    const run = computer.ports.run
    let installed = false
    computer.ports.run = async (binary, args, options) => {
      const result = await run(binary, args, options)
      if (args[0] === 'mcp' && args[1] === 'add') {
        installed = true
        await blocked.promise
      }
      return result
    }
    const commandId = randomUUID()
    const request = mcpRequest(['docs'])
    await computer.maintenance.start(request, commandId)
    await expect.poll(() => installed).toBe(true)
    const files = new Map(computer.files)
    const recovered = new ComputerMaintenance({ ...computer.ports,
      readText: async path => files.get(path) ?? null,
      writePrivateText: async (path, text) => { files.set(path, text) },
    })
    const replay = await recovered.start(request, commandId)
    expect(replay).toMatchObject({ id: commandId, state: 'failed', summary: expect.stringContaining('interrupted') })
    expect(computer.calls.filter(call => call.args[0] === 'mcp' && call.args[1] === 'add')).toHaveLength(1)
    blocked.release()
    await computer.maintenance.drain()
  })
})

describe('fleet synchronization ordering and ownership', () => {
  it('queues the final A behind B instead of reusing an earlier running A', async () => {
    const computer = fakeComputer()
    const blocked = gate()
    const run = computer.ports.run
    let waiting = false
    computer.ports.run = async (binary, args, options) => {
      if (!waiting && args[0] === 'mcp' && args[1] === 'list') {
        waiting = true
        await blocked.promise
      }
      return run(binary, args, options)
    }
    const first = await computer.maintenance.start(mcpRequest(['a']))
    await expect.poll(() => waiting).toBe(true)
    const second = await computer.maintenance.start(mcpRequest(['b']))
    const final = await computer.maintenance.start(mcpRequest(['a']))
    expect(final.id).not.toBe(first.id)
    expect(final.id).not.toBe(second.id)
    blocked.release()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual(['a'])
    expect([...computer.claudeMcp.keys()]).toEqual(['a'])
  })

  it('marks the final A delivered only after its queued successor completes', async () => {
    const computer = fakeComputer()
    const blocked = gate()
    const run = computer.ports.run
    let waiting = false
    computer.ports.run = async (binary, args, options) => {
      if (!waiting && args[0] === 'mcp' && args[1] === 'list') {
        waiting = true
        await blocked.promise
      }
      return run(binary, args, options)
    }
    const { fleet, sources, requested } = fakeFleet(computer)
    let name = 'a'
    sources.codexUserMcpServers = async () => ({ [name]: { url: `https://${name}.example/mcp` } })
    await fleet.syncChangedSources()
    await expect.poll(() => waiting).toBe(true)
    name = 'b'
    await fleet.syncChangedSources()
    name = 'a'
    await fleet.syncChangedSources()
    blocked.release()
    await settle(computer)
    await fleet.syncChangedSources()
    await fleet.syncChangedSources()
    expect([...computer.codexMcp]).toEqual(['a'])
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(3)
  })

  it.each(['mcp', 'codex-plugin', 'claude-plugin'] as const)(
    'keeps %s ownership after native installation but before completion is recorded', async kind => {
      const computer = fakeComputer()
      computer.codexMcp.add('local')
      computer.codexPlugins.add('local@official')
      computer.claudePlugins.set('local@official', false)
      const blocked = gate()
      const run = computer.ports.run
      let installed = false
      computer.ports.run = async (binary, args, options) => {
        const result = await run(binary, args, options)
        const mcpInstall = kind === 'mcp' && args[0] === 'mcp' && args[1] === 'add'
        const codexInstall = kind === 'codex-plugin' && binary.endsWith('codex')
          && args[0] === 'plugin' && args[1] === 'add'
        const claudeInstall = kind === 'claude-plugin' && binary.endsWith('claude')
          && args[0] === 'plugin' && args[1] === 'install'
        if (mcpInstall || codexInstall || claudeInstall) {
          installed = true
          await blocked.promise
        }
        return result
      }
      const request = kind === 'mcp' ? mcpRequest(['local', 'fleet']) : pluginRequest(['local@official', 'fleet@official'])
      if (request.kind === 'sync-mcp') request.servers.claude = []
      if (request.kind === 'sync-plugins') {
        if (kind === 'codex-plugin') request.claudePlugins = []
        else request.plugins = []
      }
      await computer.maintenance.start(request)
      await expect.poll(() => installed).toBe(true)
      const files = new Map(computer.files)
      const recovered = new ComputerMaintenance({ ...computer.ports,
        readText: async path => path.endsWith('/.claude.json')
          ? JSON.stringify({ mcpServers: Object.fromEntries(computer.claudeMcp) }) : files.get(path) ?? null,
        writePrivateText: async (path, text) => { files.set(path, text) },
      })
      await recovered.start(kind === 'mcp' ? mcpRequest([]) : pluginRequest([]))
      await recovered.drain()
      expect([...computer.codexMcp]).toEqual(['local'])
      expect([...computer.codexPlugins]).toEqual(['local@official'])
      expect([...computer.claudePlugins]).toEqual([['local@official', false]])
      blocked.release()
      await computer.maintenance.drain()
    },
  )

  it('retries an unchanged MCP catalog after a missing harness becomes installed', async () => {
    const computer = fakeComputer()
    let now = Date.now()
    computer.ports.now = () => new Date(now)
    const find = computer.ports.find
    let installed = false
    computer.ports.find = name => name === 'codex' && !installed ? Promise.resolve(null) : find(name)
    const { fleet, requested } = fakeFleet(computer, () => now)
    await fleet.syncChangedSources()
    expect((await settle(computer)).tasks.find(task => task.kind === 'sync-mcp'))
      .toMatchObject({ state: 'failed', summary: expect.stringContaining('MCP sync remains pending') })
    installed = true
    await fleet.syncChangedSources()
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
    now += 5 * 60_000
    await fleet.syncChangedSources()
    await settle(computer)
    await fleet.syncChangedSources()
    expect([...computer.codexMcp]).toEqual(['docs'])
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(2)
  })

  it('does not install an MCP entry when its ownership reservation cannot be saved', async () => {
    const computer = fakeComputer()
    const write = computer.ports.writePrivateText
    computer.ports.writePrivateText = async (path, text) => {
      if (path.endsWith('fleet-sync.json')) throw new Error('Ownership storage is unavailable')
      await write(path, text)
    }
    await computer.maintenance.start(mcpRequest(['docs']))
    await computer.maintenance.drain()
    expect((await computer.maintenance.status(signal())).tasks[0])
      .toMatchObject({ state: 'failed', summary: 'Ownership storage is unavailable' })
    expect(computer.codexMcp.size).toBe(0)
    expect(computer.calls.some(call => call.args[0] === 'mcp' && call.args[1] === 'add')).toBe(false)
  })
})

describe('maintenance and protected Worker refresh', () => {
  it('waits for acknowledged native work and denies new maintenance while keeping status available', async () => {
    const computer = fakeComputer()
    const blocked = gate()
    const run = computer.ports.run
    let installing = false
    computer.ports.run = async (binary, args, options) => {
      if (args[0] === 'mcp' && args[1] === 'add') {
        installing = true
        await blocked.promise
      }
      return run(binary, args, options)
    }
    await computer.maintenance.start(mcpRequest(['docs']))
    await expect.poll(() => installing).toBe(true)
    let refreshed = false
    let drainingMaintenance = false
    const drain = createWorkerRuntimeDrain({ signal: signal(), active: () => [],
      drainJobs: async () => {}, drainQualifications: async () => {}, quiescent: async () => true,
      drainMaintenance: async () => { drainingMaintenance = true; await computer.maintenance.drain() },
    })
    const refresh = drain.run().then(() => { refreshed = true })
    await expect.poll(() => drainingMaintenance).toBe(true)
    expect(refreshed).toBe(false)
    expect(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }))
      .toThrow('waiting for active work')
    expect(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'status' })).not.toThrow()
    blocked.release()
    await refresh
    expect(refreshed).toBe(true)
    expect((await computer.maintenance.status(signal())).tasks[0]?.state).toBe('succeeded')
    drain.resume()
    expect(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' })).not.toThrow()
  })
})

describe('restart outcome', () => {
  it('stays running during the delay and records a rejected reboot command', async () => {
    const computer = fakeComputer()
    const callbacks: (() => void)[] = []
    computer.ports.later = callback => { callbacks.push(callback) }
    const run = computer.ports.run
    let reboots = 0
    computer.ports.run = async (binary, args, options) => {
      if (binary === 'sudo') {
        if (args.includes('reboot')) {
          reboots++
          return { code: 4, stdout: '', stderr: 'reboot denied' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      return run(binary, args, options)
    }
    const task = await computer.maintenance.start({ kind: 'restart' })
    await expect.poll(() => callbacks.length).toBe(1)
    expect((await computer.maintenance.status(signal())).tasks[0])
      .toMatchObject({ id: task.id, state: 'running', summary: 'Restart scheduled in a few seconds.' })
    expect(reboots).toBe(0)
    callbacks[0]!()
    await computer.maintenance.drain()
    expect((await computer.maintenance.status(signal())).tasks[0])
      .toMatchObject({ state: 'failed', summary: 'Restart command failed (exit 4).', outputTail: expect.stringContaining('reboot denied') })
  })

  it('reports interruption when the application stops before the reboot delay ends', async () => {
    const computer = fakeComputer()
    const callbacks: (() => void)[] = []
    computer.ports.later = callback => { callbacks.push(callback) }
    computer.ports.run = async () => ({ code: 0, stdout: '', stderr: '' })
    const commandId = randomUUID()
    await computer.maintenance.start({ kind: 'restart' }, commandId)
    await expect.poll(() => callbacks.length).toBe(1)
    const recovered = new ComputerMaintenance(computer.ports)
    expect(await recovered.start({ kind: 'restart' }, commandId))
      .toMatchObject({ state: 'failed', summary: expect.stringContaining('interrupted') })
    expect(callbacks).toHaveLength(1)
    callbacks[0]!()
    await computer.maintenance.drain()
  })
})
