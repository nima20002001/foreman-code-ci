import type { AccountProbePorts } from './accountProbe.js'
import type { SyncthingPorts } from './syncthingSystem.js'

const AVAILABILITY_CACHE_MS = 5000

export function createSyncthingAvailability(ports: Pick<AccountProbePorts, 'find' | 'run'>, unit: string) {
  let availability: { binary: string; at: number; pending: boolean; value: Promise<boolean> } | undefined
  const readRunning = async (signal?: AbortSignal): Promise<boolean> => {
    const timeout = AbortSignal.timeout(10_000)
    return (await ports.run('systemctl', ['--user', 'is-active', unit],
      signal ? AbortSignal.any([signal, timeout]) : timeout)).code === 0
  }
  const probeAvailability: SyncthingPorts['available'] = async signal => {
    signal?.throwIfAborted()
    const installed = Boolean(await ports.find('syncthing'))
    signal?.throwIfAborted()
    availability = undefined
    return { installed, running: installed && await readRunning(signal) }
  }
  const read: SyncthingPorts['available'] = async signal => {
    signal?.throwIfAborted()
    const binary = await ports.find('syncthing')
    signal?.throwIfAborted()
    if (!binary) {
      availability = undefined
      return { installed: false, running: false }
    }
    const now = Date.now()
    if (!availability || availability.binary !== binary || !availability.pending && (now < availability.at
        || now - availability.at >= AVAILABILITY_CACHE_MS)) {
      // Polling callers share one observation; preparation always checks service liveness afresh.
      const entry = { binary, at: now, pending: true, value: readRunning() }
      entry.value = entry.value.then(running => {
        entry.pending = false
        entry.at = Date.now()
        return running
      }).catch(error => {
        if (availability === entry) availability = undefined
        throw error
      })
      availability = entry
    }
    const value = availability.value
    let abort: (() => void) | undefined
    try {
      const running = signal ? await Promise.race([value, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })]) : await value
      signal?.throwIfAborted()
      return { installed: true, running }
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }
  return { read, probe: probeAvailability, invalidate: () => { availability = undefined } }
}
