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
  it('recovers an unpublished stage without deleting a pre-existing project folder', async () => {
    const f = await workspaceMcpFixture()
    let child: ChildProcess | undefined
    try {
      const name = 'Existing project'
      await f.defaults.updateWorkspaceDefaults({ suggestedName: name, description: '', parentPath: f.parentPath }, 0)
      const existing = join(f.parentPath, name)
      await mkdir(existing)
      await writeFile(join(existing, 'user.txt'), 'Keep this project')
      const input = { commandId: randomUUID(), parentPath: f.parentPath }
      child = fork(fileURLToPath(new URL('./helpers/workspaceCreateProcess.ts', import.meta.url)), [], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), execArgv: ['--import', 'tsx'], silent: true,
      })
      child.send({ database: f.pool.options, parentPath: f.parentPath, token: f.owner.token,
        input, interrupt: 'staged' })
      const [paused] = await once(child, 'message')
      expect(paused, JSON.stringify(paused)).toEqual({ phase: 'staged' })
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const saved = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, input)
      expect(saved.value.workspace.name).toBe(`${name} (1)`)
      expect(await readFile(join(existing, 'user.txt'), 'utf8')).toBe('Keep this project')
      expect((await readdir(f.parentPath)).sort()).toEqual([name, `${name} (1)`])
      expect((await f.pool.query('select id from workspace_project_provisioning')).rows).toEqual([])
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await f.close()
    }
  }, 30_000)

  it.each([true, false])('recovers an interrupted %s-name creation in a fresh process without suffixes', async explicit => {
    const f = await workspaceMcpFixture()
    const children: ChildProcess[] = []
    const launch = (input: contracts.WorkspaceCreateInput, interrupt: boolean) => {
      const child = fork(fileURLToPath(new URL('./helpers/workspaceCreateProcess.ts', import.meta.url)), [], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), execArgv: ['--import', 'tsx'], silent: true,
      })
      children.push(child)
      child.send({ database: f.pool.options, parentPath: f.parentPath, token: f.owner.token, input, interrupt })
      return child
    }
    try {
      const name = 'Recovered after crash'
      await f.defaults.updateWorkspaceDefaults({ suggestedName: name, description: '', parentPath: f.parentPath }, 0)
      const input = { commandId: randomUUID(), parentPath: f.parentPath, ...(explicit ? { name } : {}) }
      const interrupted = launch(input, true)
      const [paused] = await once(interrupted, 'message')
      expect(paused, JSON.stringify(paused)).toEqual({ phase: 'provisioned' })
      expect(await readdir(f.parentPath)).toEqual([name])
      expect((await f.pool.query('select id from workspaces')).rows).toEqual([])
      expect((await f.pool.query('select identity from workspace_project_provisioning')).rows)
        .toEqual([{ identity: { device: expect.any(String), inode: expect.any(String) } }])
      const exited = once(interrupted, 'exit')
      interrupted.kill('SIGKILL')
      expect(await exited).toEqual([null, 'SIGKILL'])
      const restarted = launch(input, false)
      const completion = once(restarted, 'exit')
      const [message] = await once(restarted, 'message')
      expect(message.phase, JSON.stringify(message)).toBe('completed')
      expect(message.result.isError, JSON.stringify(message.result)).not.toBe(true)
      const saved = contracts.ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(message.result))
      expect(saved.replayed).toBe(false)
      expect(saved.value.workspace.name).toBe(name)
      expect(await completion).toEqual([0, null])
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema,
        { workspaceId: saved.value.workspace.id })
      expect(readback.executionLocation?.rootPath).toBe(join(f.parentPath, name))
      expect(readback.locationValidation.status).toBe('ready')
      expect(await readdir(f.parentPath)).toEqual([name])
      expect((await f.pool.query('select id from workspaces')).rows).toEqual([{ id: saved.value.workspace.id }])
      expect((await f.pool.query('select id from workspace_project_provisioning')).rows).toEqual([])
      expect((await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, input)).replayed).toBe(true)
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
      }
      await f.close()
    }
  }, 30_000)
})
