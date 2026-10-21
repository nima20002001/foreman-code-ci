Build the CI runtime from a committed source snapshot:

```sh
node scripts/build-ci-runtime-context.mjs /new/private/context
podman build --file /new/private/context/Containerfile --tag localhost/foreman-code-ci:reviewed /new/private/context
```

The context contains the project's committed lockfile, workspace policy and package manifests, plus image controls and verification scripts from the installed Foreman release. Project repositories do not supply image controls. It excludes other working-tree files, source credentials and caches. The base manifest, Node 22.23.3, Corepack 0.36.0 and pnpm 11.27.0 are pinned. Frozen-lock dependency fetching retains the repository's strict 48-hour release-age policy. The installed Corepack wrapper uses its fixed image cache and disables network acquisition at workload runtime.

Other pnpm projects run their root `build`, `lint`, `test` (unit), `typecheck`, or `test:integration` script after the same frozen offline install. Reports count the script's exit status as one command result; they do not invent per-test counts. Missing scripts fail with logs. Foreman's own package retains its package-level test inventory and requires its qualified Codex binary for unit tests. Preparing a second project retains the first project's protected runtime configuration; runtime selection matches the requested project, image, source and resource policy before the existing qualification and execution checks.

Build or pull during separately authorized image preparation. Record the actual immutable image ID and measured toolchain digest for runtime qualification; a rebuilt image must not reuse another build's receipt or tag as identity. This recipe does not provision worker cgroups, create approved roots, initialize operation journals, qualify the runtime, or authorize execution. Existing filesystem, no-new-privileges, network and descendant-containment guards remain mandatory.

The default `build` target retains that image lineage. The separate `verification`
target consumes a reviewed offline seed and performs no dependency acquisition.
Prepare the seed first through an already approved preparation process. This
recipe does not authorize that process's network access or choose destinations.

```sh
node scripts/build-ci-runtime-context.mjs /new/private/context /private/offline-seed-config.json
podman build --network=none --pull=never --memory=2g --target verification \
  --file /new/private/context/Containerfile --tag localhost/foreman-code-verification:reviewed /new/private/context
```

The verification policy requires a finite build-container memory limit, including
the toolchain version check. The automatic preparer uses the same 2 GiB limit.

The private config contains absolute `directory` and `receiptPath` values. The
receipt must be a private, regular, singly linked owner file. Its version 1 shape
contains these required inputs:

- `packageManager: "pnpm@11.27.0"`; platform `{os:"linux",arch:"x64",libc:"glibc"}`.
- `minimumReleaseAge:2880`, `minimumReleaseAgeStrict:true`,
  `minimumReleaseAgeIgnoreMissingTime:false`; no release-age exclusions.
- `capturedAt`, `provenanceDigest`, and review containing `reviewedByPrincipalId`,
  `reviewedAt`, `decisionDigest`. Review follows the registry/store capture.
- Explicit reviewed `maxBytes` and `maxInodes`. Directories count toward inodes.
- `dependencyInputs`, sorted by path, containing `{path,sha256}` for the committed
  root/workspace package manifests, lockfile and workspace policy.
- `files`: the complete seed inventory, each `{path,bytes,sha256}`, under
  `corepack-cache/`, `pnpm-store/`, `registry-cache/`, or `metadata/`. Seed stores
  are closed snapshots; no owner home, credentials, writable owner store or
  dependency directory is mounted into a Job.
- `packages`: one `{name,version,integrity,publishedAt,metadataPath}` for every
  locked registry package. Each metadata file is a captured registry response
  whose `name`, `time[version]` and `versions[version].dist.integrity` agree.

Every locked release must already be 48 hours old at seed capture. Missing
timestamps, changed dependency inputs, extra files, links, altered bytes and
over-budget seeds fail preparation. The context receipt records lock/manifests,
seed receipt digest, platform, provenance, package count and release-age result.
Review this receipt together with the resulting immutable image identity.

At Job runtime, the image-controlled Corepack wrapper pins pnpm and checks
the effective policy before execution. Installs are frozen, offline and include
dev dependencies. The immutable seed is copied into a Job-private writable store
and registry cache. HOME, XDG state and lifecycle TMPDIR use `/job-scratch`;
small control scratch remains noexec `/tmp`. Caller environment/config overrides
cannot redirect the store or weaken the effective release-age checks. A cache
miss fails offline. The pnpm installer also revalidates locked dependencies under
its active policy ([pnpm release notes](https://github.com/pnpm/pnpm/releases/tag/v11.1.3)).

The image contains `verification-observation.mjs` for an admitted, model-free
physical diagnostic. It reports actual namespaces, cgroup limits, temp/shm
geometry, mount flags, executable scratch behavior, effective package policy and
controller-owned sentinel visibility. It cannot grant qualification. It must
run through the existing native owner with the exact approved image, source,
quota and resource configuration. Actual ordinary-suite cold-cache peaks,
quota pressure, descendant cancellation and failure publication remain separate
required measurements. Integration runs `scripts/test-integration.mjs` against
PostgreSQL 17 in `/job-scratch/postgres`, listening only in the private container
network. Qualification derives its shard count from the saved CPU, memory and
scratch limits; dispatched shards cannot exceed that measured allowance.
Use an integration profile with enough execution time and report storage for
the full suite. Preparation budgets qualification for every suite plus its
timeout and cancellation probes within the reviewed approval lifetime.

Verification uses the separate fingerprint version 3 / measurement version 2.
Build evidence is unchanged. Registry/public egress remains unavailable without
the owner's enforcement method, version, reviewed destination policy and real
bypass-denial qualification. No fallback changes the selected network mode.
