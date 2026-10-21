import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import { bootIdentity, identityAlive, processIdentity } from '../harnesses/recovery/linuxIdentity.js'

const FileIdentitySchema = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
const OwnerSchema = z.object({
  version: z.literal(1), ownerId: z.uuid(), name: z.string().max(128), bootId: z.uuid(),
  process: z.object({ pid: z.number().int().min(2), startTicks: z.string().regex(/^\d+$/) }).strict(),
  root: FileIdentitySchema, artifact: FileIdentitySchema,
}).strict()
type Owner = z.infer<typeof OwnerSchema>
const lockName = /^(?:allocation|[a-f0-9-]{36})\.lock$/
const guardName = /^(?:allocation|[a-f0-9-]{36})\.lock-owner-[a-f0-9-]{36}$/
const readerName = /^[a-f0-9-]{36}\.reader-[a-f0-9-]{36}$/
const temporaryName = /^\.canonical-owner-([a-f0-9-]{36})\.tmp$/
const identity = (stat: BigIntStats) => ({ device: stat.dev.toString(), inode: stat.ino.toString() })
const sameIdentity = (left: z.infer<typeof FileIdentitySchema>, right: z.infer<typeof FileIdentitySchema>) =>
  left.device === right.device && left.inode === right.inode

/** Unique guard records serialize recovery as well as acquisition of each fixed lock. */
export class CanonicalTransferOwnership {
  private rootIdentity: z.infer<typeof FileIdentitySchema> | undefined
  constructor(private readonly directory: FileHandle) {}

  private path(name: string) { return `/proc/self/fd/${this.directory.fd}/${name}` }

  private async root() {
    this.rootIdentity ??= identity(await this.directory.stat({ bigint: true }))
    return this.rootIdentity
  }

  private stopped(owner: Owner) {
    return owner.bootId !== bootIdentity() || !identityAlive(owner.process)
  }

  private async read(name: string, options?: { unpublished: true }): Promise<Owner | undefined> {
    const handle = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
    if (!handle) return undefined
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size > 16384n || (stat.mode & 0o077n)
        || stat.uid !== BigInt(process.getuid!()) || stat.nlink > 2n) {
        throw new Error('Canonical transfer ownership unavailable')
      }
      const owner = OwnerSchema.parse(JSON.parse(await handle.readFile('utf8')))
      const named = await lstat(this.path(name), { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (!named) return undefined
      let nameMatches = owner.name === name
      if (options?.unpublished) {
        nameMatches = temporaryName.exec(name)?.[1] === owner.ownerId
          && (lockName.test(owner.name) || guardName.test(owner.name) || readerName.test(owner.name))
      }
      if (!nameMatches || !sameIdentity(owner.root, await this.root())
        || !sameIdentity(owner.artifact, identity(stat)) || !sameIdentity(identity(named), identity(stat))) {
        throw new Error('Canonical transfer ownership changed')
      }
      return owner
    } finally {
      await handle.close()
    }
  }

  private async remove(name: string, owner: Owner, options?: { unpublished: true }) {
    const current = await this.read(name, options)
    if (!current) return
    if (current.ownerId !== owner.ownerId || !sameIdentity(current.artifact, owner.artifact)) {
      throw new Error('Canonical transfer ownership changed')
    }
    await unlink(this.path(name)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await this.directory.sync()
  }

  private async create(name: string): Promise<Owner> {
    const processIdentityValue = processIdentity(process.pid)
    if (!processIdentityValue) throw new Error('Canonical transfer process identity unavailable')
    const ownerId = randomUUID()
    const temporary = this.path(`.canonical-owner-${ownerId}.tmp`)
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    const handle = await open(temporary, flags, 0o600)
    try {
      const owner = OwnerSchema.parse({
        version: 1, ownerId, name, bootId: bootIdentity(),
        process: { pid: processIdentityValue.pid, startTicks: processIdentityValue.startTicks },
        root: await this.root(), artifact: identity(await handle.stat({ bigint: true })),
      })
      await handle.writeFile(JSON.stringify(owner))
      await handle.sync()
      // link publishes the complete record without replacing another owner.
      await link(temporary, this.path(name))
      await this.directory.sync()
      return owner
    } finally {
      await handle.close()
      await unlink(temporary)
      await this.directory.sync()
    }
  }

  private async guards(name: string, own: Owner) {
    for (const entry of await readdir(this.path(''))) {
      if (!entry.startsWith(`${name}-owner-`)) continue
      const other = await this.read(entry)
      if (!other || other.ownerId === own.ownerId) continue
      if (!this.stopped(other)) throw new Error('Transfer writer busy')
      await this.remove(entry, other)
    }
  }

  async acquire(name: string): Promise<() => Promise<void>> {
    if (!lockName.test(name)) throw new Error('Invalid canonical transfer lock')
    const guard = `${name}-owner-${randomUUID()}`
    const own = await this.create(guard)
    let acquired: Owner | undefined
    try {
      await this.guards(name, own)
      const previous = await this.read(name)
      if (previous) {
        if (!this.stopped(previous)) throw new Error('Transfer writer busy')
        await this.remove(name, previous)
      }
      acquired = await this.create(name)
      const lock = acquired
      return async () => {
        await this.remove(name, lock)
        await this.remove(guard, own)
      }
    } catch (error) {
      if (!acquired) await this.remove(guard, own)
      throw error
    }
  }

  async reader(name: string): Promise<() => Promise<void>> {
    if (!readerName.test(name)) throw new Error('Invalid canonical transfer reader')
    const owner = await this.create(name)
    return () => this.remove(name, owner)
  }

  async recoverReaders(id: string): Promise<void> {
    for (const name of await readdir(this.path(''))) {
      if (!readerName.test(name) || !name.startsWith(`${id}.reader-`)) continue
      const owner = await this.read(name)
      if (owner && this.stopped(owner)) await this.remove(name, owner)
    }
  }

  private async recoverTemporary(name: string) {
    let owner: Owner | undefined
    try {
      owner = await this.read(name, { unpublished: true })
    } catch (error) {
      // Interrupted writes contain no complete ownership record and remain retained.
      if (error instanceof SyntaxError || error instanceof z.ZodError) return
      throw error
    }
    if (owner && this.stopped(owner)) await this.remove(name, owner, { unpublished: true })
  }

  async recover(): Promise<void> {
    for (const name of await readdir(this.path(''))) {
      if (temporaryName.test(name)) {
        await this.recoverTemporary(name)
        continue
      }
      if (!readerName.test(name) && !guardName.test(name) && !lockName.test(name)) continue
      const owner = await this.read(name)
      if (!owner || !this.stopped(owner)) continue
      if (lockName.test(name)) {
        const release = await this.acquire(name)
        await release()
      } else {
        await this.remove(name, owner)
      }
    }
  }
}
