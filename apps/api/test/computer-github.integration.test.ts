import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { ComputerAccountsListSchema, GitHubLoginStateSchema } from '@foreman-code/contracts/computer-accounts'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { probeComputerAccounts, type AccountProbePorts } from '../src/modules/computers/accountProbe.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { ComputerGitHubService } from '../src/modules/computers/github.js'
import { GitHubLoginRunner } from '../src/modules/computers/githubLogin.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

it.skipIf(!postgresEnabled).each(['structured', 'text'])('verifies GitHub accounts through MCP with %s status', async format => {
  const database = await agent3Database()
  const credentialPath = join(database.directory, 'github-account.json')
  await writeFile(credentialPath, JSON.stringify('previous-owner'))
  const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  let setupFails = true
  let loseLogoutResponse = false
  let anotherAccount: string | null = null
  const removals: string[] = []
  const probe: AccountProbePorts = {
    environment: {}, find: async name => name === 'gh' ? '/fixture/gh' : null, readText: async () => null,
    run: async (_binary, args) => {
      if (args[1] === 'status') {
        if (format === 'text' && args.includes('--json')) {
          return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
        }
        const user = JSON.parse(await readFile(credentialPath, 'utf8')) as string | null
        if (format === 'text') {
          return user
            ? { code: 0, stdout: '', stderr: `Logged in to github.com account ${user} (keyring)\n - Active account: true` }
            : { code: 1, stdout: '', stderr: 'You are not logged into any accounts on github.com' }
        }
        return { code: 0, stderr: '', stdout: JSON.stringify({ hosts: { 'github.com': user
          ? [{ login: user, active: true, state: 'success' }] : [] } }) }
      }
      if (args[1] === 'logout') {
        removals.push(args.at(-1)!)
        await writeFile(credentialPath, JSON.stringify(anotherAccount))
        if (loseLogoutResponse) throw new Error('Logout response lost')
      }
      return { code: args[1] === 'setup-git' && setupFails ? 1 : 0, stdout: '', stderr: '' }
    },
  }
  let loginChild: EventEmitter | undefined
  const runner = new GitHubLoginRunner({ probe, now: Date.now, spawn: () => {
    const emitter = new EventEmitter()
    loginChild = emitter
    const stderr = new PassThrough()
    queueMicrotask(() => stderr.write('one-time code: AB12-CD34\n'))
    return { stdout: new PassThrough(), stderr, stdin: new PassThrough(), kill: () => { emitter.emit('exit', null); return true },
      once: (event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener) } as never
  } })
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const accounts = new ComputerAccountsService(database.pool, mainId, () => undefined, commands,
    () => probeComputerAccounts(probe))
  const github = new ComputerGitHubService(database.pool, mainId, () => undefined, commands, {
    local: runner, accountChanged: target => accounts.invalidate(target),
  })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { computerAccounts: accounts, computerGitHub: github, commands } as unknown as OperatorServices } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (actions: ('settings:read' | 'settings:update' | 'capabilities:read')[]) => {
      const issued = await access.issue({ name: 'GitHub account test', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions, scope: {} }] })
      const client = new Client({ name: 'github-account-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => issued.token },
      }))
      return client
    }
    const writer = await connect(['settings:read', 'settings:update', 'capabilities:read'])
    const reader = await connect(['settings:read', 'capabilities:read'])
    const account = async () => {
      const result = ComputerAccountsListSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'computer_accounts_list', arguments: {} }))))
      return result.computers[0]!.accounts!.accounts.find(value => value.tool === 'github')
    }
    expect((await account())?.account).toBe('previous-owner')
    const started = GitHubLoginStateSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'computer_github_login_start', arguments: { target } }))))
    await writeFile(credentialPath, JSON.stringify('signed-in-owner'))
    loginChild!.emit('exit', 0)
    const input = { target, loginId: started.loginId }
    await vi.waitFor(async () => expect(GitHubLoginStateSchema.parse(decodeMcpToolResult((await writer.callTool({
      name: 'computer_github_login_status', arguments: input,
    }))))).toMatchObject({ state: 'git-setup-failed', account: 'signed-in-owner' }))
    expect((await account())?.account).toBe('signed-in-owner')
    expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_github_setup_git')
    expect((await reader.callTool({ name: 'computer_github_setup_git', arguments: input })).isError).toBe(true)
    setupFails = false
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'computer_github_setup_git', arguments: input }))))
      .state).toBe('signed-in')
    expect((await reader.callTool({ name: 'computer_github_logout', arguments: { target, expectedAccount: 'signed-in-owner' } })).isError).toBe(true)
    expect((await account())?.signedIn).toBe(true)
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'computer_github_logout', arguments: { target, expectedAccount: 'signed-in-owner' } }))))
      .state).toBe('signed-out')
    expect((await account())?.signedIn).toBe(false)

    await writeFile(credentialPath, JSON.stringify('original-owner'))
    anotherAccount = 'next-owner'
    loseLogoutResponse = true
    const retry = { target, expectedAccount: 'original-owner' }
    expect((await writer.callTool({ name: 'computer_github_logout', arguments: retry })).isError).toBe(true)
    loseLogoutResponse = false
    const deniedLogout = await reader.callTool({ name: 'computer_github_logout',
      arguments: { target, expectedAccount: 'next-owner' } })
    expect(deniedLogout.isError).toBe(true)
    const duplicates = await Promise.all([1, 2].map(() => writer.callTool({
      name: 'computer_github_logout', arguments: retry,
    })))
    expect(duplicates.every(result => result.isError)).toBe(true)
    expect(removals).toEqual(['signed-in-owner', 'original-owner'])
    expect((await account())?.account).toBe('next-owner')
    expect(JSON.parse(await readFile(credentialPath, 'utf8'))).toBe('next-owner')
    const audits = await database.pool.query<{ outcome: string }>(
      "select outcome from management_audit where action='computer_github_logout'")
    expect(audits.rows.map(row => row.outcome)).toContain('uncertain')
    expect((await probeComputerAccounts(probe)).accounts.find(value => value.tool === 'github')?.account).toBe('next-owner')
  } finally {
    runner.close()
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await database.close()
  }
}, 60_000)
