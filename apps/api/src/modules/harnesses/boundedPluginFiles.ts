import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative as relativePath, resolve, sep } from 'node:path'
import { ignoreError } from '../diagnostics/ignoredError.js'

export const PLUGIN_FILE_LIMIT = 65_536
export const PLUGIN_DIRECTORY_LIMIT = 256
export const safePluginPart = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
export const pluginObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported plugin object.')
  return value as Record<string, unknown>
}

/** Deadline races also close handles that finish opening after cancellation. */
export async function pluginDeadline<T>(task: Promise<T>, signal: AbortSignal, late?: (value: T) => Promise<unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let canceled = false
    const abort = () => { canceled = true; reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void task.then((value) => {
      signal.removeEventListener('abort', abort)
      if (canceled) { void late?.(value).catch(ignoreError('harness', 'dispose late plugin file read')); return }
      resolve(value)
    }, (error: unknown) => { signal.removeEventListener('abort', abort); if (!canceled) reject(error) })
  })
}

/** No symlinks, special files, unbounded readFile/readdir, or traversal outside this root. */
export class BoundedPluginFiles {
  private directoryEntries = 0
  private constructor(readonly root: string, readonly signal: AbortSignal) {}
  static async create(root: string, signal: AbortSignal): Promise<BoundedPluginFiles> {
    const path = resolve(root)
    if (await pluginDeadline(realpath(path), signal) !== path
      || !(await pluginDeadline(lstat(path), signal)).isDirectory()) throw new Error('Uncontained plugin directory.')
    return new BoundedPluginFiles(path, signal)
  }
  private async path(relative: string): Promise<string | undefined> {
    this.signal.throwIfAborted()
    if (isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid plugin path.')
    const path = resolve(this.root, relative)
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new Error('Plugin path escapes its bundle.')
    try {
      const parts = relativePath(this.root, path).split(sep).filter(Boolean)
      if (parts.length > 64) throw new Error('Plugin path exceeds the inspection limit.')
      let current = this.root
      for (const [index, part] of parts.entries()) {
        current = resolve(current, part)
        const metadata = await pluginDeadline(lstat(current), this.signal)
        if (metadata.isSymbolicLink() || (index < parts.length - 1 && !metadata.isDirectory())) throw new Error('Plugin symlinks or special ancestors are not inspected.')
      }
      if (await pluginDeadline(realpath(path), this.signal) !== path) throw new Error('Plugin symlinks are not inspected.')
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private async file(relative: string): Promise<FileHandle | undefined> {
    const path = await this.path(relative)
    if (!path) return undefined
    // O_NONBLOCK makes opening a FIFO return without waiting for its peer.
    const handle = await pluginDeadline(open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
      this.signal, (late) => late.close())
    try {
      const stat = await pluginDeadline(handle.stat(), this.signal)
      if (!stat.isFile()) throw new Error('Plugin components must be regular files.')
      if (process.platform === 'linux') {
        if (await pluginDeadline(realpath(`/proc/self/fd/${handle.fd}`), this.signal) !== path) throw new Error('Plugin path changed during open.')
      } else {
        const current = await pluginDeadline(lstat(path), this.signal)
        if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev
          || await pluginDeadline(realpath(path), this.signal) !== path) throw new Error('Plugin path changed during open.')
      }
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  async regular(relative: string): Promise<boolean> {
    const handle = await this.file(relative)
    if (!handle) return false
    await handle.close()
    return true
  }
  async json(relative: string): Promise<Record<string, unknown> | undefined> {
    const handle = await this.file(relative)
    if (!handle) return undefined
    try {
      const before = await pluginDeadline(handle.stat(), this.signal)
      if (before.size > PLUGIN_FILE_LIMIT) throw new Error('Plugin component exceeds the inspection limit.')
      const buffer = Buffer.alloc(PLUGIN_FILE_LIMIT + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await pluginDeadline(handle.read(buffer, length, buffer.length - length, length), this.signal)
        if (!bytesRead) break
        length += bytesRead
      }
      const after = await pluginDeadline(handle.stat(), this.signal)
      if (length > PLUGIN_FILE_LIMIT || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) throw new Error('Plugin component changed or exceeded its limit.')
      return pluginObject(JSON.parse(buffer.subarray(0, length).toString('utf8')))
    } finally { await handle.close() }
  }
  async directories(relative: string): Promise<string[] | undefined> {
    const path = await this.path(relative)
    if (!path) return undefined
    if (!(await pluginDeadline(lstat(path), this.signal)).isDirectory()) throw new Error('Invalid plugin component directory.')
    const handle = await pluginDeadline(opendir(path, { bufferSize: 1 }), this.signal, (late) => late.close())
    try {
      const names: string[] = []
      let count = 0
      for (;;) {
        const item = await pluginDeadline(handle.read(), this.signal)
        if (!item) break
        if (++count > PLUGIN_DIRECTORY_LIMIT || ++this.directoryEntries > 4_096) throw new Error('Plugin directory exceeds the inspection limit.')
        if (item.isSymbolicLink()) throw new Error('Plugin directory contains a symlink.')
        if (item.isDirectory()) names.push(item.name)
      }
      if (await pluginDeadline(realpath(path), this.signal) !== path) throw new Error('Plugin directory changed during inspection.')
      return names.sort()
    } finally { await handle.close() }
  }
}
