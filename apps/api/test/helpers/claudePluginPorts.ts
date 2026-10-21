import type { MaintenancePorts } from '../../src/modules/computers/maintenance.js'

export function claudePluginPorts() {
  const installed = new Map<string, { version: string; enabled: boolean }>()
  const marketplaces = new Map<string, string>()
  const changes: string[] = []
  const files = new Map<string, string>()
  const available = ['notes', 'review', 'command'].map(name => ({
    pluginId: `${name}@official`, name, description: `${name} tools`, marketplaceName: 'official', installCount: 10,
  }))
  const ports: MaintenancePorts = {
    environment: { HOME: '/home/owner' },
    find: async name => ['claude', 'npm'].includes(name) ? `/usr/bin/${name}` : null,
    run: async (binary, args) => {
      if (binary === 'sudo') return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
      if (args[0] === 'view') return { code: 0, stdout: '2.1.294', stderr: '' }
      const result = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: '' })
      if (args[0] === '--version') return result('2.1.294 (Claude Code)')
      if (args[1] === 'list') return result({
        installed: [...installed].map(([id, item]) => ({ id, scope: 'user', ...item })), available,
      })
      if (args[1] === 'marketplace') {
        if (args[2] === 'list') return result([...marketplaces].map(([name, repo]) => ({ name, source: 'github', repo })))
        if (args[2] === 'update') {
          if (!marketplaces.has(args[3]!)) return result({ outcome: 'error' }, 1)
          changes.push(`marketplace:update:${args[3]}`)
          return result({ outcome: 'ok' })
        }
        changes.push(`marketplace:${args[3]}`)
        marketplaces.set(args[3]!.split('/').at(-1)!.replace(/\.git$/, ''), args[3]!)
        return result({ outcome: 'ok' })
      }
      const id = args[2]!
      if (id === 'command@official') return result({
        outcome: 'needs_confirmation', shownCommand: { command: 'download-plugin', sha256: 'a'.repeat(64) },
      }, 1)
      changes.push(`${args[1]}:${id}`)
      const plugin = installed.get(id)
      if (args[1] === 'install') installed.set(id, { version: '1.0.0', enabled: true })
      if (args[1] === 'uninstall') installed.delete(id)
      if (plugin && args[1] === 'disable') plugin.enabled = false
      if (plugin && args[1] === 'enable') plugin.enabled = true
      return result({ outcome: 'ok' })
    },
    exists: async () => false,
    readText: async path => files.get(path) ?? null,
    writePrivateText: async (path, text) => { files.set(path, text) },
    disk: async () => ({ freeBytes: 50, totalBytes: 100 }),
    later: () => {},
    now: () => new Date(),
  }
  return { ports, installed, marketplaces, changes }
}
