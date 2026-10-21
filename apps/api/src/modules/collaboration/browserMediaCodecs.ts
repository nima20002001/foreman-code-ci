import { BrowserHostMediaMessageSchema, BrowserViewerMessageSchema, BrowserViewerHelloSchema,
  encodeBrowserBinaryFrame, decodeBrowserBinaryFrame } from '@foreman-code/contracts'
import type { BrowserHostMediaCodec } from '../browser-runtime/pairedMedia.js'
import type { BrowserMediaWireCodec } from '../browser-runtime/mediaSocket.js'

export const browserHostMediaCodec: BrowserHostMediaCodec = {
  encode(value) {
    if (value.kind === 'frame') {
      const { bytes, ...header } = value
      return encodeBrowserBinaryFrame(BrowserHostMediaMessageSchema.parse(header), bytes)
    }
    return JSON.stringify(BrowserHostMediaMessageSchema.parse(value))
  },
  decode(value) {
    if (typeof value === 'string') {
      const message = BrowserHostMediaMessageSchema.parse(JSON.parse(value))
      if (message.kind === 'frame') throw new Error('Browser frame bytes require the binary channel.')
      return message
    }
    const { header, bytes } = decodeBrowserBinaryFrame(value)
    const message = BrowserHostMediaMessageSchema.parse(header)
    if (message.kind !== 'frame') throw new Error('Binary browser messages must carry frames.')
    return { ...message, bytes }
  },
}
export const browserViewerCodec: BrowserMediaWireCodec = {
  decodeHello: value => BrowserViewerHelloSchema.parse(value),
  frame: ({ bytes, ...value }) => encodeBrowserBinaryFrame(BrowserViewerMessageSchema.parse(value), bytes),
  control: value => JSON.stringify(BrowserViewerMessageSchema.parse(value)),
  closed: value => JSON.stringify(BrowserViewerMessageSchema.parse(value)),
}
