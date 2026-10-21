import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CiRuntimeWorkerStateSchema, type CiRuntimeWorkerState } from '@foreman-code/contracts'
import { pathExists } from '../../shared/pathExists.js'
import { readProtectedRuntimeConfiguration } from './installedRuntimeConfiguration.js'

export async function readCiRuntimeState(stateDirectory: string): Promise<CiRuntimeWorkerState | null> {
  const path = join(stateDirectory, 'ci-preparation-state.json')
  if (!await pathExists(path)) return null
  return readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() }, CiRuntimeWorkerStateSchema)
}

export async function writeCiRuntimeState(stateDirectory: string, state: CiRuntimeWorkerState): Promise<void> {
  const path = join(stateDirectory, 'ci-preparation-state.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
