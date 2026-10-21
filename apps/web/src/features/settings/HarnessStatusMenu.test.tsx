import { vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { HarnessStatusMenu } from './HarnessStatusMenu'
import { useNavigationUiStore } from '../workspaces/navigationUiStore'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
import { computerSettingsKeys } from '../../shared/api/computerSettings'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import harnessStyles from './harnessStatusMenu.css?inline'
import shellStyles from '../../styles.css?inline'
import tokenStyles from '../../shared/ui/nocturne/tokens.css?inline'

const mainId = mockRuntimeIdentity.installationId
const host = { kind: 'main', mainId } as const
const inventoryKey = () => computerSettingsKeys.inventory(host, mainId)
function inventory(installed = true) {
  return HarnessRegistryReadbackSchema.parse({
    instances: [],
    installations: ['codex', 'claude'].map(driverId => ({
      hostRef: host, driverId, driverRevision: '1', protocolRevision: 'native',
      harnessInstallationId: `${driverId}-installation`, installationFingerprint: 'payload',
      environmentGeneration: 'environment', connectionGeneration: 'connection',
      observedVersion: null, installed, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: driverId, resolvedLauncher: installed ? `/recorded/${driverId}` : null,
        fingerprint: 'payload', status: installed ? 'installed' : 'missing', interpreter: null, diagnostics: [],
        environment: { generation: 'environment', provenance: 'terminal', cwd: '/recorded', path: '/recorded' },
        checkedAt: '2026-10-09T00:00:00.000Z' },
    })),
    hostMetadata: { hostRef: host, applicationInstallationId: mainId, connection: null,
      platform: null, workspaceRoots: null },
  })
}

function rgbChannels(color: string) {
  const channels = color.match(/\d+(?:\.\d+)?/g)?.map(Number)
  if (!color.startsWith('rgb(') || channels?.length !== 3) throw new Error(`Expected an RGB color: ${color}`)
  return channels
}

function luminance(channels: number[]) {
  const linear = channels.map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function contrastRatio(foreground: string, background: string, opacity: number) {
  const backdrop = rgbChannels(background)
  const blended = rgbChannels(foreground).map((channel, index) =>
    channel * opacity + backdrop[index]! * (1 - opacity))
  const first = luminance(blended)
  const second = luminance(backdrop)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

// jsdom exposes theme properties but does not resolve inherited var() colors.
function resolveThemeVariables(styles: string): string {
  const theme = getComputedStyle(document.documentElement)
  return styles.replace(/var\((--[\w-]+)\)/g, (reference, name: string) => {
    const value = theme.getPropertyValue(name).trim()
    return value ? resolveThemeVariables(value) : reference
  })
}

/** The hover card opened by focusing a harness icon names its status in words. */
async function expectDetails(button: HTMLElement, detail: RegExp) {
  act(() => button.focus())
  await waitFor(() => expect(button).toHaveAccessibleDescription(detail))
}

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')

function mockRelocation() {
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel }))
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLButtonElement) {
    const index = Array.from(this.parentElement!.children).indexOf(this)
    const { collapsed, width } = useNavigationUiStore.getState()
    return new DOMRect(collapsed ? 0 : 10 + index * width / 3, collapsed ? index * 34 : 0, 40, 32)
  })
  return { animate, cancel }
}

describe('HarnessStatusMenu', () => {
  afterEach(() => {
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  })
  it.each(['dark', 'light'].flatMap(theme =>
    (['installed', 'missing', 'unverified'] as const).map(state => ({ theme, state }))))(
    'keeps actionable harness marks above 3:1 contrast in $theme with $state inventory', async ({ theme, state }) => {
      const previousTheme = document.documentElement.getAttribute('data-theme')
      document.documentElement.setAttribute('data-theme', theme)
      server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json(
        state === 'unverified' ? { instances: [], installations: [] } : inventory(state === 'installed'),
      )))
      try {
        const { container } = renderWithRouter(<>
          <style>{tokenStyles}{shellStyles}{harnessStyles}</style>
          <aside className="shell-sidebar" aria-label="Sidebar"><HarnessStatusMenu /></aside>
        </>)
        const label = { installed: 'Installed', missing: 'Not installed', unverified: 'Unverified' }[state]
        const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' })
        container.querySelector('style')!.textContent = resolveThemeVariables(tokenStyles + shellStyles + harnessStyles)
        const background = getComputedStyle(sidebar).backgroundColor
        for (const name of ['Codex', 'Claude']) {
          const button = await screen.findByRole('button', { name: `${name}: ${label}` })
          expect(button).toBeEnabled()
          const mark = button.querySelector('svg')!
          const style = getComputedStyle(mark)
          const opacity = Number(style.opacity) * Number(getComputedStyle(button).opacity)
          expect(contrastRatio(style.color, background, opacity)).toBeGreaterThanOrEqual(3)
        }
      } finally {
        if (previousTheme === null) document.documentElement.removeAttribute('data-theme')
        else document.documentElement.setAttribute('data-theme', previousTheme)
      }
    },
  )
  it.each([
    [true, 'Installed', 'installed'], [false, 'Not installed', 'missing'],
  ] as const)('shows installed=%s from inventory with an accessible status and matching light', async (installed, label, state) => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json(inventory(installed))))
    renderWithRouter(<HarnessStatusMenu />)
    for (const name of ['Codex', 'Claude']) {
      const link = await screen.findByRole('button', { name: `${name}: ${label}` })
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      fireEvent.click(link, { ctrlKey: true })
      expect(open).toHaveBeenCalledExactlyOnceWith(
        `/settings/harnesses?harness=${name.toLowerCase()}&section=model`, '_blank', 'noopener',
      )
      open.mockRestore()
      expect(link.querySelector('.harness-status-light')).toHaveClass(`harness-status-light--${state}`)
      await expectDetails(link, new RegExp(`${name}.*${label}`))
      // Descriptions include hidden content before the native popover opens.
      const help = await screen.findByRole('button', { name: `About ${name} harness` })
      expect(screen.queryByText('Sign-in and profile qualification are checked separately before execution.')).not.toBeInTheDocument()
      act(() => help.focus())
      expect(help).toHaveAccessibleDescription('Sign-in and profile qualification are checked separately before execution.')
      fireEvent.keyDown(help, { key: 'Escape' })
      expect(help).not.toHaveAttribute('aria-describedby')
      act(() => help.blur())
      act(() => link.blur())
    }
  })

  it('recognizes installed harnesses without slow or failed preset and Operator profile checks', async () => {
    const inspect = vi.fn(() => HttpResponse.json({ error: { code: 'HARNESS_CHECK_TIMEOUT', message: 'Timed out.' } }, { status: 503 }))
    server.use(
      http.get('/api/management/harnesses/registry', () => HttpResponse.json(inventory())),
      http.get('/api/management/harnesses/:harness/execution-readiness', inspect),
      http.get('/api/management/settings/agents', inspect),
      http.get('/api/management/harnesses', inspect),
    )
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('button', { name: 'Codex: Installed' })).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Claude: Installed' })).toBeVisible()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('shows an unverified status when inventory cannot be read', async () => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.error()))
    renderWithRouter(<HarnessStatusMenu />)
    await expectDetails(await screen.findByRole('button', { name: 'Codex: Unverified' }), /Could not read installation status/)
  })

  it('keeps absent observations unverified instead of assuming a harness is missing', async () => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [] })))
    renderWithRouter(<HarnessStatusMenu />)
    await expectDetails(await screen.findByRole('button', { name: 'Claude: Unverified' }), /No installation inventory/)
  })

  it('does not display another Main computer inventory', async () => {
    const wrong = inventory()
    wrong.installations[0]!.hostRef.mainId = '11111111-1111-4111-8111-111111111111'
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json(wrong)))
    renderWithRouter(<HarnessStatusMenu />)
    expect(await screen.findByRole('button', { name: 'Codex: Unverified' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Codex: Installed' })).not.toBeInTheDocument()
  })

  it('reuses the shared inspection while a background refresh runs and displays a confirmed removal', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const read = vi.fn(async () => {
      await gate
      return HttpResponse.json(inventory(false))
    })
    server.use(http.get('/api/management/harnesses/registry', read))
    const { queryClient } = renderWithRouter(<HarnessStatusMenu />)
    queryClient.setQueryData(inventoryKey(), inventory())
    expect(await screen.findByRole('button', { name: 'Codex: Installed' })).toBeVisible()
    expect(read).not.toHaveBeenCalled()
    let refresh!: Promise<void>
    act(() => { refresh = queryClient.invalidateQueries({ queryKey: inventoryKey() }) })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Codex: Installed' })).toBeVisible()
    await act(async () => { finish(); await refresh })
    expect(await screen.findByRole('button', { name: 'Codex: Not installed' })).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Claude: Not installed' })).toBeVisible()
  })

  it('retains the last installed observation when refreshing fails, without calling it missing', async () => {
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.error()))
    const { queryClient } = renderWithRouter(<HarnessStatusMenu />)
    queryClient.setQueryData(inventoryKey(), inventory())
    await screen.findByRole('button', { name: 'Codex: Installed' })
    await act(async () => { await queryClient.invalidateQueries({ queryKey: inventoryKey() }) })
    await expectDetails(await screen.findByRole('button', { name: 'Codex: Unverified' }), /Last inventory confirmed installation/)
    expect(screen.queryByRole('button', { name: 'Codex: Not installed' })).not.toBeInTheDocument()
  })

  it('refreshes changed inventory automatically while the sidebar stays mounted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let installed = true
    const read = vi.fn(() => HttpResponse.json(inventory(installed)))
    server.use(http.get('/api/management/harnesses/registry', read))
    const { queryClient, unmount } = renderWithRouter(<HarnessStatusMenu />)
    try {
      await screen.findByRole('button', { name: 'Codex: Installed' })
      expect(read).toHaveBeenCalledOnce()
      installed = false
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(await screen.findByRole('button', { name: 'Codex: Not installed' })).toBeVisible()
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      unmount()
      queryClient.clear()
      vi.useRealTimers()
    }
  })

  it('animates manual relocation with transform/opacity and cancels it for instant keyboard changes', async () => {
    const { animate, cancel } = mockRelocation()
    renderWithRouter(<HarnessStatusMenu />)
    await screen.findByRole('navigation', { name: 'Harness availability' })
    expect(animate).not.toHaveBeenCalled()
    act(() => useNavigationUiStore.getState().setCollapsed(true, 'manual'))
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenCalledWith([
      { transform: expect.stringContaining('translate('), opacity: 0.75 },
      { transform: 'translate(0, 0)', opacity: 1 },
    ], { duration: 160, easing: 'cubic-bezier(0.22, 0, 0, 1)' })
    act(() => useNavigationUiStore.getState().setCollapsed(false))
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenCalledTimes(2)
    act(() => useNavigationUiStore.getState().setWidth(300))
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('keeps manual relocation instant when reduced motion is requested', async () => {
    const { animate } = mockRelocation()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    try {
      renderWithRouter(<HarnessStatusMenu />)
      await screen.findByRole('navigation', { name: 'Harness availability' })
      act(() => useNavigationUiStore.getState().setCollapsed(true, 'manual'))
      expect(animate).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
