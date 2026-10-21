import { fireEvent } from '@testing-library/react'

/** Supply the browser hit test missing in jsdom while React Flow validates the connection. */
export function clickConnectionHandles(source: Element, target: Element) {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
  try {
    fireEvent.click(source)
    fireEvent.click(target)
  } finally {
    if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor)
    else Reflect.deleteProperty(document, 'elementFromPoint')
  }
}
