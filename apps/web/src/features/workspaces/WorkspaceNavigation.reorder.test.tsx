import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceShell } from '../../shared/ui/WorkspaceShell'
import { useNavigationOrderStore } from './navigationOrder'

const sectionsGroup = 'workspace:workspace-1:sections'
const sectionsGroupTwo = 'workspace:workspace-2:sections'
const workspacesGroup = 'workspaces'

type Layout = { top: number; height: number; left?: number; width?: number }

function rect(input: Layout): DOMRect {
  const left = input.left ?? 0
  const width = input.width ?? 240
  return {
    x: left,
    y: input.top,
    top: input.top,
    left,
    width,
    height: input.height,
    right: left + width,
    bottom: input.top + input.height,
    toJSON: () => ({}),
  } as DOMRect
}

function stubLayout(rects: Map<Element, DOMRect>) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rects.get(this) ?? rect({ top: 0, height: 0, width: 0 })
  })
}

function layoutList(group: string, top: number, itemHeight = 30): Map<Element, DOMRect> {
  const rects = new Map<Element, DOMRect>()
  const list = document.querySelector(`[data-reorder-group="${group}"]`)
  if (!list) throw new Error(`Missing reorder group ${group}`)
  const items = [...list.querySelectorAll<HTMLElement>('[data-reorder-id]')].filter(
    (element) => element.closest('[data-reorder-group]') === list,
  )
  items.forEach((item, index) => {
    rects.set(item, rect({ top: top + index * itemHeight, height: itemHeight }))
  })
  rects.set(list, rect({ top, height: items.length * itemHeight }))
  return rects
}

function reorderIds(group: string): string[] {
  const list = document.querySelector(`[data-reorder-group="${group}"]`)
  if (!list) throw new Error(`Missing reorder group ${group}`)
  return [...list.querySelectorAll<HTMLElement>('[data-reorder-id]')]
    .filter((element) => element.closest('[data-reorder-group]') === list)
    .map((element) => element.dataset.reorderId ?? '')
}

function item(group: string, id: string): HTMLElement {
  const list = document.querySelector(`[data-reorder-group="${group}"]`)
  const element = list?.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`)
  if (!element) throw new Error(`Missing reorder item ${group}/${id}`)
  return element
}

function pointerDrag(
  source: HTMLElement,
  target: { x: number; y: number },
  pointerType: 'mouse' | 'touch' = 'mouse',
  start: { x: number; y: number } = target,
) {
  fireEvent.pointerDown(source, {
    button: 0,
    pointerId: 1,
    pointerType,
    clientX: start.x,
    clientY: start.y,
  })
  fireEvent.pointerMove(window, {
    pointerId: 1,
    pointerType,
    clientX: target.x,
    clientY: target.y,
    buttons: 1,
  })
  fireEvent.pointerMove(window, {
    pointerId: 1,
    pointerType,
    clientX: target.x,
    clientY: target.y,
    buttons: 1,
  })
  fireEvent.pointerUp(window, {
    pointerId: 1,
    pointerType,
    clientX: target.x,
    clientY: target.y,
  })
}

afterEach(() => {
  useNavigationOrderStore.getState().reset()
})

describe('sidebar menu reordering', () => {
  it('reorders sibling workspace entries with Alt+Arrow keys', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )

    const docs = await screen.findByTestId('workspace-entry-workspace-2')
    docs.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')

    expect(reorderIds(workspacesGroup)).toEqual(['workspace-2', 'workspace-1'])
    expect(item(workspacesGroup, 'workspace-2')).toContainElement(docs)
  })

  it('never moves a dragged item into another workspace list', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Expand Docs' }))

    const rects = new Map([
      ...layoutList(sectionsGroup, 100),
      ...layoutList(sectionsGroupTwo, 400),
    ])
    stubLayout(rects)

    pointerDrag(item(sectionsGroup, 'workflows'), { x: 50, y: 415 }, 'mouse', { x: 50, y: 175 })

    expect(reorderIds(sectionsGroup)).toEqual([
      'workflows',
    ])
    expect(reorderIds(sectionsGroupTwo)).toEqual([
      'workflows',
    ])
  })

  it('does not arm workspace reordering when a nested section is dragged', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Expand Docs' }))

    const nestedFile = item(sectionsGroup, 'workflows')
    expect(nestedFile.closest('[data-reorder-id="workspace-1"]')).toBeNull()
    const rects = new Map([
      ...layoutList(workspacesGroup, 50, 200),
      ...layoutList(sectionsGroup, 100),
      ...layoutList(sectionsGroupTwo, 400),
    ])
    stubLayout(rects)

    pointerDrag(nestedFile, { x: 50, y: 350 }, 'mouse', { x: 50, y: 175 })

    expect(reorderIds(workspacesGroup)).toEqual(['workspace-1', 'workspace-2'])
    expect(reorderIds(sectionsGroup)).toEqual([
      'workflows',
    ])
  })

})
