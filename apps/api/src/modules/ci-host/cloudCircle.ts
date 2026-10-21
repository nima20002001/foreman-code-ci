import { writeFile } from 'node:fs/promises'
import { DomainError } from '../errors.js'
import { CloudHttp } from './cloudHttp.js'
import { circleJobLog, renderTerminal } from './cloudLog.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { isCircleCreditRefusal } from './circleCreditRefusal.js'

interface Workflow { id: string; status: string; stopped_at?: string }
interface JobRef { id: string; job_number?: number; status?: string }
interface Pipeline {
  state?: string; errors?: { type: string; message: string }[]
  created_at?: string; updated_at?: string; project_slug?: string
}
export interface CircleStep {
  num: number; name: string; phase: string; outcome?: string
  started_at?: string; ended_at?: string; exit_code?: number; command?: string
}
export interface CircleJob {
  name: string; phase: string; outcome?: string; ended_at?: string
  parallel_executions?: { steps?: CircleStep[] }[]
}

function lifecycle(status: string) {
  const terminal = ['success', 'failed', 'error', 'canceled', 'unauthorized', 'not_run', 'skipped',
    'infrastructure_fail', 'timedout']
  const outcomes: Record<string, string> = { success: 'succeeded', failed: 'failed', error: 'errored' }
  // A failing workflow is still running and can produce additional output.
  const phase = terminal.includes(status) ? 'ended' : 'started'
  return { phase, ...(phase === 'ended' ? { outcome: outcomes[status] ?? status } : {}) }
}

export class CircleRest {
  constructor(private readonly http: CloudHttp) {}

  get transport() { return this.http.transport }

  available() { return this.http.available() }

  private async read(path: string, args: string[], timeoutMs: number) {
    const response = await this.http.request(path, { timeoutMs })
    if (!response) return null
    if (response.status === 404 && args[0] === 'run' && args[1] === 'get') {
      await response.body?.cancel()
      const resource = path === `/api/v2/pipeline/${args[2]}` ? 'pipeline' : 'child'
      throw new DomainError('CI_CLOUD_RUN_NOT_FOUND', 'CircleCI run is not visible.', 502, { resource })
    }
    const lookupDenied = args[1] === 'get' && (args[0] === 'run' || args[0] === 'job')
      && (response.status === 401 || response.status === 403)
    try {
      await this.http.check(response, detail => lookupDenied
        ? `CircleCI execution is not readable: ${detail}`
        : `CircleCI did not accept circleci ${args[0]} ${args[1]}: ${detail}`)
    } catch (error) {
      if (lookupDenied && error instanceof DomainError && error.code === 'CI_CLOUD_FAILED') {
        throw new DomainError('CI_CLOUD_RUN_UNREADABLE', error.message, error.status, undefined, { cause: error })
      }
      throw error
    }
    return response
  }

  private async list<T>(path: string, args: string[], timeoutMs: number): Promise<T[] | null> {
    const result: T[] = []
    let page: string | null = null
    do {
      const response = await this.read(path + (page ? `?page-token=${encodeURIComponent(page)}` : ''), args, timeoutMs)
      if (!response) return null
      const body = await this.http.json<{ items: T[]; next_page_token?: string | null }>(response)
      result.push(...body.items)
      page = body.next_page_token ?? null
    } while (page)
    return result
  }

  private async pipeline(id: string, args: string[], timeoutMs: number) {
    const response = await this.read(`/api/v2/pipeline/${id}`, args, timeoutMs)
    if (!response) return null
    const pipeline = await this.http.json<Pipeline>(response)
    if (pipeline.state === 'errored' && pipeline.errors?.length) {
      return { state: pipeline.state, created_at: pipeline.created_at, stopped_at: pipeline.updated_at,
        phase: 'ended', current_outcome: 'not_run', notStarted: true, errors: pipeline.errors, workflows: [] }
    }
    const workflows = await this.list<Workflow>(`/api/v2/pipeline/${id}/workflow`, args, timeoutMs)
    if (!workflows) return null
    const mapped = await Promise.all(workflows.map(async workflow => {
      let jobsUnavailable = false
      const jobs = await this.list<JobRef>(`/api/v2/workflow/${workflow.id}/job`, args, timeoutMs).catch(error => {
        // A workflow can be visible before CircleCI serves its jobs; the pipeline still exists.
        if (error instanceof DomainError && error.code === 'CI_CLOUD_RUN_NOT_FOUND') {
          jobsUnavailable = true
          return []
        }
        throw error
      })
      if (!jobs) return null
      const errors = await this.creditErrors(pipeline.project_slug, jobs, args, timeoutMs)
      return { ...lifecycle(workflow.status), stopped_at: workflow.stopped_at, jobs, jobsUnavailable, errors }
    }))
    if (mapped.some(workflow => workflow === null)) return null
    const complete = workflows.length > 0 && workflows.every(workflow => lifecycle(workflow.status).phase === 'ended')
    const noJobs = mapped.every(workflow => workflow && !workflow.jobsUnavailable && !workflow.jobs.length)
    const notStarted = noJobs && (complete
      || !workflows.length && (pipeline.state === 'created' || pipeline.state === 'errored'))
    return { state: pipeline.state, created_at: pipeline.created_at,
      phase: complete || notStarted ? 'ended' : 'started',
      errors: [...pipeline.errors ?? [], ...mapped.flatMap(workflow => workflow!.errors)], workflows: mapped,
      ...(notStarted ? { notStarted: true, current_outcome: 'not_run', stopped_at: pipeline.updated_at } : {}) }
  }

  private async creditErrors(project: string | undefined, jobs: JobRef[], args: string[], timeoutMs: number) {
    const errors: { type: string; message: string }[] = []
    if (!project) return errors
    for (const job of jobs) {
      if (job.status !== 'not_run' || job.job_number === undefined) continue
      const response = await this.read(`/api/v1.1/project/${project}/${job.job_number}`, args, timeoutMs)
      if (!response) continue
      const detail = await this.http.json<{ messages?: { type: string; message: string }[] }>(response)
      errors.push(...(detail.messages ?? []).filter(isCircleCreditRefusal))
    }
    return errors
  }

  private async job(id: string, args: string[], timeoutMs: number): Promise<CircleJob | null> {
    const response = await this.read(`/api/v3/jobs/${id}`, args, timeoutMs)
    if (!response) return null
    return (await this.http.json<{ data: { attributes: CircleJob } }>(response)).data.attributes
  }

  command(args: string[], timeoutMs: number) {
    return this.http.operation(timeoutMs, () => this.readCommand(args, timeoutMs))
  }

  private async readCommand(args: string[], timeoutMs: number): Promise<string | null> {
    if (args[0] === 'api') {
      const response = await this.read(`/${args[1]!}`, args, timeoutMs)
      return response ? response.text() : null
    }
    if (args[0] === 'run' && args[1] === 'get') {
      const pipeline = await this.pipeline(args[2]!, args, timeoutMs)
      return pipeline ? JSON.stringify(pipeline) : null
    }
    if (args[0] !== 'job') return null
    if (args[1] === 'get') {
      const job = await this.job(args[2]!, args, timeoutMs)
      return job ? JSON.stringify({ ...job, stopped_at: job.ended_at,
        executions: job.parallel_executions ?? [] }) : null
    }
    if (args[1] === 'output' && args[2] === 'get') {
      const executionIndex = args.indexOf('--execution')
      const output = await this.stepOutput(args[3]!, Number(args[args.indexOf('--step-num') + 1]), timeoutMs, {
        execution: executionIndex === -1 ? 0 : Number(args[executionIndex + 1]),
        raw: args.includes('--strip-ansi=false'),
      })
      return output?.text ?? null
    }
    if (args[1] === 'output' && args[2] === 'list') {
      const id = args[3]!
      const job = await this.job(id, args, timeoutMs)
      if (!job) return null
      const steps = job.parallel_executions?.[0]?.steps ?? []
      const output: string[] = []
      // Keep the CLI's bounded fan-out for large jobs.
      for (let index = 0; index < steps.length; index += 4) {
        const batch = await Promise.all(steps.slice(index, index + 4).map(step =>
          this.stepOutput(id, step.num, timeoutMs, { allowMissing: true })))
        if (batch.some(value => value === null)) return null
        output.push(...batch.map(value => value!.text))
      }
      return circleJobLog(id, job, steps, output)
    }
    return null
  }

  private async stepOutput(id: string, step: number, timeoutMs: number,
    options: { allowMissing?: boolean; execution?: number; raw?: boolean } = {}) {
    const execution = options.execution ?? 0
    const responses = await Promise.all(['stdout', 'stderr'].map(stream =>
      this.http.request(`/api/v3/jobs/${id}/${stream}?filter%5Bexecution%5D=${execution}&filter%5Bstep_num%5D=${step}`,
        { timeoutMs })))
    if (responses.some(response => response === null)) return null
    let text = ''
    for (const response of responses) {
      if (response!.status === 404 && options.allowMissing) {
        await response!.body?.cancel()
        continue
      }
      await this.http.check(response!, detail => `CircleCI did not accept circleci job output: ${detail}`)
      const stream = await response!.text()
      text += options.raw ? stream : renderTerminal(stream)
    }
    return { ok: true, text }
  }

  async output(id: string, step: number, timeoutMs: number): Promise<{ ok: boolean; text: string } | null> {
    try {
      return await this.http.operation(timeoutMs, () => this.stepOutput(id, step, timeoutMs))
    } catch (error) {
      // Live output is best-effort, matching the CLI path; rate limits still pause polling.
      if (error instanceof DomainError && error.code === 'CI_CLOUD_FAILED') {
        logIgnoredError('jobs', 'read CircleCI live output', error, { jobId: id, step })
        return { ok: false, text: '' }
      }
      throw error
    }
  }

  async artifacts(id: string): Promise<string | null> {
    const artifacts = await this.http.operation(60_000, async () => {
      const response = await this.read(`/api/v3/jobs/${id}/artifacts`, ['job', 'artifact'], 60_000)
      if (!response) return null
      return (await this.http.json<{ data: { attributes: { path: string; url: string } }[] }>(response))
        .data.map(item => item.attributes)
    })
    return artifacts ? JSON.stringify(artifacts) : null
  }

  async download(url: string, path: string) {
    if (!await this.http.available()) return false
    await writeFile(path, await this.http.downloadUrl(url, 60_000))
    return true
  }
}
