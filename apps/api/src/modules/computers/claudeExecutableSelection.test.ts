import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each([false, true])('selects the updated Claude launcher and preserves the SDK selection (invalid SDK: %s)', async invalid => {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const home = await mkdtemp(join(storage, 'claude-selection-'))
  try {
    const { selectInstalledClaude } = await import('./installedClaudeSelection.js')
    const bin = join(home, '.local/bin')
    const sdk = join(home, 'sdk')
    await mkdir(bin, { recursive: true })
    await mkdir(sdk)
    const old = join(home, 'claude-old')
    const updated = join(home, 'claude-updated')
    await writeFile(old, '#!/bin/sh\nprintf "1.2.3 (Claude Code)\\n"\n', { mode: 0o700 })
    await writeFile(updated, '#!/bin/sh\nprintf "1.2.4 (Claude Code)\\n"\n', { mode: 0o700 })
    await symlink(old, join(bin, 'claude'))
    const entrypoint = join(sdk, 'sdk.mjs')
    const lock = join(home, 'lock.yaml')
    await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.284' }))
    await writeFile(entrypoint, 'export {};')
    await writeFile(lock, invalid ? 'packages: {}' :
      "packages:\n  '@anthropic-ai/claude-agent-sdk@0.3.284':\n    resolution: {integrity: sha512-aGVsbG8=}\n")
    const path = join(home, 'selection.json')
    const before = { schemaVersion: 1, appMcpLauncher: join(home, 'mcp.mjs'),
      claude: { binary: old, installedLockPath: lock, sdkEntrypoint: entrypoint } }
    await writeFile(path, JSON.stringify(before), { mode: 0o600 })
    await unlink(join(bin, 'claude'))
    await symlink(updated, join(bin, 'claude'))
    const select = selectInstalledClaude({ path, ownerUid: process.getuid!() },
      { HOME: home, PATH: bin }, AbortSignal.timeout(2000))
    if (invalid) {
      await expect(select).rejects.toThrow('integrity')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(before)
    } else {
      expect(await select).toBe(updated)
      await rm(old)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...before, claude: { ...before.claude, binary: updated } })
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})
