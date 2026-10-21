import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectCodexPluginBundle } from '../src/modules/harnesses/codexPluginInspection.js'
import { PLUGIN_DIRECTORY_LIMIT, PLUGIN_FILE_LIMIT } from '../src/modules/harnesses/boundedPluginFiles.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function bundle(manifest: Record<string, unknown> = { name: 'example' }, portable = false) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-review-')); roots.push(root)
  const put = async (path: string, value: unknown) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  await put(portable ? 'plugin.json' : '.codex-plugin/plugin.json', portable
    ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', ...manifest } : manifest)
  return { root, put, inspect: () => inspectCodexPluginBundle(root) }
}
it('uses the portable compatibility overlay but never a stray legacy MCP file', async () => {
  const b = await bundle({ name: 'example' }, true)
  await b.put('.codex-plugin/plugin.json', { hooks: { hooks: { SessionStart: [] } }, apps: './apps.json' })
  await b.put('apps.json', { apps: { calendar: {} } })
  await b.put('.mcp.json', { mcpServers: { stray: {} } })
  expect(await b.inspect()).toEqual({ status: 'known', skills: [], hooks: ['SessionStart'], apps: ['calendar'], mcpServers: [] })
})
it('replaces the overlay with an explicit inline OpenAI extension', async () => {
  const b = await bundle({ name: 'example', extensions: { 'com.openai': { hooks: [] } } }, true)
  await b.put('.codex-plugin/plugin.json', { hooks: { hooks: { WrongEvent: [] } }, apps: './wrong-apps.json' })
  await b.put('mcp.json', { mcpServers: { portable: {} } })
  expect(await b.inspect()).toMatchObject({ status: 'known', hooks: [], apps: [], mcpServers: ['portable'] })
})
it('falls back to legacy instead of treating unrelated root JSON as portable', async () => {
  const b = await bundle()
  await b.put('plugin.json', { name: 'example', arbitrary: true })
  await b.put('.mcp.json', { mcpServers: { legacy: {} } })
  expect(await b.inspect()).toMatchObject({ status: 'known', mcpServers: ['legacy'] })
})
it.each([
  ['./custom.json', ['FromFile']],
  [['./custom.json', './other.json'], ['FromFile', 'Other']],
  [{ hooks: { Inline: [] } }, ['Inline']],
  [[{ hooks: { One: [] } }, { hooks: { Two: [] } }], ['One', 'Two']],
  [[], []],
])('resolves explicit hooks %j and ignores the default file', async (declaration, expected) => {
  const b = await bundle({ name: 'example', hooks: declaration })
  await b.put('custom.json', { hooks: { FromFile: [] } })
  await b.put('other.json', { hooks: { Other: [] } })
  await b.put('hooks/hooks.json', { hooks: { DefaultMustNotAppear: [] } })
  expect(await b.inspect()).toMatchObject({ status: 'known', hooks: expected })
})
it('uses default hooks only when the declaration is absent', async () => {
  const b = await bundle()
  await b.put('hooks/hooks.json', { hooks: { SessionStart: [] } })
  expect(await b.inspect()).toMatchObject({ status: 'known', hooks: ['SessionStart'] })
})
it.each(['oversized', 'malformed', 'directory'])('does not call an %s MCP component an empty bundle', async (mode) => {
  const b = await bundle()
  if (mode === 'directory') await mkdir(join(b.root, '.mcp.json'))
  else await b.put('.mcp.json', mode === 'malformed' ? '{invalid' : ' '.repeat(PLUGIN_FILE_LIMIT + 1))
  expect(await b.inspect()).toEqual({ status: 'unknown' })
})
it('refuses symlinked skill traversal and excessive directory entries', async () => {
  const b = await bundle()
  const outside = await bundle()
  await mkdir(join(outside.root, 'external'))
  await symlink(join(outside.root, 'external'), join(b.root, 'skills'))
  expect(await b.inspect()).toEqual({ status: 'unknown' })
  await rm(join(b.root, 'skills'))
  await mkdir(join(b.root, 'skills'))
  for (let n = 0; n <= PLUGIN_DIRECTORY_LIMIT; n++) await mkdir(join(b.root, 'skills', `skill-${n}`))
  expect(await b.inspect()).toEqual({ status: 'unknown' })
})
it.skipIf(process.platform !== 'linux')('rejects a FIFO without waiting for a writer', async () => {
  const b = await bundle()
  execFileSync('mkfifo', [join(b.root, '.mcp.json')])
  expect(await b.inspect()).toEqual({ status: 'unknown' })
}, 3_000)
it('cancels before inspecting an abandoned request', async () => {
  const b = await bundle()
  const stop = new AbortController(); stop.abort(new Error('abandoned'))
  await expect(inspectCodexPluginBundle(b.root, stop.signal)).rejects.toThrow('abandoned')
})

it('bounds recursive legacy skills and also supports a declared skill root', async () => {
  const b = await bundle({ name: 'example', skills: './custom' })
  await b.put('custom/SKILL.md', '# Root skill')
  await b.put('custom/group/nested/SKILL.md', '# Nested skill')
  expect(await b.inspect()).toMatchObject({ status: 'known', skills: ['custom', 'nested'] })
})
it('does not mistake dangling component symlinks for absent files', async () => {
  const b = await bundle()
  await symlink(join(b.root, 'missing-file'), join(b.root, '.mcp.json'))
  expect(await b.inspect()).toEqual({ status: 'unknown' })
})
