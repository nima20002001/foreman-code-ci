import { createServer } from 'node:http'
import { once } from 'node:events'
import type { SyncthingPorts } from '../../src/modules/computers/syncthingSystem.js'
import type { SyncIdentity } from '@foreman-code/contracts/computer-accounts'

export const mainSyncId = Array(8).fill('AAAAAAA').join('-')
export const workerSyncId = Array(8).fill('BBBBBBB').join('-')
export async function fakeSyncthing(identity: SyncIdentity = {
  deviceId: mainSyncId, address: '100.64.0.1', rootPath: '/main/shared',
}) {
  const folders = new Map<string, Record<string, unknown>>()
  const devices = new Map<string, Record<string, unknown>>()
  const states = new Map<string, { state: string; pullErrors?: number; error?: string }>()
  const connections: Record<string, { connected: boolean }> = {}
  const conflicts = new Map<string, string[]>()
  const directories = new Set<string>()
  let installed = false
  let running = false
  let failConfiguration = false
  let options: Record<string, unknown> = {}
  const server = createServer(async (request, response) => {
    if (request.headers['x-api-key'] !== 'local-key') { response.writeHead(403).end(); return }
    const url = new URL(request.url!, 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) as Record<string, unknown> : {}
    const method = request.method
    let value: unknown = null
    if (failConfiguration && method !== 'GET') { response.writeHead(500).end(); return }
    if (url.pathname === '/rest/system/status') value = { myID: identity.deviceId }
    else if (url.pathname === '/rest/system/connections') value = { connections }
    else if (url.pathname === '/rest/config/options') {
      if (method === 'PATCH') options = { ...options, ...body }
      value = options
    } else if (url.pathname === '/rest/config/defaults/device') value = { addresses: ['dynamic'], autoAcceptFolders: false }
    else if (url.pathname === '/rest/config/defaults/folder') value = { devices: [], fsWatcherEnabled: true }
    else if (url.pathname === '/rest/config/devices') {
      if (method === 'POST') devices.set(body.deviceID as string, body)
      value = [...devices.values()]
    } else if (url.pathname === '/rest/config/folders') {
      if (method === 'POST') folders.set(body.id as string, body)
      value = [...folders.values()]
    } else if (url.pathname.startsWith('/rest/config/folders/')) {
      folders.delete(url.pathname.split('/').at(-1)!)
    } else if (url.pathname === '/rest/db/status') value = states.get(url.searchParams.get('folder')!) ?? { state: 'idle' }
    else { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(value))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const rest: SyncthingPorts['rest'] = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { 'X-API-Key': 'local-key', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error(`Syncthing request failed (${response.status})`)
    return response.json() as Promise<unknown>
  }
  const ports: SyncthingPorts = { rest,
    prepare: async () => {
      installed = true
      running = true
      await rest('PATCH', '/rest/config/options', { globalAnnounceEnabled: false, localAnnounceEnabled: false,
        relaysEnabled: false, natEnabled: false, listenAddresses: [`tcp://${identity.address}:22001`] })
      return identity
    },
    available: async () => ({ installed, running }),
    mkdir: async path => { directories.add(path) },
    conflicts: async path => conflicts.get(path) ?? [],
  }
  return { ports, rest, connections, conflicts, states, directories, identity,
    failConfiguration: (value: boolean) => { failConfiguration = value },
    stop: () => { running = false },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
