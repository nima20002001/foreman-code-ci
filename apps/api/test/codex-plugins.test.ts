import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CodexPluginSummary } from '@foreman-code/contracts/management'
import { NativeCodexPlugins } from '../src/modules/harnesses/codexPlugins.js'

const originalHome = process.env.CODEX_HOME
let home: string | undefined
afterEach(async () => {
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome
  if (home) await rm(home, { recursive: true, force: true })
  home = undefined
})

it('reads verified local bundle contents and leaves unavailable contents unknown', async () => {
  home = await mkdtemp(join(tmpdir(), 'graphql-plugin-fixture-'))
  process.env.CODEX_HOME = home
  const root = join(home, 'plugins', 'cache', 'trusted', 'example', '1.0.0')
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, 'skills', 'write-notes'), { recursive: true })
  await mkdir(join(root, 'hooks'), { recursive: true })
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'example', mcpServers: './.mcp.json', hooks: './hooks/hooks.json' }))
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { notes: { type: 'http', url: 'https://example.test/mcp?token=secret' } } }))
  await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { preToolUse: [{ command: 'private-command' }] } }))
  await writeFile(join(root, 'skills', 'write-notes', 'SKILL.md'), '# Notes')
  const plugin: CodexPluginSummary = { pluginId: 'example@trusted', name: 'example', marketplaceName: 'trusted', version: '1.0.0',
    installed: true, enabled: true, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }
  const adapter = new NativeCodexPlugins('/unused', '/tmp')
  const detail = await adapter.detail(plugin)
  expect(detail).toEqual({ status: 'known', skills: ['write-notes'], hooks: ['preToolUse'], mcpServers: ['notes'], apps: [] })
  expect(JSON.stringify(detail)).not.toContain('secret')
  expect(JSON.stringify(detail)).not.toContain('private-command')
  expect(await adapter.detail({ ...plugin, installed: false })).toEqual({ status: 'unknown' })
  expect(await adapter.detail({ ...plugin, version: '2.0.0' })).toEqual({ status: 'unknown' })
})
