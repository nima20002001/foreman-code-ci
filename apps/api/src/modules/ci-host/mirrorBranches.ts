import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { unresolvedCloudAttemptIds } from './cloudAttempts.js'

const ciBranch = /^refs\/heads\/(?:ci|ci-default)\/.+$/
export interface ActiveCiRuns { ids: ReadonlySet<string>; readAt: number }

interface MirrorRun {
  circleAccountId?: string
  providerRunId?: string | null
  dispatchHistory?: { at: string; providerRunId: string | null; terminated?: true }[]
  runId: string
  startedAt: string
  mirror: string
  commit: string
  baseCommit?: string
  state: string
  mirrorBranch?: string
  dispatch?: { input: { branch: string; workflowRef?: string; defaultBranch?: string } }
}

// Sweeps run after every finished ticket over thousands of retained tickets; unchanged files are not parsed again.
const parsedMeta = new Map<string, { version: string; run: MirrorRun }>()

async function readRun(path: string): Promise<MirrorRun | undefined> {
  let version: string
  try {
    const info = await stat(path)
    version = `${info.ino}:${info.size}:${info.mtimeMs}`
  } catch (error) {
    // A run directory can precede its first atomic metadata write.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const cached = parsedMeta.get(path)
  if (cached?.version === version) return cached.run
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const run = JSON.parse(text) as MirrorRun
  parsedMeta.set(path, { version, run })
  return run
}

async function runDirectories(root: string) {
  try {
    return await readdir(join(root, 'runs'), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Terminal tickets release shared mirror branches; active tickets from both providers retain them. */
export async function pruneMirrorBranches(options: {
  mirror: string
  roots: string[]
  git: (args: string[]) => Promise<string>
  keep?: string[] | (() => string[] | ReadonlySet<string>)
  beforeRemove?: (branches: string[]) => void
  withRemovalLock?: (remove: () => Promise<void>) => Promise<void>
  activeRuns?: ActiveCiRuns | undefined
}) {
  const remote = `https://github.com/${options.mirror}.git`
  const listed = await options.git(['ls-remote', '--heads', remote, 'refs/heads/ci/*', 'refs/heads/ci-default/*'])
  const reservations = () => {
    const branches = typeof options.keep === 'function' ? options.keep() : options.keep ?? []
    return Array.isArray(branches) ? new Set(branches) : branches
  }
  const keep = new Set([...reservations()].map(branch => `refs/heads/${branch}`))
  for (const root of new Set(options.roots)) {
    for (const directory of await runDirectories(root)) {
      if (!directory.isDirectory()) continue
      const run = await readRun(join(root, 'runs', directory.name, 'meta.json'))
      if (!run) continue
      const pending = unresolvedCloudAttemptIds({ ...run, providerRunId: run.providerRunId ?? null }).length > 0
      if (run.mirror !== options.mirror || !['starting', 'running', 'queued'].includes(run.state) && !pending) continue
      const index = options.activeRuns
      // A new dispatch after the index was read stays protected until the next sweep.
      const newer = index && Date.parse(run.startedAt) > index.readAt
      if (index && !index.ids.has(run.runId) && !newer && !pending) continue
      const branch = run.dispatch?.input?.branch ?? run.mirrorBranch
      if (branch) keep.add(`refs/heads/${branch}`)
      else {
        // Older persisted tickets predate the stored mirror ref; either publication may still be in use.
        keep.add(`refs/heads/ci/${run.commit}`)
        if (run.baseCommit) keep.add(`refs/heads/ci/${run.commit}-${run.baseCommit}`)
      }
      keep.add(`refs/heads/ci-default/${run.commit}`)
      if (run.dispatch?.input?.workflowRef) keep.add(`refs/heads/${run.dispatch.input.workflowRef}`)
      if (run.dispatch?.input?.defaultBranch) keep.add(`refs/heads/${run.dispatch.input.defaultBranch}`)
    }
  }
  const refs = listed.split('\n').flatMap(line => {
    const [sha, ref] = line.trim().split(/\s+/)
    return sha && ref && ciBranch.test(ref) ? [{ sha, ref }] : []
  })
  const stale = refs.filter(({ ref }) => !keep.has(ref))
  const removed: string[] = []
  const withRemovalLock = options.withRemovalLock ?? ((remove: () => Promise<void>) => remove())
  for (let offset = 0; offset < stale.length; offset += 50) {
    await withRemovalLock(async () => {
      const reserved = reservations()
      const batch = stale.slice(offset, offset + 50).filter(({ ref }) => !reserved.has(ref.slice('refs/heads/'.length)))
      if (!batch.length) return
      // Evict cached publications before deletion so a new start republishes rather than reusing a removed ref.
      options.beforeRemove?.(batch.map(({ ref }) => ref.slice('refs/heads/'.length)))
      // A concurrently replaced branch must survive a sweep that saw its previous value.
      await options.git(['push', '--quiet', '--atomic', ...batch.map(({ sha, ref }) => `--force-with-lease=${ref}:${sha}`),
        remote, ...batch.map(({ ref }) => `:${ref}`)])
      removed.push(...batch.map(({ ref }) => ref.slice('refs/heads/'.length)))
    })
  }
  const removedRefs = new Set(removed.map(branch => `refs/heads/${branch}`))
  const retained = refs.filter(({ ref }) => !removedRefs.has(ref)).map(({ ref }) => ref.slice('refs/heads/'.length))
  return { removed, retained }
}

// The maintenance command calls the same sweep used when cloud tickets finish.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mirror, ...roots] = process.argv.slice(2)
  const flag = roots.indexOf('--active-runs-file')
  let activeRuns: ActiveCiRuns | undefined
  if (flag >= 0) {
    const file = roots[flag + 1]
    if (!file) throw new Error('--active-runs-file requires a JSON index file.')
    const index = JSON.parse(await readFile(file, 'utf8')) as { ids: unknown; readAt: unknown }
    if (!Array.isArray(index.ids) || !index.ids.every(id => typeof id === 'string')
      || typeof index.readAt !== 'number' || !Number.isFinite(index.readAt) || index.readAt < 0) {
      throw new Error('The active run index must contain string ids and a readAt timestamp.')
    }
    activeRuns = { ids: new Set(index.ids), readAt: index.readAt }
    roots.splice(flag, 2)
  }
  if (!mirror || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(mirror) || !roots.length) {
    throw new Error('Usage: mirrorBranches <owner/repository> <provider-root> [provider-root...]')
  }
  const execute = promisify(execFile)
  const swept = await pruneMirrorBranches({ mirror, roots, activeRuns, git: async args => {
    const result = await execute('git', args, { maxBuffer: 4 * 1024 * 1024 })
    return result.stdout.trim()
  } })
  console.log(JSON.stringify({ removed: swept.removed.length }))
}
