#!/usr/bin/env bash
# Run every e2e suite in scripts/test-*.ts against DATABASE_URL.
# Exits non-zero if any suite fails.
set -uo pipefail

failed=()
for suite in scripts/test-*.ts; do
  echo "== $suite"
  if ! npx tsx "$suite"; then
    failed+=("$suite")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All e2e suites passed."
