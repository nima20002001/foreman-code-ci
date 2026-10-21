import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const { downloadBrowserRuntimeArtifact }: {
  downloadBrowserRuntimeArtifact(url: string, destination: string, expected?: string): Promise<{ sha256: string; size: number }>
} = await import(new URL('../../../scripts/browser-runtime-install.mjs', import.meta.url).href)

it('refuses to download executable browser bytes without an expected checksum', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'browser-download-'))
  try {
    const downloading = downloadBrowserRuntimeArtifact(
      'https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip', join(directory, 'archive.zip'))
      .then(result => {
        console.info('Unverified upstream archive identity:', result)
        return result
      })
    await expect(downloading).rejects.toThrow('expected artifact digest required')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('verifies the pinned Chromium archive bytes before they can be extracted', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'browser-pinned-download-'))
  const digest = '8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a'
  const url = 'https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip'
  try {
    expect(await downloadBrowserRuntimeArtifact(url, join(directory, 'verified.zip'), digest))
      .toMatchObject({ sha256: digest, size: 195836009 })
    await expect(downloadBrowserRuntimeArtifact(url, join(directory, 'rejected.zip'), '0'.repeat(64)))
      .rejects.toThrow('upstream artifact checksum mismatch')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
