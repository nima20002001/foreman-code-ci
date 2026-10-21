import { EventEmitter } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { fileRuntimeFixture } from './fixtures/codex-file-runtime-helpers.js'

it('file fixture retains shared MCP configuration and exact CLI disable flags without native execution', async () => {
  const fixture = await fileRuntimeFixture()
  try {
    const source = await readFile(fixture.binary, 'utf8')
    for (const disabled of [false, true]) {
      const replies: unknown[] = []
      let receive!: (line: string) => void
      const fs = { existsSync: () => false, readFileSync: () => { throw new Error('no fixture override') },
        appendFileSync: () => undefined }
      const process = { argv: ['node', fixture.binary, 'app-server',
        ...(disabled ? ['-c', 'mcp_servers.graphql.enabled=false'] : [])], env: {}, pid: 501,
        stdin: new EventEmitter(), cwd: () => fixture.directory, on: () => undefined,
        exit: () => { throw new Error('Unexpected fixture exit') },
        stdout: { write: (value: string) => replies.push(JSON.parse(value)) } }
      const require = (name: string): unknown => {
        if (name === 'node:fs') return fs
        if (name === 'node:path') return path
        if (name === 'node:readline') return { createInterface: () => ({
          on: (event: string, callback: (line: string) => void) => { if (event === 'line') receive = callback },
        }) }
        throw new Error(`Unexpected native fixture module ${name}`)
      }
      runInNewContext(source, { require, __dirname: fixture.directory, process,
        setInterval: () => undefined, setTimeout: () => undefined })
      receive(JSON.stringify({ id: 1, method: 'config/read', params: {} }))
      expect(replies).toEqual([{ id: 1, result: { config: {
        approval_policy: 'on-request', mcp_servers: { graphql: { name: 'graphql', enabled: !disabled } },
      }, origins: {}, layers: [] } }])
    }
  } finally { await rm(fixture.directory, { recursive: true, force: true }) }
})
