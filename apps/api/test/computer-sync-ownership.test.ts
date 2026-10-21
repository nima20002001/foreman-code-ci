import { describe, expect, it } from 'vitest'
import { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
import { fakeComputer, mcpRequest, pluginRequest, settle } from './helpers/fleetSync.js'

describe('fleet sync ownership', () => {
  it('preserves same-name local MCP servers and plugins, including Claude enabled state', async () => {
    const computer = fakeComputer()
    computer.codexMcp.add('docs')
    const localDefinition = { type: 'http', url: 'https://receiver.example/mcp' }
    computer.claudeMcp.set('docs', localDefinition)
    computer.codexPlugins.add('notes@official')
    computer.claudePlugins.set('notes@official', false)
    await computer.maintenance.start(mcpRequest(['docs']))
    await computer.maintenance.start(pluginRequest(['notes@official']))
    expect((await settle(computer)).tasks.every(task => task.state === 'succeeded')).toBe(true)
    expect(computer.claudePlugins.get('notes@official')).toBe(false)
    await computer.maintenance.start(mcpRequest([]))
    await computer.maintenance.start(pluginRequest([]))
    await settle(computer)
    expect([...computer.codexMcp]).toEqual(['docs'])
    expect([...computer.claudeMcp]).toEqual([['docs', localDefinition]])
    expect([...computer.codexPlugins]).toEqual(['notes@official'])
    expect([...computer.claudePlugins]).toEqual([['notes@official', false]])
  })

  it.each(['codex', 'claude'])('retains successful %s MCP additions when another addition fails', async harness => {
    const computer = fakeComputer()
    computer.fail((binary, args) => binary.endsWith(harness)
      && ['add', 'add-json'].includes(args[1]!) && args.includes('bad'))
    await computer.maintenance.start(mcpRequest(['good', 'bad']))
    expect((await settle(computer)).tasks[0]?.state).toBe('failed')
    computer.maintenance = new ComputerMaintenance(computer.ports)
    computer.fail(() => false)
    await computer.maintenance.start(mcpRequest([]))
    expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
    expect([...computer.codexMcp]).toEqual([])
    expect([...computer.claudeMcp]).toEqual([])
  })

  it.each(['codex', 'claude'])('retains successful %s plugin installs when another install fails', async harness => {
    const computer = fakeComputer()
    computer.fail((binary, args) => binary.endsWith(harness)
      && ['add', 'install'].includes(args[1]!) && args[2] === 'bad@official')
    await computer.maintenance.start(pluginRequest(['good@official', 'bad@official']))
    expect((await settle(computer)).tasks[0]?.state).toBe('failed')
    computer.maintenance = new ComputerMaintenance(computer.ports)
    computer.fail(() => false)
    await computer.maintenance.start(pluginRequest([]))
    expect((await settle(computer)).tasks[0]?.state).toBe('succeeded')
    expect([...computer.codexPlugins]).toEqual([])
    expect([...computer.claudePlugins]).toEqual([])
  })

  it('retains failed removals and successful new entries until a later sync removes them', async () => {
    const computer = fakeComputer()
    await computer.maintenance.start(mcpRequest(['old']))
    await computer.maintenance.start(pluginRequest(['old@official']))
    await settle(computer)
    computer.fail((_binary, args) => ['remove', 'uninstall'].includes(args[1]!))
    await computer.maintenance.start(mcpRequest(['new']))
    await computer.maintenance.start(pluginRequest(['new@official']))
    expect((await settle(computer)).tasks.slice(0, 2).every(task => task.state === 'failed')).toBe(true)
    computer.maintenance = new ComputerMaintenance(computer.ports)
    computer.fail(() => false)
    await computer.maintenance.start(mcpRequest([]))
    await computer.maintenance.start(pluginRequest([]))
    await settle(computer)
    expect([...computer.codexMcp]).toEqual([])
    expect([...computer.claudeMcp]).toEqual([])
    expect([...computer.codexPlugins]).toEqual([])
    expect([...computer.claudePlugins]).toEqual([])
  })

  it('retains a Claude installation even if enabled-state readback fails afterwards', async () => {
    const computer = fakeComputer()
    let lists = 0
    computer.fail((binary, args) => binary.endsWith('claude') && args[0] === 'plugin'
      && args[1] === 'list' && ++lists > 1)
    await computer.maintenance.start(pluginRequest(['good@official']))
    expect((await settle(computer)).tasks[0]?.state).toBe('failed')
    computer.maintenance = new ComputerMaintenance(computer.ports)
    computer.fail(() => false)
    await computer.maintenance.start(pluginRequest([]))
    await settle(computer)
    expect([...computer.claudePlugins]).toEqual([])
  })
})
