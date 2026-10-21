import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

interface ConflictEntry { name: string; conflict: boolean }
interface Scan {
  entries: AsyncGenerator<ConflictEntry, void>
  discovered: Set<string>
  previous: string[]
}

// Keep one directory open at a time, including when a bounded slice pauses.
async function* treeEntries(root: string): AsyncGenerator<ConflictEntry, void> {
  const directories = ['']
  while (directories.length) {
    const relative = directories.pop()!
    for await (const entry of await opendir(join(root, relative))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const ignored = entry.name === '.stversions' || entry.name === '.stfolder'
      if (!ignored && entry.isDirectory()) directories.push(name)
      yield { name, conflict: !ignored && entry.isFile() && entry.name.includes('.sync-conflict-') }
    }
  }
}

export class SyncthingConflictScanner {
  private readonly scans = new Map<string, Scan>()

  async scan(path: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    let scan = this.scans.get(path)
    if (!scan) {
      scan = { entries: treeEntries(path), discovered: new Set(), previous: [] }
      this.scans.set(path, scan)
    }
    let conflicts = 0
    for (let remaining = 10_000; remaining > 0 && conflicts < 100; remaining--) {
      signal?.throwIfAborted()
      let entry: IteratorResult<ConflictEntry, void>
      try { entry = await scan.entries.next() } catch (error) {
        this.scans.delete(path)
        throw error
      }
      if (entry.done) {
        scan.previous = [...scan.discovered]
        scan.discovered.clear()
        scan.entries = treeEntries(path)
        return [...scan.previous]
      }
      if (entry.value.conflict) {
        conflicts++
        if (scan.discovered.size < 100) scan.discovered.add(entry.value.name)
      }
    }
    // Retain earlier discoveries until a full pass can confirm their removal.
    return [...new Set([...scan.discovered, ...scan.previous])].slice(0, 100)
  }

  async forget(path: string): Promise<void> {
    const scan = this.scans.get(path)
    this.scans.delete(path)
    await scan?.entries.return()
  }
}
