import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { CiIntegrationCoverageSchema, type CiCoverageSelection, type IntegrationCoverage } from '@foreman-code/contracts'
import { compactIntegrationCoverage, usableIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { ciInfrastructureFile } from '@foreman-code/contracts/ci-import-graph'
import type { CiCommits } from './serviceTypes.js'

const COVERAGE_ARTIFACT_LIMIT = 32

export class IntegrationCoverageStore {
  private readonly writes = new Map<string, Promise<void>>()
  private selections = new WeakMap<object, Map<string, Promise<CiCoverageSelection>>>()

  constructor(private readonly root = join(homedir(), '.cache/foreman-code/integration-coverage')) {}

  private directory(repository: string) {
    return join(this.root, createHash('sha256').update(repository).digest('hex'))
  }

  private async candidates(repository: string): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory(repository), 'index.json'), 'utf8'))
      if (!Array.isArray(value) || value.some(commit => typeof commit !== 'string'
        || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))) throw new Error('Invalid coverage artifact index')
      return value.slice(0, COVERAGE_ARTIFACT_LIMIT)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** CI partitions report independently; serialize merges so the last partition cannot erase its siblings. */
  async record(repository: string, commit: string, fragment: IntegrationCoverage) {
    const path = join(this.directory(repository), `${commit}.json`)
    const directory = this.directory(repository)
    const previous = this.writes.get(directory) ?? Promise.resolve()
    const pending = previous.then(async () => {
      const parsed = CiIntegrationCoverageSchema.parse({ ...fragment, commit })
      const saved = await this.read(path)
      const coverage = { ...saved?.coverage }
      for (const [file, files] of Object.entries(parsed.coverage)) {
        coverage[file] = [...new Set([...(coverage[file] ?? []), ...files])]
      }
      const staticTests = [...new Set([...(saved?.staticTests ?? []), ...(parsed.staticTests ?? [])])].sort()
      const merged = CiIntegrationCoverageSchema.parse({ ...parsed, coverage, staticTests })
      await mkdir(this.directory(repository), { recursive: true })
      await writeFile(`${path}.writing`, JSON.stringify(merged))
      await rename(`${path}.writing`, path)
      const retained = [commit, ...(await this.candidates(repository)).filter(value => value !== commit)]
        .slice(0, COVERAGE_ARTIFACT_LIMIT)
      const index = join(directory, 'index.json')
      await writeFile(`${index}.writing`, JSON.stringify(retained))
      await rename(`${index}.writing`, index)
      const known = new Set(retained.map(value => `${value}.json`))
      for (const file of await readdir(directory)) {
        if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?\.json(?:\.writing)?$/.test(file) && !known.has(file)) {
          await rm(join(directory, file), { force: true })
        }
      }
      this.selections = new WeakMap()
    })
    this.writes.set(directory, pending)
    try { await pending }
    finally { if (this.writes.get(directory) === pending) this.writes.delete(directory) }
  }

  private async read(path: string): Promise<IntegrationCoverage | undefined> {
    try { return CiIntegrationCoverageSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  selection(repository: string, commit: string, commits: Pick<CiCommits, 'coverageAncestors' | 'testTree'>) {
    const key = `${repository}:${commit}`
    let cache = this.selections.get(commits)
    if (!cache) {
      cache = new Map()
      this.selections.set(commits, cache)
    }
    const saved = cache.get(key)
    if (saved) return saved
    const pending = this.select(repository, commit, commits).catch(error => {
      cache.delete(key)
      throw error
    })
    cache.set(key, pending)
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return pending
  }

  private async select(repository: string, commit: string, commits: Pick<CiCommits, 'coverageAncestors' | 'testTree'>)
    : Promise<CiCoverageSelection> {
    const fallback = (reason: string): CiCoverageSelection => ({ changedFiles: [], reason })
    if (!commits.coverageAncestors || !commits.testTree) return fallback('Repository ancestry or source trees are unavailable.')
    const candidates = await this.candidates(repository)
    if (!candidates.length) return fallback('No integration coverage artifacts are available.')
    let newest: IntegrationCoverage | undefined
    for (const ancestor of await commits.coverageAncestors(repository, commit, candidates)) {
      const map = await this.read(join(this.directory(repository), `${ancestor}.json`))
      if (usableIntegrationCoverage(map)) {
        newest = map
        break
      }
    }
    if (!newest) return fallback('No usable coverage map from an ancestor commit is available.')
    const [before, after] = await Promise.all([
      commits.testTree(repository, newest.commit), commits.testTree(repository, commit),
    ])
    const changedFiles = [...new Set([...before.blobs.keys(), ...after.blobs.keys()])]
      .filter(file => before.blobs.get(file) !== after.blobs.get(file)).sort()
    if (changedFiles.some(ciInfrastructureFile)) return fallback('Coverage map predates lockfile or CI infrastructure changes.')
    const map = gzipSync(JSON.stringify(compactIntegrationCoverage(newest))).toString('base64')
    if (map.length > 700_000) return fallback('Coverage map exceeds the device report limit.')
    return { map, changedFiles }
  }
}
