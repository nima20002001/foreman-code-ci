import { randomUUID } from 'node:crypto'
import { cp, mkdir, open, readFile, readdir, rename, rm, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DomainError } from '../errors.js'
import { browserProcessAlive, readBrowserProcessIdentity } from './processIdentity.js'

interface CheckpointRow { directory: string; before: Record<string, unknown>; generation: number }
interface ProfileCheckpoint { id: string; rows: CheckpointRow[]; state: 'preparing' | 'prepared' | 'restored' }

async function save(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const parent = await open(dirname(path), 'r')
  try { await parent.sync() } finally { await parent.close() }
}

export async function syncBrowserProfileTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) for (const name of await readdir(path)) await syncBrowserProfileTree(join(path, name))
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function assertBrowserGenerationStopped(directory: string): Promise<void> {
  const owner = await readBrowserProcessIdentity(directory)
  if (owner && browserProcessAlive(owner.pid, owner.birthId)) throw new DomainError('PROFILE_BUSY', 'An owned browser process still uses this profile generation.', 409)
}

export async function checkpointBrowserRuntimeProfiles(profileStateRoot: string,
  closeProfile: (profileId: string) => Promise<void>): Promise<{ profileCheckpointId: string; profileStateRoot: string }> {
  const directory = join(profileStateRoot, 'checkpoints'); await mkdir(directory, { recursive: true, mode: 0o700 })
  const id = randomUUID(), checkpoint: ProfileCheckpoint = { id, rows: [], state: 'preparing' }
  const path = join(directory, `${id}.json`), profiles = join(profileStateRoot, 'profiles')
  await mkdir(profiles, { recursive: true, mode: 0o700 })
  for (const name of await readdir(profiles)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue
    const root = join(profiles, name)
    let before: Record<string, unknown>
    try { before = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')) as Record<string, unknown> } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (before.deleted) continue
    if (typeof before.profileId !== 'string' || !Number.isSafeInteger(before.generation)) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'A managed profile needs recovery before update.', 409)
    await closeProfile(before.profileId)
    const generation = Number(before.generation) + 1
    await assertBrowserGenerationStopped(join(root, `generation-${before.generation}`))
    checkpoint.rows.push({ directory: name, before, generation })
  }
  await save(path, checkpoint)
  try {
    for (const row of checkpoint.rows) {
      const root = join(profiles, row.directory), destination = join(root, `generation-${row.generation}`)
      await assertBrowserGenerationStopped(destination)
      await rm(destination, { recursive: true, force: true })
      await cp(join(root, `generation-${row.before.generation}`), destination, { recursive: true, dereference: false, errorOnExist: true })
      // Copied native ownership receipts cannot identify the new generation directory.
      await rm(join(destination, 'foreman-process.json'), { force: true })
      await rm(join(destination, 'DevToolsActivePort'), { force: true })
      await syncBrowserProfileTree(destination)
      await save(join(root, 'profile.json'), { ...row.before, generation: row.generation, runtimeCheckpointId: id })
    }
    checkpoint.state = 'prepared'; await save(path, checkpoint)
    return { profileCheckpointId: id, profileStateRoot }
  } catch (error) {
    await restoreBrowserRuntimeProfiles({ profileStateRoot, checkpointId: id }); throw error
  }
}

/** Persistence-only entry for the separate update supervisor; requires a drained/stopped new host. */
export async function restoreBrowserRuntimeProfiles(input: { profileStateRoot: string; checkpointId: string }): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(input.checkpointId)) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'Invalid browser profile checkpoint.', 400)
  const path = join(input.profileStateRoot, 'checkpoints', `${input.checkpointId}.json`)
  const checkpoint = JSON.parse(await readFile(path, 'utf8')) as ProfileCheckpoint
  if (checkpoint.id !== input.checkpointId || !Array.isArray(checkpoint.rows)) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'Invalid browser profile checkpoint.', 409)
  if (checkpoint.state === 'restored') return
  for (const row of checkpoint.rows) {
    if (!/^[a-f0-9]{64}$/.test(row.directory) || !Number.isSafeInteger(row.generation) || row.generation < 1) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'Invalid browser profile checkpoint row.', 409)
    const root = join(input.profileStateRoot, 'profiles', row.directory)
    await assertBrowserGenerationStopped(join(root, `generation-${row.generation}`))
    const current = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')) as Record<string, unknown>
    if (current.generation !== row.before.generation && (current.generation !== row.generation
      || current.runtimeCheckpointId !== checkpoint.id || current.revision !== row.before.revision)) {
      throw new DomainError('PROFILE_CHECKPOINT_SUPERSEDED', 'A later profile operation superseded this runtime checkpoint.', 409)
    }
  }
  for (const row of checkpoint.rows) await save(join(input.profileStateRoot, 'profiles', row.directory, 'profile.json'), row.before)
  checkpoint.state = 'restored'; await save(path, checkpoint)
}

export function createBrowserRuntimeProfileCheckpoint(input: { profileStateRoot: string }) {
  return checkpointBrowserRuntimeProfiles(input.profileStateRoot, async () => {
    // The stopped-host installer owns its existing update lock; each native generation is independently checked below.
  })
}

/** Called only after healthy runtime cutover. Current, prior, rollback and uncertain generations survive. */
export async function pruneBrowserRuntimeProfiles(input: { profileStateRoot: string; retainedCheckpointIds: readonly string[] }): Promise<void> {
  const checkpoints = join(input.profileStateRoot, 'checkpoints'), profiles = join(input.profileStateRoot, 'profiles')
  await mkdir(checkpoints, { recursive: true, mode: 0o700 })
  await mkdir(profiles, { recursive: true, mode: 0o700 })
  const protectedGenerations = new Map<string, Set<number>>(), obsolete: string[] = []
  for (const name of await readdir(checkpoints)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
    const checkpoint = JSON.parse(await readFile(join(checkpoints, name), 'utf8')) as ProfileCheckpoint
    if (name !== `${checkpoint.id}.json` || !Array.isArray(checkpoint.rows)) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'Invalid retained profile checkpoint.', 409)
    if (checkpoint.state !== 'preparing' && !input.retainedCheckpointIds.includes(checkpoint.id)) { obsolete.push(name); continue }
    for (const row of checkpoint.rows) {
      if (!/^[a-f0-9]{64}$/.test(row.directory) || !Number.isSafeInteger(row.generation)
        || !Number.isSafeInteger(row.before.generation)) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'Invalid retained profile generation.', 409)
      const keep = protectedGenerations.get(row.directory) ?? new Set<number>()
      keep.add(row.generation); keep.add(Number(row.before.generation)); protectedGenerations.set(row.directory, keep)
    }
  }
  for (const name of await readdir(profiles)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue
    const root = join(profiles, name)
    let current: { generation: number }
    try { current = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')) as typeof current } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!Number.isSafeInteger(current.generation) || current.generation < 1) throw new DomainError('PROFILE_CHECKPOINT_INVALID', 'Invalid current profile generation.', 409)
    const generations = (await readdir(root)).flatMap(entry => {
      const match = /^generation-(\d+)$/.exec(entry); return match ? [Number(match[1])] : []
    }).sort((a, b) => b - a)
    const keep = protectedGenerations.get(name) ?? new Set<number>()
    keep.add(current.generation)
    const previous = generations.find(generation => generation < current.generation)
    if (previous !== undefined) keep.add(previous)
    for (const generation of generations) {
      // A current importer owns a newer staging generation; only older, stopped material is eligible.
      if (generation >= current.generation || keep.has(generation)) continue
      const directory = join(root, `generation-${generation}`)
      try { await assertBrowserGenerationStopped(directory) } catch (error) {
        if (error instanceof DomainError && error.code === 'PROFILE_BUSY') continue
        throw error
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
  for (const name of obsolete) await rm(join(checkpoints, name), { force: true })
}
