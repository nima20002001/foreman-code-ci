import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { probeComputerAccounts, systemPorts } from './accountProbe.js'
import { systemMaintenancePorts } from './maintenance.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function installation() {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const root = await mkdtemp(join(storage, 'executable-selection-'))
  roots.push(root)
  const directory = join(root, 'bin')
  await mkdir(directory)
  await writeFile(join(directory, 'codex'), '#!/bin/sh\nprintf "codex-cli 1.2.3\\n"\n', { mode: 0o700 })
  return { root, directory, environment: { HOME: root, PATH: directory } }
}

it.each(['accounts', 'maintenance'] as const)('rejects a missing explicit %s executable despite a working PATH alternative', async kind => {
  const fixture = await installation()
  const selected = join(fixture.root, 'selected-codex')
  const ports = kind === 'accounts'
    ? systemPorts(fixture.environment, { codex: selected })
    : systemMaintenancePorts(fixture.environment, { codex: selected })
  await expect(ports.find('codex')).rejects.toMatchObject({
    code: 'COMPUTER_EXECUTABLE_UNAVAILABLE', message: expect.stringContaining('ENOENT'),
  })
})

it('propagates an explicit selection failure through the account read', async () => {
  const fixture = await installation()
  const ports = systemPorts(fixture.environment, { codex: join(fixture.root, 'missing') })
  await expect(probeComputerAccounts({ ...ports,
    find: name => name === 'codex' ? ports.find(name) : Promise.resolve(null),
  })).rejects.toMatchObject({ code: 'COMPUTER_EXECUTABLE_UNAVAILABLE' })
})

it('reports an incomplete first launcher instead of selecting a different native installation', async () => {
  const fixture = await installation()
  const broken = join(fixture.root, 'broken')
  await mkdir(broken)
  await writeFile(join(broken, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const ports = systemMaintenancePorts({ ...fixture.environment, PATH: `${broken}:${fixture.directory}` })
  await expect(ports.find('codex')).rejects.toMatchObject({
    code: 'COMPUTER_EXECUTABLE_UNAVAILABLE', message: expect.stringContaining('version'),
  })
})

it.each(['accounts', 'maintenance'] as const)('discovers an unconfigured %s executable from PATH', async kind => {
  const fixture = await installation()
  const ports = kind === 'accounts' ? systemPorts(fixture.environment) : systemMaintenancePorts(fixture.environment)
  expect(await ports.find('codex')).toBe(join(fixture.directory, 'codex'))
})
