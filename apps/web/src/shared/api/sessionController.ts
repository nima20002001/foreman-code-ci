let controller = new AbortController()

export function sessionControllerSignal(): AbortSignal { return controller.signal }

export function rotateSessionController(reason: Error): void {
  controller.abort(reason)
  controller = new AbortController()
}
