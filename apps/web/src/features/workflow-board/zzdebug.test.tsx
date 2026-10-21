import { screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { boardHref, setRunState, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'

installBoardTestLifecycle()
it('debug', async () => {
  installFlowLayout(1000, 720)
  const fixture = await inspectionBoardFixture('dbg')
  const scope = fixture.runs.before.scope
  setRunState(fixture, scope, 'running')
  measureBoardWire(fixture.mock)
  const { container, router } = await mountMeasuredBoard(boardHref(scope))
  const label = fixture.first.name ?? fixture.first.id
  try { await screen.findByRole('slider', { name: `Resize ${label}` }) } catch (e) {
    const main = container.querySelector('[data-testid="unified-workflow-board"]') ?? container
    const labels = [...main.querySelectorAll('[aria-label]')].map(el => `${el.tagName}:${el.getAttribute('aria-label')}`)
    console.error('DBGURL', router.state.location.href)
    console.error('DBGLABELS', JSON.stringify(labels))
    console.error('DBGTEXT', main.textContent?.replace(/\s+/g, ' ').slice(0, 3000))
    console.error('DBGNODES', [...main.querySelectorAll('.react-flow__node')].map(n => n.getAttribute('data-id') + ':' + (n.getAttribute('aria-label') ?? '')).join(' | '))
  }
  expect(true).toBe(true)
}, 30000)
