/**
 * D registers these handlers with the existing paired-device command/byte/media owners.
 * The verified native runtime owns implementation; constructing this facade performs no I/O.
 * C0 supplies canonical codecs and the existing authenticated session authority.
 */
export function createWorkerBrowserDeviceExtension({ runtime, pairing, authority, codecs, mediaCodec, reportFailure }) {
  let selectedHost = null, selectedBinding = null, endpoint = null;
  const sockets = new Set();
  async function current(binding) {
    await pairing.assertCurrent(binding);
    const host = runtime.getHost(), module = runtime.getModule();
    if (!host || typeof module?.createBrowserHostDeviceEndpoint !== 'function') {
      const error = new Error('The installed managed browser runtime is unavailable.');
      error.code = 'BROWSER_RUNTIME_UNAVAILABLE';
      throw error;
    }
    if (host !== selectedHost || binding.installationId !== selectedBinding?.installationId
      || binding.connectionId !== selectedBinding?.connectionId) {
      for (const socket of sockets) socket.close(1008, 'Browser host binding changed');
      sockets.clear();
      endpoint = module.createBrowserHostDeviceEndpoint({ host, binding, pairing, authority, codecs, mediaCodec, reportFailure });
      selectedHost = host; selectedBinding = binding;
    }
    return endpoint;
  }
  return {
    descriptor: codecs.descriptor,
    command: async (binding, envelope) => (await current(binding)).command(envelope),
    upload: async (binding, envelope, chunks) => (await current(binding)).upload(envelope, chunks),
    download: async (binding, envelope) => (await current(binding)).download(envelope),
    async media(binding, socket) {
      const host = await current(binding);
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      try { await host.media(socket); }
      catch (error) { sockets.delete(socket); socket.close(1008, 'Browser media unavailable'); throw error; }
    },
    close() {
      for (const socket of sockets) socket.close(1001, 'Browser device extension closing');
      sockets.clear(); endpoint = null; selectedHost = null; selectedBinding = null;
    },
  };
}
