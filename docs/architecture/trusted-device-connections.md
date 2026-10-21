# Trusted device connections

Pairing authorizes device connection configuration. Both the local app and the
Operator use `PostgresTrustedConnectionSetup` with the shared
`@foreman-code/contracts/trusted-device-connection` contracts. Connection changes
require global `settings:update`; discovery, inspection, checks and readback
require global `settings:read`.

Configure or revoke consent directly through `/api/devices/connection-configure`
or `device_connection_configure`. The device must be paired, and the supplied
device authorization revision and consent revision must match the saved records.
Bearer authentication, live principal grants, delegation and scopes are checked.
Read-only callers cannot configure a connection. Command retries retain their
original result; changed input with the same command ID conflicts. The command
coordinator records the invoking principal and source in its audit.

Configuration stores the paired identity, endpoint, OS user, SSH host fingerprint,
and whether owner commands are allowed. Existing consent receipts remain readable;
retired approval metadata is omitted from public responses without rewriting the
saved receipt. Revocation sets `allowOwnerCommands` to false. Device revocation,
re-pairing and identity changes block readiness.

Connection configuration does not change SSH, VPN, known-hosts or credentials.
Diagnostics use existing authentication and strict host trust. Ready connection
settings do not grant agent execution permissions or enable automatic sudo.
Execution and byte transfer retain their domain and harness authorization checks.
