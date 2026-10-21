import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { captureGitSource } from '../src/modules/sources/capture.js'
import { GitHubSourcePublisher } from '../src/modules/sources/githubPublisher.js'
import { openGitHubSource } from '../src/modules/sources/githubSource.js'
import { addGitWorktree, systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { remoteReviewEnvironment } from './helpers/remoteReviewEnvironment.js'
import { configureRemoteReviewGitHub } from './helpers/remoteReviewGitHub.js'

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await privateFixtureDirectory('remote-review-github-')
  directories.push(directory)
  const project = join(directory, 'project')
  await mkdir(project, { mode: 0o700 })
  const git = async (cwd: string, ...args: string[]) =>
    (await execute('git', args, { cwd, env: gitFixtureEnvironment() })).stdout.trim()
  await git(project, 'init', '--quiet', '--template=', '--initial-branch=main')
  await writeFile(join(project, 'README.md'), 'approved source\n', { mode: 0o600 })
  await git(project, 'add', 'README.md')
  await git(project, 'commit', '--quiet', '-m', 'Source fixture')
  const commit = await git(project, 'rev-parse', 'HEAD')
  const repository = `remote-review-fixture/${randomUUID()}`
  const origin = join(directory, 'github.git')
  const launcher = join(directory, 'app-mcp', 'launcher.mjs')
  const mainEnvironment = remoteReviewEnvironment(join(directory, 'main-home'), directory, launcher)
  const workerEnvironment = remoteReviewEnvironment(join(directory, 'worker-home'), directory, launcher)
  await configureRemoteReviewGitHub({ project, origin, repository,
    homes: [mainEnvironment.HOME!, workerEnvironment.HOME!] })
  const main = systemGitWorktreePorts(mainEnvironment)
  const worker = systemGitWorktreePorts(workerEnvironment)
  return { directory, project, commit, repository, origin, git, main, worker }
}

async function approve(project: string, repository: string, commit: string) {
  const manifest = await captureGitSource({ root: project, repository, commit, approvedSourceId: randomUUID(),
    executablePolicy: 'strip', sink: {
      async write() {},
      async writeGitMetadata() {},
      async commit() {},
      async abort() {},
    } })
  const pin = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  return { manifest, pin }
}

it('fetches approved GitHub source in an empty Worker cache independently of Main', async () => {
  const f = await fixture()
  const { manifest, pin } = await approve(f.project, f.repository, f.commit)
  const signal = AbortSignal.timeout(30_000)
  const reference = await new GitHubSourcePublisher(f.main).publish(manifest, signal)
  // Main's clone is unavailable, so the Worker must obtain its objects from the offline GitHub remote.
  await rm(f.main.cloneDirectory(f.repository), { recursive: true, force: true })
  const opened = await openGitHubSource(f.worker, reference, pin, signal)
  expect(opened.manifest).toEqual(manifest)
  expect(Buffer.from(await opened.reader.read(pin, manifest.entries[0]!, signal)).toString()).toBe('approved source\n')
  expect(await f.git(f.worker.cloneDirectory(f.repository), 'config', '--get', 'remote.origin.url'))
    .toBe(`https://github.com/${f.repository}.git`)
})

it('publishes an unpublished Main commit and fetches it into the existing Worker cache with pin validation', async () => {
  const f = await fixture()
  const publisher = new GitHubSourcePublisher(f.main)
  const signal = AbortSignal.timeout(30_000)
  const original = await approve(f.project, f.repository, f.commit)
  const reference = await publisher.publish(original.manifest, signal)
  await openGitHubSource(f.worker, reference, original.pin, signal)
  const worktree = join(f.directory, 'agent')
  await addGitWorktree(f.main, { repository: f.repository, branch: 'foreman/review/fixture' }, f.commit, worktree, signal)
  await writeFile(join(worktree, 'README.md'), 'review source\n')
  await f.git(worktree, 'commit', '--quiet', '-am', 'Reviewed source')
  const commit = await f.git(worktree, 'rev-parse', 'HEAD')
  const reviewed = await approve(worktree, f.repository, commit)
  const published = await publisher.publish(reviewed.manifest, signal)
  expect(await f.git(f.origin, 'rev-parse', `refs/heads/foreman/ci/${commit}`)).toBe(commit)
  const opened = await openGitHubSource(f.worker, published, reviewed.pin, signal)
  expect(opened.manifest).toEqual(reviewed.manifest)
  expect(Buffer.from(await opened.reader.read(reviewed.pin, reviewed.manifest.entries[0]!, signal)).toString())
    .toBe('review source\n')
  await expect(openGitHubSource(f.worker, published, original.pin, signal))
    .rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
})
