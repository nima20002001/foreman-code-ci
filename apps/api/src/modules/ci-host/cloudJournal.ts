import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DomainError } from '../errors.js'
import type { CloudRun } from './cloudProviders.js'

export async function readCloudRun(path: string): Promise<CloudRun> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DomainError('CI_RUN_UNKNOWN', 'This provider has no such CI run.', 404, undefined, { cause: error })
    }
    throw error
  }
  try {
    const run = JSON.parse(text) as CloudRun
    if (!run.runId || !run.mirror || !run.commit || !run.state) throw new Error('Missing CI ownership')
    return run
  } catch (error) {
    const failure = new DomainError('CI_RUN_CORRUPT', 'Cloud CI ownership is corrupt; recovery is required.', 409)
    failure.cause = error
    throw failure
  }
}

export async function saveCloudRun(path: string, run: CloudRun): Promise<CloudRun> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.pending`
  try {
    await writeFile(temporary, JSON.stringify(run), { flag: 'wx', mode: 0o600 })
    const file = await open(temporary, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
    return run
  } finally {
    await rm(temporary, { force: true })
  }
}
