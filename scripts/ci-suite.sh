#!/bin/bash
# Runs one CI suite on a fresh cloud machine (GitHub Actions or CircleCI).
#   scripts/ci-suite.sh start  — before `pnpm install`: starts PostgreSQL and the harness CLIs in the background
#   scripts/ci-suite.sh        — after `pnpm install`: waits for them, then runs the suite
#   scripts/ci-suite.sh prepare — after `pnpm install` on a build computer: prepares prerequisites synchronously
# SUITE: install, typecheck, lint, unit, build or integration, or one part of a check so the parts run on separate
# machines: unit-api, unit-web, unit-web-heavy, unit-other, lint-api, lint-other, typecheck-api, typecheck-other,
# build-api, build-other. For unit-api and unit-web, SLICE is
# a duration-balanced shard such as 2/3 (scripts/ci-unit-files.mjs). SLICE: an integration partition's file indexes
# (scripts/ci-files.mjs); empty runs every file. DURATIONS_OUTPUT: where measured file durations go.
# TEST_RESULTS_OUTPUT: where structured test results go for unit and integration (scripts/ci-test-results.mjs).
# Host CI uses this hook for named parts; ci-files.mjs opts into integration partitions.
set -euo pipefail
# Oversized CircleCI inputs live in the execution snapshot; verify them before starting any suite work.
case "${CI_PARTITION:-}" in
  sha256:*) exec node "$(dirname "$0")/ci-selection.mjs" --dispatch-inputs "$0" "$@" ;;
esac
# Only test suites report per-test progress; typecheck, lint and build can stay silent for minutes.
if [ "${CI_WATCHDOG_ACTIVE:-}" != 1 ] && [ -n "${CI_EXPECTED_DURATION_MS:-}" ] && [ -z "${1:-}" ]; then
  case "${SUITE:-}" in unit|unit-*|integration) exec node "$(dirname "$0")/ci-watchdog.mjs" -- bash "$0" ;; esac
fi
# Test commands never inherit where this run's results go: a nested CI fixture would write over them.
test_results="${TEST_RESULTS_OUTPUT:-}"
unset TEST_RESULTS_OUTPUT
selection_output="${CI_SELECTION_OUTPUT:-}"
unset CI_SELECTION_OUTPUT
state="${CI_STATE:-${TMPDIR:-/tmp}/foreman-ci-state}"
# Private-root checks reject group-writable ancestors; cloud images create the home cache with umask 002.
if [ "${CI_HOST_RUNNER:-0}" != 1 ]; then
  umask 022
  # Suite fixtures run with a minimal PATH that has no chmod; they have nothing to fix.
  if command -v chmod > /dev/null; then
    for dir in "$HOME" "$HOME/.cache"; do if [ -d "$dir" ]; then chmod go-w "$dir"; fi; done
  fi
fi

# Cloud workflows cache this prefix, so the harness CLIs install once per cache key instead of once per part.
clis_prefix=""
if [ -n "${FOREMAN_CODE_CI_CLIS_PREFIX:-}" ]; then
  clis_prefix="$(realpath -m "$FOREMAN_CODE_CI_CLIS_PREFIX")"
  export PATH="$clis_prefix/bin:$PATH"
fi

if [ "${CI_HOST_RUNNER:-0}" = 1 ]; then
  pnpm() { corepack pnpm "$@"; }
fi

if [ -f node_modules/.modules.yaml ]; then
  package_environment="$(node scripts/ci-package-paths.mjs "$PWD")"
  eval "$package_environment"
fi

if [ -z "${1:-}" ] && [ -n "${FOREMAN_CODE_CI_TYPECHECK_CACHE:-}" ] \
  && [ "${FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE:-}" != 1 ]; then
  case "$SUITE" in
    typecheck|typecheck-*) exec node "$(dirname "$0")/ci-typecheck-cache.mjs" -- bash "$0" ;;
  esac
fi

if [ "${1:-}" = start ] || [ "${1:-}" = prepare ]; then
  case "$SUITE" in unit-web|unit-web-heavy) exit 0 ;; esac
  case "$SUITE" in unit|unit-*|integration) ;; *) exit 0 ;; esac
  clis="npm install --global ${clis_prefix:+--prefix $clis_prefix }--silent --before=$(date -u -d '-2 days' +%Y-%m-%dT%H:%M:%SZ) @openai/codex @anthropic-ai/claude-code"
  if [ "$1" = prepare ]; then
    mkdir -p "$state"
    prepare_one() {
      local name="$1" code=0
      shift
      "$@" > "$state/$name.log" 2>&1 || code=$?
      cat "$state/$name.log"
      echo "$code" > "$state/$name.exit"
      return "$code"
    }
    prepare_one db corepack pnpm db:up
    case "$SUITE" in unit|unit-api|integration)
      if ! command -v codex >/dev/null || ! command -v claude >/dev/null; then
        prepare_one clis bash -c "$clis"
      else
        : > "$state/clis.log"
        echo 0 > "$state/clis.exit"
      fi ;;
    esac
    exit 0
  fi
  mkdir -p "$state"
  background() { setsid nohup bash -c "$2 > '$state/$1.log' 2>&1; echo \$? > '$state/$1.exit'" >/dev/null 2>&1 & }
  # scripts/test-db.mjs needs only Node, so the database starts while packages install.
  background db 'node scripts/test-db.mjs up'
  # Harness tests check the installed Codex and Claude CLIs, as on our build computers; same 48-hour package age rule.
  case "$SUITE" in unit|unit-api|integration)
    if [ -n "$clis_prefix" ] && [ -x "$clis_prefix/bin/codex" ] && [ -x "$clis_prefix/bin/claude" ]; then
      background clis true
    else
      background clis "$clis"
    fi ;;
  esac
  exit 0
fi

# Native process tests need a delegated cgroup, as a systemd user service gets on our build computers.
delegate_cgroup() {
  # Host CI already runs inside a delegated systemd unit.
  [ "${CI_HOST_RUNNER:-0}" != 1 ] || return 0
  local cgroup=/sys/fs/cgroup/foreman-ci
  sudo mkdir -p "$cgroup" && sudo chown -R "$(id -u):$(id -g)" "$cgroup"
  echo $$ | sudo tee "$cgroup/cgroup.procs" >/dev/null
}

ready() {
  [ "${CI_PREREQUISITES_UNTRACKED:-0}" != 1 ] || return 0
  [ -d "$state" ] && [ -f "$state/$1.log" ] || { echo "Prerequisite $1 startup status is missing" >&2; exit 1; }
  until [ -f "$state/$1.exit" ]; do sleep 0.5; done
  [ "$(cat "$state/$1.exit")" = 0 ] || { cat "$state/$1.log"; echo "$1 failed to start"; exit 1; }
}

record_tests() {
  [ -n "$test_results" ] || return 0
  node scripts/ci-test-results.mjs "$test_results" "$@"
}

unit_slice() {
  local suite="$1" package="$2" code=0
  local output
  output="$(realpath -m "${DURATIONS_OUTPUT:-$state/durations.json}")"
  mkdir -p "$state" "$(dirname "$output")"
  node scripts/ci-unit-files.mjs select "$suite" "${SLICE:-}" > "$state/unit-files"
  local files=() reporters=(--reporter=default --reporter=json "--reporter=$(realpath scripts/ci-progress-reporter.mjs)" "--outputFile.json=$output.vitest.json")
  mapfile -d '' -t files < "$state/unit-files"
  rm -f "$output" "$output.vitest.json"
  if [ "$suite" = unit-api ]; then
    (cd "$package" && pnpm test "${files[@]}" "${reporters[@]}") || code=$?
  else
    (cd "$package" && FOREMAN_WEB_TEST_PHASE=fast pnpm exec vitest run "${files[@]}" "${reporters[@]}") || code=$?
  fi
  if [ -f "$output.vitest.json" ]; then
    node scripts/ci-unit-files.mjs record "$suite" "$output.vitest.json" "$output"
  fi
  record_tests "$output.vitest.json" || { if [ "$code" = 0 ]; then code=1; fi; }
  return "$code"
}

# An exact restored build can bypass pnpm startup; misses keep the ordinary build path.
build_contracts() {
  if [ -n "${FOREMAN_CODE_CI_CONTRACTS_CACHE:-}" ] && node scripts/ci-contracts.mjs ready "$PWD"; then
    return 0
  fi
  pnpm --filter @foreman-code/contracts build
}

# The deploy's "API full check" (scripts/local-production-runtime.mjs), so a commit that fails deploy fails typecheck.
# Its build info lives in the API's tsc cache directory, which ci-typecheck-cache.mjs keeps between runs.
api_build_check() {
  echo "API production build check"
  pnpm --filter @foreman-code/api exec tsc -p tsconfig.build.json --noEmit --isolatedModules \
    --tsBuildInfoFile node_modules/.cache/tsc/production-check.tsbuildinfo
}

node_tests() {
  local report="$1"; shift
  pnpm exec node --test --test-reporter=spec --test-reporter-destination=stdout \
    "--test-reporter=$node_reporter" "--test-reporter-destination=$report" "$@"
}

unit_other() {
  local code=0 status=0
  local reports node_reporter
  reports="$(realpath -m "$state/unit-other")"
  node_reporter="$(realpath scripts/ci-node-test-reporter.mjs)"
  mkdir -p "$reports"
  rm -f "$reports/contracts.json" "$reports/worker.json" "$reports/scripts.json"
  build_contracts || return $?
  pnpm --filter @foreman-code/contracts test --reporter=default --reporter=json \
    "--outputFile.json=$reports/contracts.json" || code=$?
  (cd apps/worker && node_tests "$reports/worker.json" test/*.test.mjs) || status=$?
  if [ "$code" = 0 ]; then code="$status"; fi
  status=0
  node_tests "$reports/scripts.json" 'scripts/**/*.test.mjs' || status=$?
  if [ "$code" = 0 ]; then code="$status"; fi
  record_tests "$reports/contracts.json" "$reports/worker.json" "$reports/scripts.json" || { if [ "$code" = 0 ]; then code=1; fi; }
  return "$code"
}

scope="${SCOPE:-affected}"
selected_list=''
if [ "$scope" = affected ] && [ -z "${SELECTED_FILES:-}" ] && { [ "$SUITE" != integration ] || [ -z "${SLICE:-}" ]; }; then
  if [ ! -f scripts/ci-affected.mjs ]; then
    echo 'Running full suite: The repository has no affected selector.'
    scope=full
  else
    branch="${DEFAULT_BRANCH:-main}"
    default_ref="refs/remotes/origin/$branch"
    if [ -n "${BASE_COMMIT:-}" ]; then
      if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
        git fetch --quiet --no-tags --depth=2 origin "${CI_SELECTION_COMMIT:-$(git rev-parse HEAD)}"
        git fetch --quiet --no-tags --depth=1 origin "$BASE_COMMIT"
      fi
    else
      if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
        git fetch --quiet --no-tags --unshallow origin "+refs/heads/$branch:$default_ref"
      else
        git fetch --quiet --no-tags origin "+refs/heads/$branch:$default_ref"
      fi
    fi
    mkdir -p "$state"
    selected_list="$state/selected-files.json"
    scope="$(CI_SELECTION_OUTPUT="$selection_output" node scripts/ci-selection.mjs "$SUITE" "$default_ref" "${CI_PARTITION:-}" "$selected_list")"
    if [ "$scope" = full ] && { [ "$SUITE" != integration ] || [ -z "${CI_PARTITION:-}" ]; }; then
      selected_list=''
    fi
  fi
fi

# A full partition whose indexes exceed a provider parameter uses the timings retained in its snapshot.
if [ "$scope" = full ] && [ "$SUITE" = integration ] && [ -z "${SLICE:-}" ] && [ -n "${CI_PARTITION:-}" ] && [ -z "$selected_list" ]; then
  mkdir -p "$state"
  selected_list="$state/selected-files.json"
  node --input-type=module -e '
    import { writeFileSync } from "node:fs"
    import { integrationPartition } from "./packages/contracts/src/ciPartition.mjs"
    import { integrationFileList } from "./scripts/ci-files.mjs"
    import { executionDurations } from "./scripts/ci-selection.mjs"
    const durations = executionDurations("integration", process.cwd(), JSON.parse(process.env.CI_DURATIONS || "{}"))
    const partition = JSON.parse(process.env.CI_PARTITION)
    writeFileSync(process.argv[1], JSON.stringify(integrationPartition(integrationFileList(process.cwd()), durations, partition)))
  ' "$selected_list"
fi

unset CI_SELECTION_COMMIT

if [ -n "$selection_output" ] && [ ! -f "$selection_output" ]; then
  mkdir -p "$(dirname "$selection_output")"
  node --input-type=module -e '
    import { writeFileSync } from "node:fs"
    const scope = process.argv[1]
    const reason = scope === "full" ? "Full scope requested; every file in the suite or partition runs."
      : "Caller supplied the affected files."
    writeFileSync(process.argv[2], JSON.stringify({ scope, files: [], reason }))
  ' "$scope" "$selection_output"
fi

if [ "$scope" = affected ] && [ "$SUITE" != integration ]; then
  case "$SUITE" in
    unit|unit-api) ready db; ready clis; delegate_cgroup ;;
    unit-web|unit-web-heavy) ;;
    unit-other) ready db ;;
    lint|lint-api|lint-other|typecheck|typecheck-api|typecheck-other) ;;
    *) echo "Unsupported affected suite $SUITE"; exit 2 ;;
  esac
  if [ -n "$selected_list" ]; then
    TEST_RESULTS_OUTPUT="$test_results" node scripts/ci-affected-run.mjs "${SUITE%%-*}" --files-from "$selected_list"
  else
    TEST_RESULTS_OUTPUT="$test_results" node scripts/ci-affected-run.mjs "${SUITE%%-*}" --indexes "${SELECTED_FILES:-}"
  fi
  exit $?
fi

case "$SUITE" in
  install) ;;
  unit) ready db; ready clis; delegate_cgroup; pnpm test ;;
  unit-api) ready db; ready clis; delegate_cgroup; build_contracts
    unit_slice unit-api apps/api ;;
  unit-web) build_contracts
    unit_slice unit-web apps/web ;;
  # SLICE i/n splits the heavy phase across machines; the run-graph smoke runs once, in the first shard.
  unit-web-heavy) build_contracts
    case "${SLICE:-1/1}" in 1/*) pnpm --filter @foreman-code/web test:run-graph-smoke ;; esac
    mkdir -p "$state"; heavy_report="$(realpath -m "$state/unit-web-heavy.vitest.json")"; progress_reporter="$PWD/scripts/ci-progress-reporter.mjs"; code=0
    (cd apps/web && FOREMAN_WEB_TEST_PHASE=heavy pnpm exec vitest run ${SLICE:+--shard=$SLICE} \
      --reporter=default --reporter=json "--reporter=$progress_reporter" "--outputFile.json=$heavy_report") || code=$?
    record_tests "$heavy_report" || { if [ "$code" = 0 ]; then code=1; fi; }; exit "$code" ;;
  unit-other) ready db; unit_other ;;
  lint-api) build_contracts && pnpm --filter @foreman-code/api lint ;;
  lint-other) build_contracts \
    && pnpm -r --no-bail --filter '!@foreman-code/api' --if-present lint ;;
  typecheck-api) build_contracts && pnpm --filter @foreman-code/api typecheck && api_build_check ;;
  typecheck-other) build_contracts \
    && pnpm -r --filter '!@foreman-code/api' --if-present typecheck ;;
  build-api) build_contracts && pnpm --filter @foreman-code/api build ;;
  build-other) pnpm -r --filter '!@foreman-code/api' --if-present build ;;
  typecheck) pnpm typecheck && api_build_check ;;
  lint|build) pnpm "$SUITE" ;;
  integration)
    export FOREMAN_CODE_INTEGRATION_COVERAGE=0
    if [ "$scope" = full ]; then
      export FOREMAN_CODE_INTEGRATION_COVERAGE=1
      export FOREMAN_CODE_INTEGRATION_COVERAGE_OUTPUT="$(dirname "$DURATIONS_OUTPUT")/integration-coverage.json"
    fi
    if [ "${CI_USER_SYSTEMD:-0}" = 1 ] && [ "${CI_HOST_RUNNER:-0}" != 1 ]; then
      source scripts/ci-user-systemd.sh
    fi
    ready db; ready clis
    export FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT="$DURATIONS_OUTPUT"
    if [ -n "$test_results" ]; then export FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT="$test_results"; fi
    delegate_cgroup
    if [ -n "$selected_list" ]; then
      mapfile -d '' -t files < <(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).map(file => file + "\0").join(""))' "$selected_list")
      if [ "${#files[@]}" = 0 ]; then echo 'No affected files for this suite part.'; exit 0; fi
      pnpm test:integration --files "${files[@]}"
    else
      FILES="$(node scripts/ci-files.mjs "${SLICE:-}")"
      # shellcheck disable=SC2086 # the partition's files are separate arguments
      pnpm test:integration ${SLICE:+--files $FILES}
    fi ;;
  *) echo "Unknown suite $SUITE"; exit 2 ;;
esac
