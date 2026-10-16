# Decisions

Choices the spec leaves open, one dated line each.

- 2026-10-16: `node/` builds with `uv_build`, pins Python 3.12 through `requires-python = ">=3.12,<3.13"` and `.python-version`, and keeps ruff, mypy and pytest in the `dev` dependency group, unpinned in `pyproject.toml` and pinned by `uv.lock`.
- 2026-10-16: ruff uses its default formatter settings and the rule sets `E`, `F`, `W`, `I`, `B`, `UP`; mypy runs as `mypy --strict src tests` with no extra configuration.
- 2026-10-16: `worker/` is an ES module package checked by `tsc --noEmit` (`strict: true`, `moduleResolution: Bundler`), linted with ESLint's flat config (`@eslint/js` recommended plus `typescript-eslint` strict) and tested with `vitest run`; TypeScript is the latest version `typescript-eslint` accepts as a peer.
- 2026-10-16: the placeholder tests check that each package exposes its version (`yt_digest_node.__version__`, `VERSION` in `worker/src/index.ts`), which `service.started` will log.
- 2026-10-16: shellcheck runs pinned as `uvx --from shellcheck-py==0.11.0.1 shellcheck` on every `*.sh` file under `scripts/`, found with `find`.
- 2026-10-16: the `contracts` check passes with a message while `scripts/contracts.sh` does not exist.
- 2026-10-16: the contract code is produced by `scripts/contracts_gen.py`, a stdlib-only generator run with the node project's Python, which supports only the JSON Schema keywords the contracts use and fails on any other; the Python output is then formatted with `ruff format`.
- 2026-10-16: an enum with a `title` (only the log catalogue, `LogEventName`) becomes a Python `StrEnum` and a TypeScript `as const` array with its union type; other enums become `Literal` types and inline unions.
- 2026-10-16: each generated TypeScript file also holds a `parse<Title>(value: unknown)` function that throws on a value the schema rejects, since TypeScript types alone cannot check patterns or ranges at runtime; Pydantic models use strict scalar fields and `extra="forbid"`, and an optional non-nullable field rejects null.
- 2026-10-16: the schemas encode only the field types and constraints of 4.1 and 4.2: the "null unless `ok`" rules of the transcript result and the attributes of each log event are left to the code that produces them.
- 2026-10-16: the log `video_id` is a plain string (4.2 gives it no pattern); `ts` is checked by the pattern `YYYY-MM-DDTHH:MM:SS.mmmZ`.
- 2026-10-16: `--check` names every stale, missing or extra generated file (ignoring `__pycache__`); its test runs it on a copy of the repository.
- 2026-10-16: `emit` sets `ts` and `service`, defaults `attrs` to `{}`, raises `ValueError` when `ts` or `service` is given, and omits absent optional fields; `log(event, fields)` takes `level`, `request_id`, `video_id` and `attrs` and writes with `console.log`.
- 2026-10-16: ruff ignores `E501` in the generated `contracts/` package, whose header and docstrings come from the schemas.
