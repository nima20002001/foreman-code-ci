import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './helpers/privateFixtureDirectory.js'

it.each([false, true])('removes every owned private directory after work (failure: %s)', async (failed) => {
  const created: string[] = []
  const failure = new Error('Fixture work failed')
  const work = withPrivateFixtureDirectories(async () => {
    created.push(await privateFixtureDirectory('fixture-cleanup-'))
    created.push(...await Promise.all([
      privateFixtureDirectory('fixture-cleanup-'), privateFixtureDirectory('fixture-cleanup-'),
    ]))
    for (const directory of created) await writeFile(join(directory, 'owned.txt'), 'fixture')
    if (failed) throw failure
    return 'completed'
  })
  if (failed) await expect(work).rejects.toBe(failure)
  else await expect(work).resolves.toBe('completed')
  expect(created).toHaveLength(3)
  for (const directory of created) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps another concurrent fixture directory while cleaning a completed scope', async () => {
  let release!: () => void
  let entered!: () => void
  const holding = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  let retained!: string
  const other = withPrivateFixtureDirectories(async () => {
    retained = await privateFixtureDirectory('fixture-cleanup-')
    entered()
    await holding
  })
  try {
    await ready
    const removed = await withPrivateFixtureDirectories(() => privateFixtureDirectory('fixture-cleanup-'))
    await expect(access(removed)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(retained)).resolves.toBeUndefined()
  } finally {
    release()
    await other
  }
  await expect(access(retained)).rejects.toMatchObject({ code: 'ENOENT' })
})
