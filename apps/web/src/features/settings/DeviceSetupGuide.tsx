import { InfoHint } from '../../shared/ui/InfoHint'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'

/** Static guidance shown before a request code exists. It never installs, logs in or changes a network. */
export function DeviceSetupGuide() {
  return <section className="device-setup-guide" aria-label="Before you add a computer">
    <h3>Before you add a computer</h3>
    <ol className="computer-steps">
      <li><strong>Install the companion on the remote computer first.</strong> <InfoHint label="Computer request code">Its request code only exists after the companion is installed and opened there.</InfoHint>
        <InfoHint label="Pairing">Pairing lets the computer connect and send heartbeats to this main. Pairing authorizes connection changes; connection readiness is checked separately.</InfoHint></li>
      <li><strong>Configure the connection through the Operator.</strong> Pairing authorizes connection changes. The Operator can use device_connection_configure with settings:update for the selected operating-system user.</li>
      <li><strong>Check connection readiness.</strong> <InfoHint label="Connection readiness">Readiness comes from a verified connection, not from registration or inventory.</InfoHint></li>
    </ol>
    <details className="computer-details"><summary>Network prerequisites</summary>
      <ul className="computer-diagnostics">
        <li>SSH and rsync must already be installed and working on the remote computer.</li>
        <li>The remote computer must be reachable from this main over your LAN or, optionally, over Tailscale.</li>
        <li>If you use Tailscale, install it and sign in yourself on each computer; this page does not install it or change network settings.</li>
        <li>Compare the computer and main fingerprints shown when you confirm details. Do not approve if they differ from what each machine displays.</li>
      </ul>
    </details>
  </section>
}

/** Pairing alone does not establish connection readiness. */
export function ConnectionSetupStatus({ registration }: { registration: DeviceRegistration }) {
  const state = registration.status === 'revoked' ? 'blocked' : registration.status === 'paired' ? 'unverified' : 'needs-pairing'
  return <section className="device-setup-status" aria-label="Remote command connection" data-state={state}>
    <h3>Remote command connection</h3>
    <p role="status">{registration.status === 'revoked'
      ? <><strong>Blocked.</strong> This computer’s registration is revoked, so no connection can be set up.</>
      : registration.status === 'paired'
        ? <><strong>Connection status unverified.</strong> This computer is paired. Ask the Operator to read and configure its connection, then check readiness with device_connection_read, device_connection_configure and device_connection_check.</>
        : <><strong>Pairing needed.</strong> Pair this computer before any connection can be set up.</>}</p>
  </section>
}
