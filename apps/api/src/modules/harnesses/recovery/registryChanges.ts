import { lstatSync, watch, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { observeRecordWrites } from './storage.js'

function stamp(path: string): string | undefined {
  try {
    const stat = lstatSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Only unresolved registrations need synchronous metadata checks between writes. */
export class RegistryChanges {
  private rootStamp: string | undefined
  private watcher: FSWatcher | undefined
  private watcherError: Error | undefined
  private readonly ownerWatchers = new Map<string, FSWatcher>()
  private readonly owners = new Map<string, { stamp: string | undefined; launches: Set<string> }>()
  private readonly registrations = new Map<string, string | undefined>()
  private dirtyRoot = false
  private readonly dirtyOwners = new Set<string>()
  private readonly dirtyLaunches = new Set<string>()

  constructor(private readonly root: string) {
    observeRecordWrites(root, path => this.changed(relative(root, path)))
  }

  private changed(path: string): void {
    const [owner, id] = path.split(sep)
    const archived = owner === 'closed' && id ? /^([0-9a-f]{64})(?:-[0-9a-f-]{36})?\.json$/.exec(id) : null
    if (archived) {
      // An archive record belongs to exactly one owner; it never changes the owner inventory.
      this.dirtyOwners.add(archived[1]!)
    } else if (!owner || !/^[0-9a-f]{64}$/.test(owner)) {
      this.dirtyRoot = true
    } else if (id && /^[0-9a-f-]{36}$/.test(id)) {
      this.dirtyLaunches.add(join(owner, id))
    } else if (!id || id === 'retired.json') {
      this.dirtyOwners.add(owner)
    }
  }

  private watchDirectory(path: string, onChange: (filename: string | null) => void,
    onMissing: () => void): FSWatcher | undefined {
    let watcher: FSWatcher
    try {
      // Non-recursive: Node's userland recursive watch rereads and stats the whole tree on events.
      watcher = watch(path, { persistent: false }, (_event, filename) => onChange(filename?.toString() ?? null))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      onMissing()
      return undefined
    }
    watcher.on('error', error => {
      // A watched directory can disappear while another process removes it.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') onMissing()
      else this.watcherError = error
    })
    return watcher
  }

  start(): void {
    this.rootStamp = stamp(this.root)
    if (this.rootStamp === undefined || this.watcher) return
    this.watcher = this.watchDirectory(this.root, filename => {
      if (filename === null) this.dirtyRoot = true
      else this.changed(filename)
    }, () => { this.dirtyRoot = true })
  }

  /** Each owner directory has its own watch, so an event costs one owner refresh. */
  watchOwner(owner: string): void {
    if (this.ownerWatchers.has(owner)) return
    const watcher = this.watchDirectory(join(this.root, owner), filename => {
      if (filename !== null && /^[0-9a-f-]{36}$/.test(filename)) this.dirtyLaunches.add(join(owner, filename))
      else this.dirtyOwners.add(owner)
    }, () => {
      this.unwatchOwner(owner)
      this.dirtyOwners.add(owner)
    })
    if (watcher) this.ownerWatchers.set(owner, watcher)
  }

  unwatchOwner(owner: string): void {
    this.ownerWatchers.get(owner)?.close()
    this.ownerWatchers.delete(owner)
  }

  poll(): { root: boolean; owners: readonly string[]; launches: readonly string[] } {
    if (this.watcherError) throw this.watcherError
    const rootStamp = stamp(this.root)
    if (rootStamp !== this.rootStamp) this.dirtyRoot = true
    if (rootStamp === undefined) {
      this.watcher?.close()
      this.watcher = undefined
      for (const owner of [...this.ownerWatchers.keys()]) this.unwatchOwner(owner)
    }
    for (const [owner, previous] of this.owners) {
      if (stamp(join(this.root, owner)) !== previous.stamp) this.dirtyOwners.add(owner)
    }
    for (const [path, previous] of this.registrations) {
      if (stamp(join(this.root, path)) !== previous) this.dirtyLaunches.add(path)
    }
    return { root: this.dirtyRoot, owners: [...this.dirtyOwners], launches: [...this.dirtyLaunches] }
  }

  scannedRoot(): void {
    this.rootStamp = stamp(this.root)
    this.dirtyRoot = false
    this.start()
  }

  scannedOwner(owner: string, ids: readonly string[]): void {
    const paths = new Set(ids.map(id => join(owner, id)))
    for (const path of this.owners.get(owner)?.launches ?? []) {
      if (!paths.has(path)) this.registrations.delete(path)
    }
    if (ids.length) {
      this.owners.set(owner, { stamp: stamp(join(this.root, owner)), launches: paths })
    } else {
      this.owners.delete(owner)
    }
    this.dirtyOwners.delete(owner)
  }

  trackLaunch(owner: string, id: string): void {
    const path = join(owner, id)
    this.registrations.set(path, stamp(join(this.root, path)))
    let entry = this.owners.get(owner)
    if (!entry) {
      entry = { stamp: undefined, launches: new Set() }
      this.owners.set(owner, entry)
    }
    entry.launches.add(path)
    entry.stamp = stamp(join(this.root, owner))
    this.dirtyLaunches.delete(path)
  }

  forgetLaunch(owner: string, id: string): void {
    const path = join(owner, id)
    this.registrations.delete(path)
    const paths = this.owners.get(owner)?.launches
    paths?.delete(path)
    if (!paths?.size) {
      this.owners.delete(owner)
    }
    this.dirtyLaunches.delete(path)
  }

  rescan(): void { this.dirtyRoot = true }

  publishedLaunch(owner: string, id: string): void {
    this.dirtyLaunches.add(join(owner, id))
    // Local publication accounts for its own new owner without rescanning old owners.
    this.rootStamp = stamp(this.root)
  }
}
