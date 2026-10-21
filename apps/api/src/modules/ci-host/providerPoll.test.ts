import { expect, it, vi } from 'vitest'
import { invalidateProviderPoll, providerCommand, withProviderPoll } from './providerPoll.js'
import type { HostCiPorts } from './runner.js'

const ports: HostCiPorts = { run: vi.fn(), now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30 }
const args = ['run', 'get', 'fixture-pipeline']
it('shares reads within one account and keeps identical-port reads separate across accounts', async () => {
  const primary = vi.fn(async () => 'primary')
  const standby = vi.fn(async () => 'standby')
  await withProviderPoll(async () => {
    expect(await Promise.all([
      providerCommand(ports, 'circleci', args, primary, 'default'),
      providerCommand(ports, 'circleci', args, primary, 'default'),
      providerCommand(ports, 'circleci', args, standby, 'reserve'),
    ])).toEqual(['primary', 'primary', 'standby'])
    expect(await providerCommand(ports, 'circleci', args, standby, 'reserve')).toBe('standby')
  })
  expect(primary).toHaveBeenCalledTimes(1)
  expect(standby).toHaveBeenCalledTimes(1)
})
it('invalidates only the mutated account snapshot', async () => {
  const primary = vi.fn(async () => 'primary')
  const standby = vi.fn(async () => 'standby')
  await withProviderPoll(async () => {
    await providerCommand(ports, 'circleci', args, primary, 'default')
    await providerCommand(ports, 'circleci', args, standby, 'reserve')
    await providerCommand(ports, 'circleci', ['run', 'cancel', 'fixture-pipeline'], async () => '', 'reserve')
    await providerCommand(ports, 'circleci', args, primary, 'default')
    await providerCommand(ports, 'circleci', args, standby, 'reserve')
  })
  expect(primary).toHaveBeenCalledTimes(1)
  expect(standby).toHaveBeenCalledTimes(2)
})

it('invalidates a removed login without clearing another login’s in-flight reads', async () => {
  const primary = vi.fn(async () => 'primary')
  const standby = vi.fn(async () => 'standby')
  await withProviderPoll(async () => {
    await providerCommand(ports, 'circleci', args, primary, 'default')
    await providerCommand(ports, 'circleci', args, standby, 'reserve')
    invalidateProviderPoll(ports, 'reserve')
    await providerCommand(ports, 'circleci', args, primary, 'default')
    await providerCommand(ports, 'circleci', args, standby, 'reserve')
  })
  expect(primary).toHaveBeenCalledTimes(1)
  expect(standby).toHaveBeenCalledTimes(2)
})
