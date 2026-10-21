import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { backupNativeUserFile } from './nativeConfigFiles.js'

const fault = vi.hoisted(() => ({ directorySyncFails: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args)
      if (fault.directorySyncFails && (await handle.stat()).isDirectory()) {
        handle.sync = async () => { throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' }) }
      }
      return handle
    },
  }
})

const directories: string[] = []
afterEach(async () => {
  fault.directorySyncFails = false
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-config-backup-'))
  directories.push(directory)
  const file = join(directory, 'config.toml')
  const source = '# private configuration\nmodel = "saved-model"\n'
  await writeFile(file, source, { mode: 0o600 })
  return { directory, file, source }
}

it('preserves private backup bytes and previous backups when the configuration changes', async () => {
  const f = await fixture()
  await backupNativeUserFile(f.file, f.source)
  const edited = 'model = "external-model"\n'
  await writeFile(f.file, edited)
  await backupNativeUserFile(f.file, edited)
  const backups = (await readdir(f.directory)).filter(name => name.endsWith('.bak'))
  expect(backups).toHaveLength(2)
  const contents = await Promise.all(backups.map(name => readFile(join(f.directory, name), 'utf8')))
  expect(contents.sort()).toEqual([f.source, edited].sort())
  for (const name of backups) expect((await stat(join(f.directory, name))).mode & 0o777).toBe(0o600)
  expect(await readFile(f.file, 'utf8')).toBe(edited)
})

it('refuses to acknowledge a backup when its directory cannot be synced', async () => {
  const f = await fixture()
  fault.directorySyncFails = true
  await expect(backupNativeUserFile(f.file, f.source)).rejects.toMatchObject({ code: 'EIO' })
  expect(await readFile(f.file, 'utf8')).toBe(f.source)
  const backups = (await readdir(f.directory)).filter(name => name.endsWith('.bak'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(f.directory, backups[0]!), 'utf8')).toBe(f.source)
})
