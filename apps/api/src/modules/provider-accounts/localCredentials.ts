import { constants } from 'node:fs'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  ProviderAccountIdSchema, ProviderAccountApiKeyInputSchema, type ProviderAccount,
} from '@foreman-code/contracts/provider-accounts'
import { DomainError } from '../errors.js'
import { privateDirectory } from '../harnesses/recovery/storage.js'

async function secureDirectory(directory: string): Promise<void> {
  try {
    privateDirectory(directory)
  } catch {
    throw new DomainError('ACCOUNT_HOME_UNSAFE', 'The managed account directory is not private.', 409)
  }
}

async function privateFile(path: string): Promise<Buffer | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new DomainError('ACCOUNT_HOME_UNSAFE', 'An account credential file is not private.', 409)
      }
      return await file.readFile()
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writePrivateFile(path: string, value: Buffer | string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) {
      throw new DomainError('ACCOUNT_HOME_UNSAFE', 'An account credential file is not private.', 409)
    }
    await file.chmod(0o600)
    await file.truncate()
    await file.writeFile(value)
  } finally {
    await file.close()
  }
}

/** Only the local runtime receives paths and credentials from this storage. */
export class LocalProviderCredentials {
  private hostIdentity?: Promise<string>
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  hostId(): Promise<string> {
    this.hostIdentity ??= this.loadHostId()
    return this.hostIdentity
  }

  private async loadHostId(): Promise<string> {
    await secureDirectory(this.root)
    const path = join(this.root, 'host-id')
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(randomUUID()) } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return ProviderAccountIdSchema.parse((await privateFile(path))?.toString())
  }

  paths(accountId: string): { homePath: string; userHome: string } {
    ProviderAccountIdSchema.parse(accountId)
    const userHome = join(this.root, accountId)
    return { userHome, homePath: join(userHome, 'home') }
  }

  async create(account: ProviderAccount): Promise<void> {
    await this.hostId()
    const { userHome, homePath } = this.paths(account.id)
    try {
      await mkdir(userHome, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new DomainError('ACCOUNT_HOME_REUSED', 'The account directory already belongs to another slot.', 409, undefined, { cause: error })
    }
    await secureDirectory(userHome)
    await secureDirectory(homePath)
  }

  async assertAvailable(accountId: string): Promise<void> {
    const { userHome, homePath } = this.paths(accountId)
    for (const path of [this.root, userHome, homePath]) {
      let info
      try { info = await lstat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The selected account is unavailable on this computer.', 409, undefined, { cause: error })
      }
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new DomainError('ACCOUNT_HOME_UNSAFE', 'The managed account directory is not private.', 409)
      }
    }
    await secureDirectory(homePath)
  }

  async apiKey(accountId: string): Promise<string | undefined> {
    await this.assertAvailable(accountId)
    const bytes = await privateFile(join(this.paths(accountId).userHome, 'api-key'))
    if (!bytes) return undefined
    return ProviderAccountApiKeyInputSchema.shape.apiKey.parse(bytes.toString())
  }

  async saveApiKey(accountId: string, apiKey: string): Promise<void> {
    await this.assertAvailable(accountId)
    await writePrivateFile(join(this.paths(accountId).userHome, 'api-key'), apiKey)
  }

  async backup(account: ProviderAccount): Promise<Map<string, Buffer | null>> {
    await this.assertAvailable(account.id)
    const { homePath, userHome } = this.paths(account.id)
    const files = [join(userHome, 'api-key'), join(userHome, '.claude.json')]
    files.push(join(homePath, account.provider === 'codex' ? 'auth.json' : '.credentials.json'))
    const backup = new Map<string, Buffer | null>()
    for (const path of files) backup.set(path, await privateFile(path))
    return backup
  }

  async restore(backup: Map<string, Buffer | null>): Promise<void> {
    for (const [path, bytes] of backup) {
      if (bytes) await writePrivateFile(path, bytes)
      else await rm(path, { force: true })
    }
  }

  async clearApiKey(accountId: string): Promise<void> {
    await this.assertAvailable(accountId)
    await rm(join(this.paths(accountId).userHome, 'api-key'), { force: true })
  }

  async removeCreatedHome(accountId: string): Promise<void> {
    await this.assertAvailable(accountId)
    await rm(this.paths(accountId).userHome, { recursive: true })
  }
}
