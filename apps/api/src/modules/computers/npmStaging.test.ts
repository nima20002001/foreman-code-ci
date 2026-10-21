import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCodexStagingRenameError, removeCodexStagingDirectories } from './npmStaging.js'

const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'npm-staging-'))
  homes.push(home)
  const scope = join(home, '@openai')
  await mkdir(scope)
  return { home, scope }
}

describe('Codex npm staging recovery', () => {
  it('recognizes only ENOTEMPTY renames from Codex to its sibling staging directory', () => {
    const scope = '/home/owner/.local/lib/node_modules/@openai'
    const output = `npm error ENOTEMPTY: directory not empty, rename '${scope}/codex' -> '${scope}/.codex-Ab12'`
    expect(isCodexStagingRenameError(output, scope)).toBe(true)
    expect(isCodexStagingRenameError(output.replace('ENOTEMPTY', 'EACCES'), scope)).toBe(false)
    expect(isCodexStagingRenameError(output.replace('/codex\'', '/another\''), scope)).toBe(false)
    expect(isCodexStagingRenameError(output.replace('.codex-Ab12', '.other-Ab12'), scope)).toBe(false)
    expect(isCodexStagingRenameError(output, '/another/@openai')).toBe(false)
  })

  it('removes staging directories while preserving packages, files, and symlink targets', async () => {
    const { home, scope } = await fixture()
    for (const name of ['.codex-Ab12', '.codex-Cd34', 'codex', 'other', '.other-Ab12', '.codex-']) {
      await mkdir(join(scope, name))
      await writeFile(join(scope, name, 'keep'), name)
    }
    await writeFile(join(scope, '.codex-file'), 'keep')
    await symlink(join(scope, 'other'), join(scope, '.codex-link'))
    await symlink(join(scope, 'other'), join(scope, '.codex-Ab12', 'nested-link'))
    await removeCodexStagingDirectories(scope)
    expect((await readdir(scope)).sort()).toEqual([
      '.codex-', '.codex-file', '.codex-link', '.other-Ab12', 'codex', 'other',
    ])
    expect(await readFile(join(scope, 'codex', 'keep'), 'utf8')).toBe('codex')
    expect(await readFile(join(scope, 'other', 'keep'), 'utf8')).toBe('other')
    await symlink(scope, join(home, 'scope-link'))
    await expect(removeCodexStagingDirectories(join(home, 'scope-link'))).rejects.toThrow('owned by')
  })

  it('refuses cleanup when the directory belongs to a different user', async () => {
    const { scope } = await fixture()
    await mkdir(join(scope, '.codex-Ab12'))
    const uid = process.getuid!()
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    await expect(removeCodexStagingDirectories(scope)).rejects.toThrow('owned by')
    expect(await readdir(scope)).toEqual(['.codex-Ab12'])
  })
})
