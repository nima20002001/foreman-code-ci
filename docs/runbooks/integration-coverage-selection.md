# Integration coverage selection

Full integration runs record function-level V8 coverage in each test worker.
`integration-coverage.json` contains a commit, the complete test inventory, and
repository-relative executed source paths for each reported test file. Built
contracts paths are mapped back to their source paths. There is no statement,
HTML, or source-map report generation.

Each partition publishes a fragment alongside its durations and test results.
Main merges fragments by source repository and commit in its integration coverage
cache. A partial map can narrow selection for files with records. For each test
in the map inventory without a record, selection uses its static import graph.
Selected files using that fallback appear in `selection.staticFallbackFiles`.
Tests without worker reports, or tests starting child processes or
worker threads, retain static selection because worker coverage cannot describe
all their execution. Failed tests can still supply coverage; absent worker reports
use static selection.

For affected integration requests, Main chooses a usable ancestor map and
compares its source tree with the requested commit. Lockfile or shared CI
infrastructure changes invalidate the map. All intervening changes participate
in selection, including changes that preceded the request's comparison base.
The runner selects coverage matches, changed or new tests, and static
dependents for unrecorded source changes and tests requiring static selection.
Missing or unusable maps use ordinary static import selection. Existing rules
that require full scope still apply.

The chosen coverage input is saved once per CI group at admission and reused by
every partition and setup retry, including after a service restart. New artifacts
can change later groups but cannot change an admitted group's selection. Mirror
prepublication and starts receive that same saved input.

Static dependencies include literal `new URL(..., import.meta.url)` inputs and
literal filesystem reads, including forked fixture modules. A changed repository
runtime input with no resolved dependency or execution record requires full scope.
The artifact cache retains at most 32 maps per repository. A small index selects
ancestor candidates before their coverage payloads are loaded.

Artifacts are readable JSON. Transport uses a shared source-path index and gzip
to keep complete maps within the device channel's existing message limit.
Cloud snapshots carry the same selection input as build computers, outside
provider parameter limits. `ci_run` reports the initial choice; `ci_get` retains
the runner's `selection` with its scope, files and reason, including the coverage
commit or the fallback reason. Cloud runners also publish `selection.json`.
Explicit full requests and release gates always execute their entire assigned
suite or partition.
Computer status replies omit selection details to stay within the device channel
limit; individual run reads retain the complete selection.
