import { EventEmitter, once } from 'node:events'
import { appendFileSync, open, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import pino from 'pino'

type FileSegment = {
  path: string
  bytes: number
  stream?: ReturnType<typeof pino.destination> & { destroyed: boolean }
  pending: string[]
}

function dateName(date = new Date()): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-')
}

function sizeBytes(size: string): number {
  const match = size.match(/^([\d.]+)(\w?)$/)
  if (!match) throw new Error(`${size} is not a valid size in KB, MB or GB`)
  const units: Record<string, number> = { b: 1, k: 1024, g: 1024 ** 3 }
  return Number(match[1]) * (units[match[2]!.toLowerCase()] ?? 1024 ** 2)
}

/** Reserves each whole record's file before asynchronous I/O can batch it with other records. */
class RotatingLogDestination extends EventEmitter {
  private readonly segments = new Map<string, FileSegment>()
  private active: FileSegment
  private date = dateName()
  private number: number

  constructor(private readonly file: string, private readonly maxBytes: number, number: number,
    private readonly onFlush: () => void) {
    super()
    this.number = number
    this.active = this.openSegment()
    this.scheduleDailyRoll()
  }

  write(record: string): void {
    if (this.date !== dateName() || (this.maxBytes && this.active.bytes >= this.maxBytes)) this.rotate()
    this.active.bytes += Buffer.byteLength(record)
    if (this.active.stream) this.active.stream.write(record)
    else this.active.pending.push(record)
  }

  isPendingFile(path: string): boolean {
    return this.segments.has(path)
  }

  flushSync(): void {
    for (const segment of this.segments.values()) {
      if (segment.stream && !segment.stream.destroyed) {
        segment.stream.flushSync()
      } else if (segment.pending.length) {
        // An exit cannot wait for an async open callback. Nothing is submitted until ready,
        // so draining these records here cannot duplicate an in-flight write.
        appendFileSync(segment.path, segment.pending.join(''))
        segment.pending = []
      }
    }
    this.updateSymlink()
    this.onFlush()
  }

  private openSegment(): FileSegment {
    const path = `${this.file.replace(/\.log$/, '')}.${this.date}.${this.number++}.log`
    const segment: FileSegment = { path, bytes: 0, pending: [] }
    this.segments.set(path, segment)
    // Pino registers an exit flush for each destination. Give it an already-open fd
    // so that its exit handler can never flush a destination whose open is pending.
    open(path, 'a', (error, fd) => {
      if (error) {
        this.emit('error', error)
        return
      }
      const stream = pino.destination({ dest: fd, sync: false }) as NonNullable<FileSegment['stream']>
      segment.stream = stream
      stream.on('error', error => this.emit('error', error))
      stream.once('close', () => {
        this.segments.delete(path)
        this.emit('segmentClosed')
        this.notifyReady()
      })
      for (const record of segment.pending) stream.write(record)
      segment.pending = []
      if (segment !== this.active) stream.end()
      this.updateSymlink()
      this.notifyReady()
    })
    return segment
  }

  private notifyReady(): void {
    if (this.segments.size === 1 && this.active.stream) this.emit('ready')
  }

  private rotate(): void {
    this.active.stream?.end()
    const date = dateName()
    if (date !== this.date) this.number = 1
    this.date = date
    this.active = this.openSegment()
  }

  private updateSymlink(): void {
    const link = join(dirname(this.file), 'current.log')
    const target = basename(this.active.path)
    try {
      if (readlinkSync(link) === target) return
      unlinkSync(link)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    symlinkSync(target, link)
  }

  private scheduleDailyRoll(): void {
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 0)
    setTimeout(() => {
      this.rotate()
      this.scheduleDailyRoll()
    }, midnight.getTime() - Date.now()).unref()
  }
}

export async function rotatingLogDestination(file: string, size: string,
  onFlush: () => void): Promise<RotatingLogDestination> {
  const prefix = `${basename(file).replace(/\.log$/, '')}.${dateName()}.`
  const names = await readdir(dirname(file))
  const numbers = names.filter(name => name.startsWith(prefix) && name.endsWith('.log'))
    .map(name => Number(name.slice(prefix.length, -4)))
    .filter(number => Number.isSafeInteger(number) && number > 0)
  const number = numbers.reduce((largest, value) => Math.max(largest, value), 0) + 1
  const destination = new RotatingLogDestination(file, sizeBytes(size), number, onFlush)
  await once(destination, 'ready')
  return destination
}
