import { expect, it } from 'vitest'
import { fakeComputer, settle } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

it('reselects the updated Claude installation before checking its version', async () => {
  const computer = fakeComputer()
  let selected = '/fixture/versions/old/claude'
  const observations: string[] = []
  const ports = { ...computer.ports,
    find: async (name: string) => name === 'claude' ? selected : computer.ports.find(name),
    async selectInstalledClaude() {
      observations.push('select')
      selected = '/fixture/versions/updated/claude'
      return selected
    },
    run: async (binary: string, args: string[], options: Parameters<typeof computer.ports.run>[2]) => {
      if (binary.endsWith('/claude') && args[0] === '--version') {
        observations.push(binary)
        return { code: 0, stdout: binary.includes('/updated/') ? '1.2.4' : '1.2.3', stderr: '' }
      }
      return computer.ports.run(binary, args, options)
    },
  }
  computer.maintenance = new ComputerMaintenance(ports)
  await computer.maintenance.start({ kind: 'update-harnesses', harnesses: ['claude'] })
  await computer.maintenance.drain()
  expect(observations).toEqual(['/fixture/versions/old/claude', 'select', '/fixture/versions/updated/claude'])
  expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Claude 1.2.3 → 1.2.4' })
})

it('reports a Claude reselection failure instead of verifying the stale executable', async () => {
  const computer = fakeComputer()
  const ports = { ...computer.ports, async selectInstalledClaude() { throw new Error('Updated launcher is unavailable') } }
  computer.maintenance = new ComputerMaintenance(ports)
  await computer.maintenance.start({ kind: 'update-harnesses', harnesses: ['claude'] })
  expect((await settle(computer)).tasks[0]).toMatchObject({ state: 'failed', summary: 'Updated launcher is unavailable' })
})
