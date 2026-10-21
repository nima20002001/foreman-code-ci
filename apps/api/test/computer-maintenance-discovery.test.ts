import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { systemMaintenancePorts } from '../src/modules/computers/maintenance.js'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function installation() {
  const home = await mkdtemp(join(tmpdir(), 'maintenance-discovery-'))
  homes.push(home)
  const local = join(home, '.local/bin')
  const system = join(home, 'system/bin')
  const nodeBin = join(home, 'node/bin')
  await mkdir(local, { recursive: true })
  await mkdir(system, { recursive: true })
  await mkdir(nodeBin, { recursive: true })
  // Keep the interpreter available without exposing its sibling global CLI launchers.
  await symlink(process.execPath, join(nodeBin, 'node'))
  const payload = join(home, '.local/lib/node_modules/@openai/codex/bin/codex.js')
  await mkdir(dirname(payload), { recursive: true })
  await writeFile(payload, '#!/usr/bin/env node\nthrow new Error("Missing optional dependency @openai/codex-linux-x64");',
    { mode: 0o755 })
  const broken = join(local, 'codex')
  await symlink(payload, broken)
  const working = join(system, 'codex')
  await writeFile(working, '#!/bin/sh\nprintf "codex-cli 0.157.0\\n"\n', { mode: 0o755 })
  const environment = {
    HOME: home,
    PATH: [nodeBin, system].join(delimiter),
    npm_config_prefix: join(home, '.local'),
  }
  return { home, broken, working, environment }
}

describe('maintenance harness discovery', () => {
  it('reports an incomplete first launcher instead of substituting another installation', async () => {
    const fixture = await installation()
    const ports = systemMaintenancePorts(fixture.environment)
    await expect(ports.find('codex')).rejects.toMatchObject({
      code: 'COMPUTER_EXECUTABLE_UNAVAILABLE',
      message: expect.stringContaining('~/.local/bin/codex'),
    })
  })

  it('preserves an explicit selection even when its launcher fails and another installation works', async () => {
    const fixture = await installation()
    const ports = systemMaintenancePorts(fixture.environment, { codex: fixture.broken })
    await expect(ports.find('codex')).rejects.toMatchObject({
      code: 'COMPUTER_EXECUTABLE_UNAVAILABLE',
      message: expect.stringContaining('~/.local/bin/codex'),
    })
    const result = await ports.run(fixture.broken, ['--version'],
      { signal: AbortSignal.timeout(5000), timeoutMs: 5000 })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Missing optional dependency')
  })
})
