import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DomainError } from '../errors.js'
import { Budget } from '../files/archives/policy.js'
import { decodeEntry, parseZip } from '../files/archives/zip.js'
import { CloudHttp } from './cloudHttp.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

interface Job {
  id: number; name: string; status: string; conclusion?: string
  steps?: { number: number; name: string; status: string; conclusion: string | null }[]
}
interface WorkflowRunPage {
  total_count?: number
  workflow_runs: { id: number; display_title: string; status: string; head_sha: string }[]
}
type CliRunPage = (path: string, timeoutMs: number) => Promise<string>
const failedRead = (action: string) => (detail: string) => `GitHub Actions did not accept gh run ${action}: ${detail}`

export class GitHubRest {
  constructor(private readonly http: CloudHttp) {}

  get transport() { return this.http.transport }

  list(mirror: string, branch: string, limit: number, cliPage?: CliRunPage) {
    return this.http.operation(15_000, () => this.listRuns(mirror, branch, limit, cliPage))
  }

  private async listRuns(mirror: string, branch: string, limit: number, cliPage?: CliRunPage): Promise<string | null> {
    const runs: WorkflowRunPage['workflow_runs'] = []
    const deadline = Date.now() + 15_000
    let complete = false
    let total = 0
    for (let page = 1; page <= Math.ceil(limit / 100); page++) {
      const path = `/repos/${mirror}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}`
        + `&event=workflow_dispatch&per_page=100&page=${page}`
      const result = await this.runPage(path, deadline, cliPage)
      if (result === undefined) return null
      if (!result || !Array.isArray(result.workflow_runs)
        || limit > 200 && (!Number.isSafeInteger(result.total_count) || result.total_count! < 0)) {
        throw new DomainError('CI_CLOUD_DISCOVERY_INCOMPLETE',
          'GitHub Actions discovery has no valid inventory totals; ownership retained.', 503)
      }
      const batch = result.workflow_runs
      total = Math.max(total, result.total_count ?? 0)
      runs.push(...batch)
      if (batch.length < 100) {
        complete = true
        break
      }
    }
    // GitHub caps filtered searches at 1,000 runs. Moving pages can also repeat IDs and omit older runs.
    const unique = new Set(runs.map(run => run.id)).size
    if (limit > 200 && (!complete || unique !== runs.length || unique !== total)) {
      throw new DomainError('CI_CLOUD_DISCOVERY_INCOMPLETE',
        'GitHub Actions discovery is incomplete; ownership retained.', 503)
    }
    return JSON.stringify(runs.map(value => ({ databaseId: value.id, displayTitle: value.display_title,
      status: value.status, headSha: value.head_sha })))
  }

  private async runPage(path: string, deadline: number, cliPage?: CliRunPage): Promise<WorkflowRunPage | undefined> {
    const response = await this.http.request(path, { timeoutMs: 15_000 })
    if (response) {
      await this.http.check(response, failedRead('list'))
      return this.http.json<WorkflowRunPage>(response)
    }
    if (!cliPage) return undefined
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new DomainError('CI_CLOUD_DISCOVERY_INCOMPLETE',
        'GitHub Actions discovery exceeded its time limit; ownership retained.', 503)
    }
    return JSON.parse(await cliPage(path, remaining)) as WorkflowRunPage
  }

  async view(mirror: string, id: string) {
    const response = await this.http.request(`/repos/${mirror}/actions/runs/${id}`)
    if (!response) return null
    await this.http.check(response, failedRead('view'))
    const view = await this.http.json<{ status: string; conclusion: string; updated_at: string }>(response)
    return JSON.stringify({ status: view.status, conclusion: view.conclusion, updatedAt: view.updated_at })
  }

  readJobs(response: Response) { return this.http.json<{ jobs: Job[] }>(response) }

  async jobs(mirror: string, id: string, etag?: string) {
    const response = await this.http.request(`/repos/${mirror}/actions/runs/${id}/jobs?per_page=100`, {
      timeoutMs: 15_000, ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
    })
    if (!response) return null
    await this.http.check(response, detail => `GitHub Actions did not return the run's jobs: ${detail}`)
    return response
  }

  async artifacts(mirror: string, id: string, directory: string): Promise<boolean | null> {
    try {
      return await this.http.operation(120_000, () => this.downloadArtifacts(mirror, id, directory))
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CI_CLOUD_RATE_LIMITED') throw error
      throw new DomainError('CI_CLOUD_FAILED', 'GitHub Actions artifacts could not be downloaded.', 502, undefined, { cause: error })
    }
  }

  private async downloadArtifacts(mirror: string, id: string, directory: string): Promise<boolean | null> {
    let page = 1
    const artifacts: { id: number; name: string; expired: boolean }[] = []
    for (;;) {
      const response = await this.http.request(`/repos/${mirror}/actions/runs/${id}/artifacts?per_page=100&page=${page}`)
      if (!response) return null
      await this.http.check(response, () => 'GitHub Actions artifacts could not be downloaded.')
      const batch = (await this.http.json<{ artifacts: typeof artifacts }>(response)).artifacts
      artifacts.push(...batch.filter(value => value.name === 'durations' && !value.expired))
      if (batch.length < 100) break
      page++
    }
    if (!artifacts.length) return false
    await mkdir(directory, { recursive: true })
    for (const artifact of artifacts.slice(0, 1)) {
      const response = await this.http.request(`/repos/${mirror}/actions/artifacts/${artifact.id}/zip`)
      if (!response) return null
      const bytes = await this.http.download(response, 120_000)
      const budget = new Budget()
      for (const entry of parseZip(bytes, budget).filter(entry => entry.kind === 'file')) {
        const path = join(directory, entry.name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, await decodeEntry(bytes, entry, budget))
      }
    }
    return true
  }

  log(mirror: string, id: string) {
    return this.http.operation(300_000, () => this.readLog(mirror, id))
  }

  private async readLog(mirror: string, id: string): Promise<string | null> {
    const jobsResponse = await this.jobs(mirror, id)
    if (!jobsResponse) return null
    const jobs = (await this.http.json<{ jobs: Job[] }>(jobsResponse)).jobs
    let page = 2
    let batchSize = jobs.length
    while (batchSize === 100) {
      const pageResponse = await this.http.request(
        `/repos/${mirror}/actions/runs/${id}/jobs?per_page=100&page=${page++}`, { timeoutMs: 15_000 })
      if (!pageResponse) return null
      await this.http.check(pageResponse, failedRead('view'))
      const batch = (await this.http.json<{ jobs: Job[] }>(pageResponse)).jobs
      jobs.push(...batch)
      batchSize = batch.length
    }
    const response = await this.http.request(`/repos/${mirror}/actions/runs/${id}/logs`, { timeoutMs: 300_000 })
    if (!response) return null
    const bytes = await this.http.download(response, 300_000)
    const budget = new Budget()
    const entries = parseZip(bytes, budget).filter(entry => entry.kind === 'file')
    let text = ''
    let missing = 0
    for (const job of jobs) {
      if (job.conclusion === 'skipped') continue
      const folder = job.name.replaceAll('/', '').replaceAll(':', '').slice(0, 90)
      const stepEntries = (job.steps ?? []).map(step => ({ step, entry: entries.find(entry =>
        dirname(entry.name) === folder && basename(entry.name).startsWith(`${step.number}_`)) }))
      if (!stepEntries.some(value => value.entry)) {
        const entry = entries.find(entry => dirname(entry.name) === '.'
          && /^-?\d+_/.test(entry.name) && entry.name.replace(/^-?\d+_/, '') === `${folder}.txt`)
        let output: string
        if (entry) output = (await decodeEntry(bytes, entry, budget)).toString('utf8')
        else {
          logIgnoredError('jobs', 'read GitHub job log', new DomainError('CI_LOG_ARCHIVE_INCOMPLETE',
            'The archive has no log for this job; requesting its log separately.', 502), { jobId: job.id })
          if (++missing > 25) {
            throw new DomainError('CI_CLOUD_FAILED', 'GitHub Actions did not accept gh run view: '
              + 'too many API requests needed to fetch logs; try narrowing down to a specific job with the `--job` option', 502)
          }
          const jobLog = await this.http.request(`/repos/${mirror}/actions/jobs/${job.id}/logs`, { timeoutMs: 300_000 })
          if (!jobLog) return null
          output = (await this.http.download(jobLog, 300_000)).toString('utf8')
        }
        text += prefixLog(output, job.name, 'UNKNOWN STEP')
        continue
      }
      for (const { step, entry } of stepEntries.sort((left, right) => left.step.number - right.step.number)) {
        if (!entry) {
          if (step.conclusion === 'skipped') continue
          logIgnoredError('jobs', 'read GitHub step log', new DomainError('CI_STEP_LOG_UNAVAILABLE',
            'The archive has no log for this step.', 502), { jobId: job.id, step: step.number })
          text += `[Log unavailable: ${job.name} / ${step.name}]\n`
          continue
        }
        const output = (await decodeEntry(bytes, entry, budget)).toString('utf8')
        text += prefixLog(output, job.name, step.name)
      }
    }
    return text
  }
}

function prefixLog(output: string, job: string, step: string) {
  const lines = output.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines.map(line => `${job}\t${step}\t${line}\n`).join('')
}
