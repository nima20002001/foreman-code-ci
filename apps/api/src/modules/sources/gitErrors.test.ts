import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../../app.js'
import { toolFailure } from '../../mcp/shared/results.js'
import { snapshotAgentWorktree } from './agentSnapshot.js'
import { addGitWorktree, ensureCommit, type GitWorktreePorts } from './gitWorktree.js'
import { SourceError } from './manifest.js'
import { DomainError } from '../errors.js'

const commit = 'a'.repeat(40)
const githubUnavailable = {
  code: 'SOURCE_GITHUB_UNAVAILABLE', status: 503,
  message: 'GitHub git fetch failed. Check repository access and local Git configuration, then retry.',
  details: { retryable: true, newCommandRequired: false },
}
const githubAuthentication = {
  code: 'COMPUTER_GITHUB_REQUIRED', status: 409,
  message: 'Sign in to GitHub on this computer (computer_github_login_start), then retry.',
}
const credentials = [
  ['URL password', 'fatal: https://user:synthetic-password@example.invalid/repo', githubUnavailable],
  ['URL token username', 'fatal: https://synthetic-token@example.invalid/repo', githubUnavailable],
  ['authorization header', 'fatal: Authorization: Bearer synthetic-bearer-token', githubUnavailable],
  ['basic authorization', 'fatal: Authorization: Basic c3ludGhldGljOmNyZWRlbnRpYWw=', githubUnavailable],
  ['GitHub token', 'fatal: ghp_syntheticGitHubCredential1234567890', githubUnavailable],
  ['GitHub fine-grained token', 'fatal: github_pat_syntheticCredential1234567890', githubUnavailable],
  ['credential helper output', 'fatal: password=synthetic-helper-password', githubUnavailable],
  ['encoded credentials', 'fatal: https://user:synthetic%2Dpassword@example.invalid/repo', githubUnavailable],
  ['escaped credentials', 'fatal: {"password":"synthetic\\u002dpassword"}', githubUnavailable],
  ['private key', '-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----', githubUnavailable],
  ['unlabelled helper output', 'fatal: synthetic-unlabelled-secret', githubUnavailable],
  ['credential past truncation boundary', `fatal: ${'x'.repeat(290)} synthetic-secret`, githubUnavailable],
  ['multiline helper output', 'synthetic-helper-secret\nfatal: authentication failed', githubAuthentication],
] as const

const roots: string[] = []
async function failingPorts(stderr: string, operation: string): Promise<GitWorktreePorts> {
  const clone = await mkdtemp(join(tmpdir(), 'git-errors-'))
  roots.push(clone)
  return {
    cloneDirectory: () => clone,
    git: async args => ({
      code: args[0] === operation || args[0] === 'cat-file' ? 1 : 0,
      stdout: '',
      stderr,
    }),
  }
}

const operations = [
  {
    name: 'repository fetch',
    command: 'fetch',
    code: 'SOURCE_WORKTREE_FAILED',
    run: (ports: GitWorktreePorts) => ensureCommit(ports, 'octo/site', commit, new AbortController().signal),
  },
  {
    name: 'worktree preparation',
    command: 'worktree',
    code: 'SOURCE_WORKTREE_FAILED',
    run: (ports: GitWorktreePorts) => addGitWorktree(ports,
      { repository: 'octo/site', branch: 'foreman/agent' }, commit, '/unused-worktree', new AbortController().signal),
  },
  {
    name: 'agent snapshot',
    command: 'read-tree',
    code: 'SOURCE_SNAPSHOT_FAILED',
    run: (ports: GitWorktreePorts) => snapshotAgentWorktree(ports,
      { path: '/unused-worktree', baseCommit: commit }, new AbortController().signal),
  },
]

for (const operation of operations) {
  it.each(credentials)(`${operation.name} excludes %s from its public error`, async (_name, stderr, acquisitionFailure) => {
    let failure: unknown
    try {
      await operation.run(await failingPorts(stderr, operation.command))
    } catch (error) {
      failure = error
    }
    const expected = operation.command === 'fetch' ? acquisitionFailure : {
      code: operation.code,
      message: `git ${operation.command} failed. Check repository access and local Git configuration, then retry.`,
    }
    expect(failure).toBeInstanceOf(expected.code === 'SOURCE_GITHUB_UNAVAILABLE' ? DomainError : SourceError)
    expect(failure).toMatchObject(expected)
    const result = toolFailure(failure)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ error: {
      code: expected.code, message: expected.message,
      ...('details' in expected ? { details: expected.details } : {}),
    } }) }])
  })
}

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(credentials)('excludes %s through the HTTP error handler', async (_name, stderr, acquisitionFailure) => {
  const app = buildApp({ readiness: {
    database: { ping: async () => {} }, checkpoints: { ping: async () => {} },
  } })
  apps.push(app)
  const ports = await failingPorts(stderr, 'fetch')
  app.get('/git-failure', () => ensureCommit(ports,
    'octo/site', commit, new AbortController().signal))
  const response = await app.inject({ method: 'GET', url: '/git-failure' })
  expect(response.statusCode).toBe(acquisitionFailure.status)
  expect(response.json().error).toEqual({
    code: acquisitionFailure.code, message: acquisitionFailure.message,
    ...('details' in acquisitionFailure ? { details: acquisitionFailure.details } : {}),
    requestId: expect.any(String),
  })
  expect(response.body.length).toBeLessThan(300)
})
