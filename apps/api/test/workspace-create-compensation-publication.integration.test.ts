import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as contracts from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

describe('workspace project folder compensation through authenticated MCP', () => {
  it.each([true, false])('settles a surviving rename during %s-name recovery before releasing ownership', async explicit => {
    const f = await workspaceMcpFixture()
    const children: ChildProcess[] = []
    const gate = join(f.parentPath, 'publication-gate')
    let publisherPid: number | undefined
    const errors: unknown[] = []
    try {
      await mkdir(gate)
      await writeFile(join(gate, 'python3'), `#!/usr/bin/env node
const { writeFile, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setImmediate } = require('node:timers/promises')
async function publish() {
  const gate = process.env.WORKSPACE_PUBLICATION_GATE
  await writeFile(join(gate, 'started'), String(process.pid))
  while (true) {
    try { await stat(join(gate, 'release')); break }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      await setImmediate()
    }
  }
  await promisify(execFile)('/usr/bin/python3', process.argv.slice(2))
  await writeFile(join(gate, 'published'), '')
}
publish().catch(error => { console.error(error); process.exitCode = 1 })
`, { mode: 0o700 })
      const name = 'Recovered during publication'
      await f.defaults.updateWorkspaceDefaults({ suggestedName: name, description: '', parentPath: f.parentPath }, 0)
      const input = { commandId: randomUUID(), parentPath: f.parentPath, ...(explicit ? { name } : {}) }
      const launch = (recover: boolean) => {
        const child = fork(fileURLToPath(new URL('./helpers/workspaceCreateProcess.ts', import.meta.url)), [], {
          cwd: fileURLToPath(new URL('..', import.meta.url)), execArgv: ['--import', 'tsx'], silent: true,
          env: recover ? process.env : { ...process.env, PATH: `${gate}:${process.env.PATH}`,
            WORKSPACE_PUBLICATION_GATE: gate },
        })
        children.push(child)
        child.send({ database: f.pool.options, parentPath: f.parentPath, token: f.owner.token, input,
          interrupt: false, ...(recover ? { reconcilePublication: gate } : {}) })
        return child
      }
      const interrupted = launch(false)
      publisherPid = await readUntil(async () => {
        try { return Number(await readFile(join(gate, 'started'), 'utf8')) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return undefined
        }
      }, value => value !== undefined, { timeoutMs: 10_000, description: 'the publication process readiness' })
      expect((await f.pool.query('select identity from workspace_project_provisioning')).rows)
        .toEqual([{ identity: { device: expect.any(String), inode: expect.any(String) } }])
      const exited = once(interrupted, 'exit')
      interrupted.kill('SIGKILL')
      await exited
      const restarted = launch(true)
      const completion = once(restarted, 'exit')
      const [message] = await once(restarted, 'message')
      expect(message.phase, JSON.stringify(message)).toBe('completed')
      expect(message.result.isError, JSON.stringify(message.result)).not.toBe(true)
      const saved = contracts.ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(message.result))
      expect(saved.value.workspace.name).toBe(name)
      expect(await completion).toEqual([0, null])
      expect((await f.pool.query('select id from workspace_project_provisioning')).rows).toEqual([])
      expect((await readdir(f.parentPath)).sort()).toEqual(['publication-gate', name].sort())
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
        { workspaceId: saved.value.workspace.id })
      expect(readback.executionLocation?.rootPath).toBe(join(f.parentPath, name))
      expect(readback.locationValidation.status).toBe('ready')
      expect((await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, input)).replayed).toBe(true)
    } catch (error) {
      errors.push(error)
    }
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
      } catch (error) {
        errors.push(error)
      }
    }
    if (publisherPid) {
      try { process.kill(publisherPid, 'SIGKILL') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error)
      }
    }
    try { await f.close() }
    catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Workspace publication test and cleanup failed.')
  }, 30_000)
})
