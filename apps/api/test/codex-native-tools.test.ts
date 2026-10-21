import { object } from '../src/modules/harnesses/codexStdioTransport.js'
import { describe, expect, it } from 'vitest'
import { manager, source, json, wire, f, useCodexFixture } from './codex-app-server.test-support.js'
import { calls } from './fixtures/codex-test-helpers.js'

describe('Codex native tool loading', () => {
  useCodexFixture({ requestTimeoutMs: 5_000 })

  it('disables every excluded configured server and apps while keeping Foreman Code', async () => {
    await json('mcp-list.json', ['graphql', 'foreman-code', 'linear', 'codex_apps', 'calendar']
      .map(name => ({ name })))
    source.request.configuration.nativeTools = { mcpServers: ['linear'], apps: false }
    await manager.createSession(source)
    const config = object((await wire('thread/start')).at(-1)!.params).config
    expect(config).toMatchObject({ 'mcp_servers.calendar.enabled': false,
      'mcp_servers.codex_apps.enabled': false, 'features.apps': false })
    for (const name of ['graphql', 'foreman-code', 'linear']) {
      expect(config).not.toHaveProperty(`mcp_servers.${name}.enabled`)
    }
    const launches = (await calls(f.directory)).flatMap(entry =>
      Array.isArray(entry.cli) && entry.cli[0] === 'app-server' ? [entry.cli] : [])
    expect(launches.at(-1)).toEqual(expect.arrayContaining([
      'mcp_servers.calendar.enabled=false', 'mcp_servers.codex_apps.enabled=false', 'features.apps=false',
    ]))
  })

  it.each([undefined, {}])('keeps host loading when policy is inherited: %j', async policy => {
    await json('mcp-list.json', [{ name: 'linear' }, { name: 'codex_apps' }])
    if (policy) source.request.configuration.nativeTools = policy
    await manager.createSession(source)
    const config = object((await wire('thread/start')).at(-1)!.params).config
    expect(config).not.toHaveProperty('mcp_servers.linear.enabled')
    expect(config).not.toHaveProperty('mcp_servers.codex_apps.enabled')
    expect(config).not.toHaveProperty('features.apps')
  })

  it('reapplies the policy when attaching a native session', async () => {
    await json('mcp-list.json', [{ name: 'graphql' }, { name: 'linear' }])
    source.request.configuration.nativeTools = { mcpServers: [], apps: true }
    const session = await manager.createSession(source)
    await manager.close(session)
    await manager.attachSession(session, source)
    expect(object((await wire('thread/resume')).at(-1)!.params).config).toMatchObject({
      'mcp_servers.linear.enabled': false, 'features.apps': false,
    })
  })

  it.each([false, true, undefined])('excludes unlisted compatibility apps with apps=%j', async apps => {
    await json('mcp-list.json', [{ name: 'foreman-code' }, { name: 'linear' }])
    source.request.configuration.nativeTools = { mcpServers: [], ...(apps !== undefined ? { apps } : {}) }
    await manager.createSession(source)
    const config = object((await wire('thread/start')).at(-1)!.params).config
    expect(config).toMatchObject({ 'mcp_servers.linear.enabled': false, 'features.apps': false })
    expect(config).not.toHaveProperty('mcp_servers.codex_apps.enabled')
    const launches = (await calls(f.directory)).flatMap(entry =>
      Array.isArray(entry.cli) && entry.cli[0] === 'app-server' ? [entry.cli] : [])
    expect(launches.length).toBeGreaterThan(0)
    for (const launch of launches) {
      expect(launch).toContain('features.apps=false')
      expect(launch).not.toContain('mcp_servers.codex_apps.enabled=false')
    }
  })

  it.each([true, undefined])('allows compatibility apps explicitly in the allowlist with apps=%j', async apps => {
    await json('mcp-list.json', [{ name: 'foreman-code' }])
    source.request.configuration.nativeTools = {
      mcpServers: ['codex_apps'], ...(apps !== undefined ? { apps } : {}),
    }
    await manager.createSession(source)
    const config = object((await wire('thread/start')).at(-1)!.params).config
    if (apps === true) expect(config).toHaveProperty('features.apps', true)
    else expect(config).not.toHaveProperty('features.apps')
    expect(config).not.toHaveProperty('mcp_servers.codex_apps.enabled')
  })

  it('disables a plugin-backed MCP server with its real transport declaration', async () => {
    await json('mcp-list.json', [{ name: 'plugin_calendar', transport: {
      type: 'streamable_http', url: 'https://calendar.example/mcp',
    } }])
    source.request.configuration.nativeTools = { mcpServers: [] }
    await manager.createSession(source)
    expect(object((await wire('thread/start')).at(-1)!.params).config).toMatchObject({
      'mcp_servers.plugin_calendar.enabled': false,
      'mcp_servers.plugin_calendar.url': 'https://calendar.example/mcp',
    })
    const launches = (await calls(f.directory)).flatMap(entry =>
      Array.isArray(entry.cli) && entry.cli[0] === 'app-server' ? [entry.cli] : [])
    for (const launch of launches) {
      expect(launch).toContain('mcp_servers.plugin_calendar.url="https://calendar.example/mcp"')
      expect(launch).toContain('mcp_servers.plugin_calendar.enabled=false')
    }
  })

  it('fails before starting a thread when native server discovery is invalid', async () => {
    await json('mcp-list.json', { invalid: true })
    source.request.configuration.nativeTools = { mcpServers: [] }
    await expect(manager.createSession(source)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_MCP_INSPECTION_FAILED' } },
    })
    expect(await wire('thread/start')).toEqual([])
  })

  it('fails before native launch when an excluded server has no transport', async () => {
    await json('mcp-list.json', [{ name: 'linear', transport: {} }])
    source.request.configuration.nativeTools = { mcpServers: [] }
    await expect(manager.createSession(source)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_MCP_INSPECTION_FAILED' } },
    })
    expect(await wire('thread/start')).toEqual([])
    const launches = (await calls(f.directory)).filter(entry => Array.isArray(entry.cli)
      && entry.cli[0] === 'app-server')
    expect(launches).toEqual([])
  })
})
