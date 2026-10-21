# CI runtime qualification authority

The runtime policy API saves revisioned policy metadata for an existing approved
source root. Public inputs contain neither executable paths nor a qualification
or readiness assertion. Requesting qualification captures the installed candidate
fingerprint without launching a probe. GET and MCP readback use persisted records
and current HRT metadata and never install, probe or change filesystem settings.

Physical qualification approval is intentionally human-only. The approval route
uses the existing implicit local human boundary and mutation-origin boundary;
HTTP bearer authentication and MCP cannot approve themselves. The immutable
command receipt binds the actual human principal to the exact installed
fingerprint. Operator MCP can save policies, request qualification, run an already
approved qualification and read the persisted original approval, results and
readiness. The approver and running principal are rechecked live.

The original qualification ID is its native operation identity. The main catalog
persists the running command before native entry; a lost result requires the
existing host owner's reconciliation and cannot launch another probe. Unconfirmed
physical closure remains recovery-required and never supplies a qualified policy.
Only actual guarded measurements can become qualified evidence. Profile edits do
not rewrite accepted job policy versions; current revocation and evidence expiry
still deny use of the original version.

The concrete producer uses CI-A's guarded physical qualification through the
existing installed HRT host descriptor, current metadata and native owner. It does
not create a second runtime registry or scheduler. Package installation approval
does not authorize provisioning or mounting the dedicated bounded CI volume.
Root owns physical preparation and full database/authenticated MCP acceptance.

## Verification approval boundary

Verification uses its own profile, fingerprint version 3 and measurement version
2. A build measurement does not establish executable scratch, private shm,
release-age enforcement, suite resource requirements or failure publication.
`requireVerificationRuntime` validates the complete accepted verification spec,
measured suite/worker limits, resource reservation and reviewed remaining
validity before entry. `verificationProfileReadiness` consumes persisted profile
and installed fingerprint data and performs no probe or installation.

The reviewed lifetime must cover preparation, service startup, execution,
cancellation, publication and cleanup. An unset review denies dispatch; a retry
does not renew approval. The existing build lifetime and seven-check evidence
remain unchanged. Original operation ownership still permits required recovery
and descendant closure after fresh-entry qualification expires.

Offline preparation records committed dependency input digests, platform,
pnpm identity, captured registry release times, complete seed file inventory,
provenance and owner review. Its immutable image identity binds that receipt to
qualification. Missing timestamps or a release younger than 2,880 minutes at
capture deny preparation. Public Job/profile input cannot claim seed trust.

Registry-only and public egress require the owner's enforcement implementation,
version and reviewed destination policy, plus the planned bypass-denial checks.
They remain unavailable in these offline mechanisms. Provider scope, resource
envelopes, approval lifetime and mandatory gate checks are owner inputs; this
change chooses none of them.

The frozen verification profile/measurement contracts do not yet version the
approval, qualification candidate/result/RPC or installed carrier/journal
schemas. Those shared boundaries must retain the full verification record
before product activation. The runtime callbacks deny missing configuration;
they do not convert verification to a build record. Authorized HTTP and
Operator MCP save/request/run/readback adapters and denied-caller/persisted
readback tests must ship with that integration. Physical approval remains
human-only for the same authentication/origin reason described above.
