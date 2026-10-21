import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { stopGroup } from '../../../scripts/integration-process.mjs'
import { freePort, root } from './helpers/testStartupIsolation.js'

it('starts the local smoke API and web app and completes authenticated HTTP/MCP parity', async () => {
  const ports = [await freePort(), await freePort()]
  while (ports[0] === ports[1]) ports[1] = await freePort()
  const child = spawn(process.execPath, [join(root, 'scripts/acceptance/local.mjs'), '--smoke',
    '--api-port', String(ports[0]), '--web-port', String(ports[1])], {
    cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  try {
    const [code] = await once(child, 'exit')
    expect(code, output).toBe(0)
    expect(output).toContain('ENG07 ready:')
    expect(output).toContain('ENG07 parity passed:')
    expect(output).toContain('owned test database and task files removed')
  } finally { await stopGroup(child.pid, { signal: 'SIGTERM' }) }
}, 240_000)
