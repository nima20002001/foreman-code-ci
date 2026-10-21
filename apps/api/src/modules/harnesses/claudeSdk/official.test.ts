import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadOfficialClaudeSdk } from './official.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function installedModule(version = '0.3.284') {
  const root = await mkdtemp(join(tmpdir(), 'selected-sdk-'))
  directories.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version }))
  const entrypoint = join(root, 'sdk.mjs')
  await writeFile(entrypoint, `
export function query() { throw new Error('This recorded SDK cannot execute a native query') }
export async function getSessionInfo(id) { return { sessionId: id } }
export async function getSessionMessages() { return [{ selectedSdk: 'explicit-installation' }] }
export async function forkSession(id) { return { sessionId: id + '-fork' } }
export async function listSubagents() { return [] }
export async function getSubagentMessages() { return [] }
`)
  return { root, entrypoint }
}

it('loads native history helpers from the explicitly selected SDK without starting a query or CLI', async () => {
  const f = await installedModule()
  const profile = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const client = await loadOfficialClaudeSdk(profile, { root: f.root, owner: 'recorded-owner' },
    '/not-executed/claude', f.entrypoint)
  expect(client.sdkVersion).toBe('0.3.284')
  expect(await client.getSessionInfo('recorded-session', { dir: '/recorded-project' })).toEqual({ sessionId: 'recorded-session' })
  expect(await client.getSessionMessages('recorded-session', { dir: '/recorded-project' }))
    .toEqual([{ selectedSdk: 'explicit-installation' }])
})

it('accepts another SDK release by its method contract and refuses a missing method or relative entrypoint', async () => {
  const profile = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const f = await installedModule('0.3.999')
  const recovery = { root: f.root, owner: 'recorded-owner' }
  expect((await loadOfficialClaudeSdk(profile, recovery, '/not-executed/claude', f.entrypoint)).sdkVersion).toBe('0.3.999')
  const missing = await installedModule('0.3.998')
  await writeFile(missing.entrypoint, 'export function query() {}\n')
  await expect(loadOfficialClaudeSdk(profile, { root: missing.root, owner: 'recorded-owner' }, '/not-executed/claude',
    missing.entrypoint)).rejects.toMatchObject({ result: { error: { code: 'CLAUDE_CONTRACT_UNSUPPORTED' } } })
  await expect(loadOfficialClaudeSdk(profile, recovery, '/not-executed/claude', './sdk.mjs'))
    .rejects.toThrow('qualified absolute entrypoint')
})

it('reads and forks concurrent account homes without changing the API process environment', async () => {
  const f = await installedModule()
  await writeFile(f.entrypoint, `
export function query() { throw new Error('No native query') }
export async function getSessionInfo(id) { return { sessionId: id, profile: process.env.CLAUDE_CONFIG_DIR } }
export async function getSessionMessages() { return [{ profile: process.env.CLAUDE_CONFIG_DIR }] }
export async function forkSession() { return { sessionId: process.env.CLAUDE_CONFIG_DIR + '/fork' } }
export async function listSubagents() { return [process.env.CLAUDE_CONFIG_DIR] }
export async function getSubagentMessages() { return [{ profile: process.env.CLAUDE_CONFIG_DIR }] }
`)
  const before = process.env.CLAUDE_CONFIG_DIR
  const clients = await Promise.all(['/accounts/one/home', '/accounts/two/home'].map(profile =>
    loadOfficialClaudeSdk(profile, { root: f.root, owner: profile }, '/not-executed/claude', f.entrypoint)))
  const results = await Promise.all(clients.map(client => client.getSessionMessages('session', { dir: '/project' })))
  expect(results).toEqual([[{ profile: '/accounts/one/home' }], [{ profile: '/accounts/two/home' }]])
  expect(await clients[0]!.forkSession('session', { dir: '/project' })).toEqual({ sessionId: '/accounts/one/home/fork' })
  expect(await clients[1]!.listSubagents!('session', { dir: '/project' })).toEqual(['/accounts/two/home'])
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before)
})
