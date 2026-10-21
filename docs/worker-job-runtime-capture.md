# Human-reviewed Job runtime capture

After physical storage/root installation approval, the packaged worker exposes
`captureInstalledRuntimeConfiguration` and this explicit installer command:

```sh
/approved/node /approved/worker/src/cli.mjs capture-job-runtime \
  --state /existing/private/worker-state \
  --input /private/reviewed-capture-input.json
```

Use the existing strict `InstalledJobRuntimeCaptureInputSchema` from
`apps/api/src/modules/jobs/installedRuntimeHost.ts`. It contains `schemaVersion`,
`target`, the real `SourceRootRecord`, explicit runtime/OCI/findmnt executables,
`runtimeRoot`, `backingFile`, `controllerEnvironment`, and approved immutable
`imageDigest`, `toolchainDigest`, `diskBytes`. Caller `pins`, measurement or
readiness fields are rejected. The passive helper computes actual host pins;
it does not install, execute binaries, qualify, approve, or launch a Job.

State must already exist as a canonical private persistent directory belonging
to the worker account. Identity and pairing must already match. The reviewed
input must be a canonical worker-owned private regular single-link file, at most
65536 bytes, under a protected directory. An active worker blocks capture.
`runtimeRoot` must equal the installed approved allowlist's `managedRuntimeRoot`;
the source binding must identify its actual `source-materializations/:rootPolicyId`
namespace and filesystem. Source IDs, registrations and revisions come from the
authorized product readback, never examples or inferred identities.

The command exclusively publishes a private 0600, bounded, fsynced
`job-runtime.json` through atomic no-overwrite linking. Any existing destination,
including a symlink, is refused. There is no force/update option. Existing
identity, pairing, roots and journals are preserved, including when capture
fails. Updating installed configuration requires a separately reviewed lifecycle
operation; deleting recovery evidence is not an update mechanism. The installer
can refresh a stopped, quiescent Worker using:

```sh
/approved/node /approved/worker/src/cli.mjs refresh-job-runtime \
  --state /existing/private/worker-state \
  --input /private/reviewed-refresh-input.json
```

The strict refresh input contains `expectedConfigurationSha256` for the original
protected file and `captureInput` using the same capture schema. Refresh rejects
active or unfinished work, stale configuration digests, changed pairing, or roots
outside the approved installation. It captures current host facts and preserves
the complete previous configuration in a private immutable history file before
atomically publishing its replacement. Journals, identity, pairing and source
records are retained. A changed fingerprint requires a new physical approval and
qualification; refresh never authorizes execution.

Stdout contains only a receipt with `configurationPath`, `captured: true`,
`qualified: false`, `executionAuthorized: false`. Input/configuration/credentials
are not printed. Errors are bounded codes.

Capture and refresh are intentionally human-only installer configuration: they select protected
host paths and expands installation filesystem scope. Operator MCP cannot
self-select these paths or self-approve physical qualification. Existing MCP
runtime-profile save/request/run/read tools continue using the same services and
require the original human approval. Captured pins are installation metadata;
only the existing guarded qualification can produce readiness, followed by
authorized Job acceptance. No new grants or native journals are created here.
