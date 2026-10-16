# Working on yt-digest

- `spec/` is the only source: build exactly what it says, nothing more. Never edit `spec/`. Lot 2 (`spec/lot-2.md`) builds on lot 1 (`spec/lot-1.md`), which still applies.
- Never edit `.github/workflows/` or `scripts/check.sh`. The CI runs the jobs listed in `ci/jobs.json`; change that file instead.
- Checks: `./scripts/check.sh <name>` (`lint`, `contracts`, `test-node`, `test-worker`, `e2e`) or `./scripts/check.sh all`. All of them pass before every commit.
- The local stack (Worker, local D1 and R2, mocks server) starts with `./scripts/stack.sh up` and stops with `./scripts/stack.sh down`. Always run `./scripts/stack.sh down` before finishing.
- A choice the spec leaves open is taken as the simplest design that meets it and written down in `docs/decisions.md` (one dated line each).
- English in code, comments, commits and docs.
