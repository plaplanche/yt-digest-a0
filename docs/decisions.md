# Decisions

Choices the spec leaves open, one dated line each.

- 2026-10-16: `node/` builds with `uv_build`, pins Python 3.12 through `requires-python = ">=3.12,<3.13"` and `.python-version`, and keeps ruff, mypy and pytest in the `dev` dependency group, unpinned in `pyproject.toml` and pinned by `uv.lock`.
- 2026-10-16: ruff uses its default formatter settings and the rule sets `E`, `F`, `W`, `I`, `B`, `UP`; mypy runs as `mypy --strict src tests` with no extra configuration.
- 2026-10-16: `worker/` is an ES module package checked by `tsc --noEmit` (`strict: true`, `moduleResolution: Bundler`), linted with ESLint's flat config (`@eslint/js` recommended plus `typescript-eslint` strict) and tested with `vitest run`; TypeScript is the latest version `typescript-eslint` accepts as a peer.
- 2026-10-16: the placeholder tests check that each package exposes its version (`yt_digest_node.__version__`, `VERSION` in `worker/src/index.ts`), which `service.started` will log.
- 2026-10-16: shellcheck runs pinned as `uvx --from shellcheck-py==0.11.0.1 shellcheck` on every `*.sh` file under `scripts/`, found with `find`.
- 2026-10-16: the `contracts` check passes with a message while `scripts/contracts.sh` does not exist.
