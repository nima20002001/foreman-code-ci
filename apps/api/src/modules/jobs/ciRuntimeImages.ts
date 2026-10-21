import { createHash } from 'node:crypto'
import { runCiRuntimeCommand } from './ciRuntimeCommands.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'

export async function retainedCiJobImages(journal: Pick<RemoteOperationJournal, 'jobOperations' | 'jobNativeOwner'>) {
  const images: string[] = []
  for (const receipt of await journal.jobOperations()) {
    const finished = receipt.terminal?.processStopped && ['complete', 'failed'].includes(receipt.publication)
    if (finished && (await journal.jobNativeOwner(receipt.intent.operationId))?.sourceReclamation) continue
    images.push(receipt.execution.acceptedSpec.policy.imageDigest)
  }
  return [...new Set(images)]
}

export async function pruneCiImages({ keep, env, installer, signal }: {
  keep: readonly string[]; env: NodeJS.ProcessEnv; installer: string; signal?: AbortSignal | undefined
}) {
  const kept = new Set(keep.map(id => id.replace(/^sha256:/u, '')))
  const installation = createHash('sha256').update(installer).digest('hex')
  const podman = (args: string[]) => runCiRuntimeCommand('podman', ['--remote=false', ...args], { env, signal })
  const listed = JSON.parse((await podman(['images', '--format', 'json'])).stdout) as
    { Id: string; Names?: string[] }[]
  for (const image of listed) {
    const id = image.Id.replace(/^sha256:/u, '')
    if (kept.has(id)) continue
    const names = image.Names ?? []
    if (!names.length || !names.every(name =>
      /^localhost\/foreman-code-(?:verification|ci-build):(?:[a-f0-9]{12}|[a-f0-9]{40}|[a-f0-9]{64})$/u.test(name))) {
      continue
    }
    const inspected = JSON.parse((await podman(['image', 'inspect', image.Id])).stdout) as
      { Id: string; Labels?: Record<string, string> }[]
    const owned = inspected[0]
    if (inspected.length !== 1 || owned?.Id.replace(/^sha256:/u, '') !== id
      || owned.Labels?.['io.foreman-code.installation'] !== installation) continue
    // Podman refuses removal while an execution or Buildah container references the image.
    const references = names.length > 1 ? names : [image.Id]
    await podman(['rmi', '--no-prune', ...references]).catch(error => {
      if (error.code !== 2) throw error
    })
  }
  // Include intermediate build images. Removal without force or parent pruning preserves
  // layers still referenced by kept images, foreign images, or containers.
  let removed: boolean
  do {
    removed = false
    const dangling = JSON.parse((await podman(['images', '--all', '--filter', 'dangling=true', '--format', 'json'])).stdout) as
      { Id: string; Names?: string[] }[]
    for (const image of dangling) {
      const id = image.Id.replace(/^sha256:/u, '')
      if (kept.has(id) || image.Names?.length) continue
      const inspected = JSON.parse((await podman(['image', 'inspect', image.Id])).stdout) as
        { Id: string; Labels?: Record<string, string> }[]
      const owned = inspected[0]
      const owner = owned?.Labels?.['io.foreman-code.installation']
      if (inspected.length !== 1 || owned?.Id.replace(/^sha256:/u, '') !== id
        || (owner !== undefined && owner !== installation)) continue
      try {
        await podman(['rmi', '--no-prune', image.Id])
        removed = true
      } catch (error) {
        if ((error as { code?: unknown }).code !== 2) throw error
      }
    }
  } while (removed)
}
