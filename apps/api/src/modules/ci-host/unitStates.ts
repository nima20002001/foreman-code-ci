import type { HostCiPorts } from './runner.js'

export type CiUnitState = 'active' | 'stopped' | 'unknown'

/** Id associates records with requests even when systemd returns them in a different order. */
export async function readCiUnitStates(
  ports: HostCiPorts, units: string[], environment: NodeJS.ProcessEnv,
): Promise<Map<string, CiUnitState>> {
  const states = new Map<string, CiUnitState>(units.map(unit => [unit, 'unknown']))
  if (!states.size) return states
  const result = await ports.run('systemctl', ['--user', 'show',
    '--property=Id', '--property=LoadState', '--property=ActiveState', ...states.keys()], { env: environment })
  if (result.code !== 0 || result.timedOut) return states
  for (const block of result.stdout.trim().split(/\n\s*\n/u)) {
    const fields = new Map(block.split('\n').map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
    const unit = fields.get('Id')
    if (!unit || !states.has(unit) || !fields.get('LoadState')) continue
    const active = fields.get('ActiveState')
    if (active && ['active', 'activating', 'reloading', 'deactivating'].includes(active)) {
      states.set(unit, 'active')
    } else if (active === 'inactive' || active === 'failed') {
      states.set(unit, 'stopped')
    }
  }
  return states
}
