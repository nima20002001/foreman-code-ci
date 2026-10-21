import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { GitHubLoginStateSchema, type GitHubLoginRequest, type GitHubLoginState } from '@foreman-code/contracts/computer-accounts'
import { DomainError } from '../errors.js'
import { probeGitHubAccount, systemPorts, type AccountProbePorts } from './accountProbe.js'

/** GitHub device codes expire after 15 minutes; the CLI keeps polling until then. */
const LOGIN_LIFETIME_MS = 15 * 60_000
const CODE_WAIT_MS = 20_000

export interface GitHubLoginPorts {
  probe: AccountProbePorts
  spawn(binary: string, args: string[]): Pick<ChildProcess, 'stdout' | 'stderr' | 'stdin' | 'once' | 'kill'>
  now(): number
}

interface Session {
  id: string
  child: Pick<ChildProcess, 'kill'>
  state: GitHubLoginState
}

/** One GitHub CLI sign-in at a time on this computer: start returns the device code, status follows the CLI to completion. */
export class GitHubLoginRunner {
  private generation = 0
  private closed = false
  private session: Session | undefined
  private pendingLogout: Promise<GitHubLoginState> | undefined
  constructor(private readonly ports: GitHubLoginPorts = systemGitHubPorts()) {}

  async handle(request: GitHubLoginRequest): Promise<GitHubLoginState> {
    if (this.closed) throw new DomainError('GITHUB_LOGIN_CANCELLED', 'GitHub sign-in is closed.', 409)
    if (request.operation === 'login-start') {
      const generation = ++this.generation
      // The logout caller receives any failure; a later sign-in still replaces that account.
      if (this.pendingLogout) await Promise.allSettled([this.pendingLogout])
      return this.start(generation)
    }
    if (request.operation === 'logout') return this.orderedLogout(request.expectedAccount)
    if (request.operation === 'setup-git') return this.setupGit(request.loginId)
    return this.status(request.loginId)
  }

  private async orderedLogout(expectedAccount: string | null): Promise<GitHubLoginState> {
    ++this.generation
    this.session?.child.kill('SIGTERM')
    this.session = undefined
    const previous = this.pendingLogout
    const pending = (async () => {
      if (previous) await Promise.allSettled([previous])
      return this.logout(expectedAccount)
    })()
    this.pendingLogout = pending
    try { return await pending } finally {
      if (this.pendingLogout === pending) this.pendingLogout = undefined
    }
  }

  private async start(generation: number): Promise<GitHubLoginState> {
    const gh = await this.ports.probe.find('gh')
    if (this.closed || generation !== this.generation) {
      throw new DomainError('GITHUB_LOGIN_CANCELLED', 'A later request cancelled this GitHub sign-in.', 409)
    }
    if (!gh) throw new DomainError('GITHUB_CLI_MISSING', 'Install the GitHub CLI (gh) on this computer first.', 409)
    this.session?.child.kill('SIGTERM')
    const id = randomUUID()
    const child = this.ports.spawn(gh, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'])
    const expiresAt = new Date(this.ports.now() + LOGIN_LIFETIME_MS).toISOString()
    const session: Session = { id, child, state: { loginId: id, state: 'waiting', code: null, verificationUrl: null,
      expiresAt, account: null, message: null } }
    this.session = session
    const timer = setTimeout(() => {
      if (session.state.state !== 'waiting') return
      session.state = { ...session.state, state: 'expired', message: 'The one-time code expired. Start again.' }
      child.kill('SIGTERM')
    }, LOGIN_LIFETIME_MS)
    timer.unref?.()
    const shown = new Promise<void>((resolve, reject) => {
      let output = ''
      const read = (chunk: Buffer | string) => {
        output = (output + chunk.toString()).slice(-8192)
        const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/u.exec(output)?.[1]
        const url = /(https:\/\/github\.com\/login\/device)/u.exec(output)?.[1]
        if (code && !session.state.code) session.state = { ...session.state, code, verificationUrl: url ?? 'https://github.com/login/device' }
        if (session.state.code) resolve()
      }
      child.stdout?.on('data', read)
      child.stderr?.on('data', read)
      child.once('error', reject)
      child.once('exit', code => {
        clearTimeout(timer)
        if (!session.state.code) reject(new DomainError('GITHUB_LOGIN_FAILED', 'The GitHub CLI did not offer a one-time code.', 502))
        void this.finish(session, code)
      })
      setTimeout(() => reject(new DomainError('GITHUB_LOGIN_FAILED', 'The GitHub CLI did not offer a one-time code in time.', 504)),
        CODE_WAIT_MS).unref?.()
    })
    // The CLI waits for Enter before polling; there is no browser to open here.
    child.stdin?.end('\n')
    try { await shown } catch (error) {
      child.kill('SIGTERM')
      if (this.session === session) this.session = undefined
      throw error
    }
    return GitHubLoginStateSchema.parse(session.state)
  }

  private async finish(session: Session, code: number | null) {
    if (session.state.state !== 'waiting') return
    if (code !== 0) {
      session.state = { ...session.state, state: 'failed', message: 'GitHub sign-in did not complete.' }
      return
    }
    try {
      const account = await probeGitHubAccount(this.ports.probe)
      session.state = { ...session.state, state: account.signedIn ? 'waiting' : 'failed', account: account.account,
        code: null, verificationUrl: null, message: account.signedIn ? null : 'GitHub sign-in could not be verified.' }
      if (account.signedIn) await this.configureGit(session)
    } catch {
      session.state = { ...session.state, state: 'failed', code: null, message: 'GitHub sign-in could not be verified.' }
    }
  }

  private async setupGit(loginId: string): Promise<GitHubLoginState> {
    this.status(loginId)
    const session = this.session!
    if (!['signed-in', 'git-setup-failed'].includes(session.state.state)) {
      throw new DomainError('GITHUB_SETUP_NOT_READY', 'Finish GitHub sign-in before setting up Git.', 409)
    }
    await this.configureGit(session)
    return GitHubLoginStateSchema.parse(session.state)
  }

  private async configureGit(session: Session) {
    try {
      const gh = await this.ports.probe.find('gh')
      if (!gh) throw new Error('GitHub CLI unavailable')
      const result = await this.ports.probe.run(gh, ['auth', 'setup-git', '--hostname', 'github.com'], AbortSignal.timeout(15_000))
      if (result.code !== 0) throw new Error('Git credential setup failed')
      session.state = { ...session.state, state: 'signed-in', message: null }
    } catch {
      session.state = { ...session.state, state: 'git-setup-failed', message: 'Signed in, but Git setup failed. Retry Git setup.' }
    }
  }

  private status(loginId: string): GitHubLoginState {
    if (this.session?.id !== loginId) throw new DomainError('GITHUB_LOGIN_NOT_FOUND', 'This sign-in is no longer active on the computer.', 404)
    return GitHubLoginStateSchema.parse(this.session.state)
  }

  private async logout(expectedAccount: string | null): Promise<GitHubLoginState> {
    const gh = await this.ports.probe.find('gh')
    if (!gh) throw new DomainError('GITHUB_CLI_MISSING', 'The GitHub CLI (gh) is not installed on this computer.', 409)
    const account = await probeGitHubAccount(this.ports.probe)
    if (account.signedIn === null && !account.account) {
      throw new DomainError('GITHUB_STATUS_UNKNOWN', 'GitHub account state could not be checked. Try again before signing out.', 502)
    }
    if (account.account !== expectedAccount) {
      throw new DomainError('GITHUB_ACCOUNT_CHANGED',
        'The active GitHub account changed. Read account status before requesting another sign-out.', 409)
    }
    if (account.account) {
      const result = await this.ports.probe.run(gh, ['auth', 'logout', '--hostname', 'github.com', '--user', account.account],
        AbortSignal.timeout(15_000))
      if (result.code !== 0) throw new DomainError('GITHUB_LOGOUT_FAILED', 'The GitHub CLI could not sign out.', 502)
    }
    const checked = await probeGitHubAccount(this.ports.probe)
    if (checked.signedIn === null) {
      throw new DomainError('GITHUB_STATUS_UNKNOWN', 'Sign-out could not be verified. Check GitHub account state and try again.', 502)
    }
    if (checked.signedIn) {
      if (checked.account === account.account) {
        throw new DomainError('GITHUB_LOGOUT_FAILED', 'The GitHub credentials are still present on this computer.', 502)
      }
      return GitHubLoginStateSchema.parse({ loginId: null, state: 'signed-in', code: null, verificationUrl: null,
        expiresAt: null, account: checked.account, message: 'The previous account was removed; another GitHub account is active.' })
    }
    return GitHubLoginStateSchema.parse({ loginId: null, state: 'signed-out', code: null, verificationUrl: null,
      expiresAt: null, account: null, message: null })
  }

  close() {
    this.closed = true
    ++this.generation
    this.session?.child.kill('SIGTERM')
    this.session = undefined
  }
}

export function systemGitHubPorts(environment: NodeJS.ProcessEnv = process.env): GitHubLoginPorts {
  return {
    probe: systemPorts(environment),
    spawn: (binary, args) => spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment, BROWSER: 'false', NO_COLOR: '1' } }),
    now: Date.now,
  }
}
