import { errorMessage } from '../../shared/errorMessage.js'
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { RsyncOwnerReference } from './rsyncWriterOwnership.js'

/** This is a separate installed entrypoint, never part of the normal worker import graph. */
export function parseRsyncWriterArguments(args: readonly string[]): { root: string; reference: RsyncOwnerReference; args: string[] } {
  const flags = ['--rsync-root', '--rsync-transfer', '--rsync-owner', '--rsync-owner-digest']
  if (flags.some((flag, index) => args[index * 2] !== flag) || args[8] !== '--server'
    || args.length > 72 || args.some(value => value.includes('\0') || value.length > 4096)) throw new Error('Invalid rsync writer invocation')
  const root = args[1]!
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(root) || root.split('/').some(value => value === '.' || value === '..')) {
    throw new Error('Invalid protected rsync root')
  }
  const reference = { transferId: z.uuid().parse(args[3]), ownerId: z.uuid().parse(args[5]),
    ownerDigest: z.string().regex(/^[a-f0-9]{64}$/).parse(args[7]) }
  return { root, reference, args: args.slice(8) }
}

export async function runRsyncWriterCli(args: readonly string[], signal: AbortSignal): Promise<number> {
  const input = parseRsyncWriterArguments(args)
  // Reject an absent/unsafe installed root BEFORE a constructor can create any metadata.
  for (const path of [input.root, join(input.root, '.rsync-writers'), join(input.root, '.rsync-writers', input.reference.transferId)]) {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error('Protected rsync ownership root unavailable')
  }
  signal.throwIfAborted()
  // Native recovery logs normally use stdout. It is exclusively the rsync protocol here;
  // import the ownership graph only AFTER disabling that process's component logging.
  process.env.LOG_LEVEL = 'silent'
  const { RsyncWriterOwnership, runRsyncRemoteServer } = await import('./rsyncWriterOwnership.js')
  const ownership = new RsyncWriterOwnership(input.root, () => undefined)
  return runRsyncRemoteServer({ ownership, reference: input.reference, args: input.args, signal })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Rsync writer interrupted'))
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  void runRsyncWriterCli(process.argv.slice(2), controller.signal).then(code => { process.exitCode = code })
    .catch(error => {
      const reason = errorMessage(error, 'Unknown writer failure')
      process.stderr.write(`Rsync writer failed: ${reason.slice(0, 2048)}; original ownership retained\n`)
      process.exitCode = 1
    })
    .finally(() => { process.off('SIGTERM', stop); process.off('SIGINT', stop) })
}
