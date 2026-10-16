# Working on yt-digest

- `spec/` is the only source: build exactly what it says, nothing more. Never edit `spec/`.
- Never edit `.github/workflows/`. The CI runs the jobs listed in `ci/jobs.json`; change that file instead.
- Checks: `./scripts/check.sh <name>` (`lint`, `contracts`, `test-node`, `test-worker`) or `./scripts/check.sh all`. All of them pass before every commit.
- A choice the spec leaves open is taken as the simplest design that meets it and written down in `docs/decisions.md` (one dated line each).
- English in code, comments, commits and docs.
