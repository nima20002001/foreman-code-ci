import { afterEach, describe, expect, it } from 'vitest'

import {
  applyStoredOrder,
  moveItemRelative,
  moveItemToIndex,
  useNavigationOrderStore,
  WORKSPACES_ORDER_KEY,
  workspaceSectionsOrderKey,
} from './navigationOrder'

afterEach(() => {
  useNavigationOrderStore.getState().reset()
})

describe('applyStoredOrder', () => {
  it('keeps the natural order without a stored order', () => {
    expect(applyStoredOrder(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c'])
    expect(applyStoredOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c'])
  })

  it('applies the stored order and appends ids projected after it', () => {
    expect(applyStoredOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b'])
  })

  it('drops stored ids that no longer exist and ignores duplicates', () => {
    expect(applyStoredOrder(['a', 'b'], ['gone', 'b', 'b', 'a'])).toEqual(['b', 'a'])
    expect(applyStoredOrder(['a', 'b'], ['gone'])).toEqual(['a', 'b'])
  })
})

describe('moveItemToIndex', () => {
  it('moves an id to the target index and clamps to the list bounds', () => {
    expect(moveItemToIndex(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveItemToIndex(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveItemToIndex(['a', 'b', 'c'], 'a', -5)).toEqual(['a', 'b', 'c'])
    expect(moveItemToIndex(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
    expect(moveItemToIndex(['a', 'b', 'c'], 'missing', 0)).toEqual(['a', 'b', 'c'])
  })
})

describe('moveItemRelative', () => {
  it('moves an id before or after a sibling without crossing the list', () => {
    expect(moveItemRelative(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(moveItemRelative(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveItemRelative(['a', 'b', 'c'], 'a', 'a', 'before')).toEqual(['a', 'b', 'c'])
    expect(moveItemRelative(['a', 'b', 'c'], 'a', 'missing', 'before')).toEqual(['a', 'b', 'c'])
  })
})

describe('useNavigationOrderStore', () => {
  it('keeps orders per parent key and announces with a new nonce', () => {
    const store = useNavigationOrderStore.getState()
    const sectionsKey = workspaceSectionsOrderKey('workspace-1')

    store.setOrder(WORKSPACES_ORDER_KEY, ['workspace-2', 'workspace-1'])
    store.setOrder(sectionsKey, ['files', 'agents', 'workflows'])

    expect(useNavigationOrderStore.getState().orders).toEqual({
      [WORKSPACES_ORDER_KEY]: ['workspace-2', 'workspace-1'],
      [sectionsKey]: ['files', 'agents', 'workflows'],
    })

    store.announce('Moved Files to position 1 of 7')
    const first = useNavigationOrderStore.getState().announcement
    store.announce('Moved Files to position 1 of 7')
    const second = useNavigationOrderStore.getState().announcement

    expect(first?.message).toBe('Moved Files to position 1 of 7')
    expect(second?.nonce).toBe((first?.nonce ?? 0) + 1)

    useNavigationOrderStore.getState().reset()
    expect(useNavigationOrderStore.getState().orders).toEqual({})
    expect(useNavigationOrderStore.getState().announcement).toBeNull()
  })
})
