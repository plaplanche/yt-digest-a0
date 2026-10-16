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
- 2026-10-16: cleaning lives in `yt_digest_node.cleaning`: `parse_vtt(text) -> list[Cue]` (`Cue(start, end, lines)`, seconds as floats) and `paragraphs(cues, segments) -> list[str]`; step 2 (sponsor cuts) is left to the SponsorBlock ticket, so `segments` is accepted but not applied yet.
- 2026-10-16: VTT blocks are separated by empty lines only (a line of spaces, as in YouTube auto tracks, stays a text line); the first block starting with `WEBVTT` is the header; a block with no timing line in its first two lines is skipped; CRLF and a BOM are accepted; timestamps may omit hours.
- 2026-10-16: every `<…>` is removed as an inline tag, before entities are decoded (so `&lt;3` stays `<3`); a bracketed annotation is `[` up to the next `]`.
- 2026-10-16: a "kept cue" (5.4 step 5) is a cue with at least one kept line; gaps are compared in whole milliseconds, so a 2.0 s gap always starts a paragraph despite float rounding.
- 2026-10-16: the SponsorBlock client is `yt_digest_node.sponsorblock.fetch_segments(video_id, base_url, request_id=None, timeout=10.0) -> SponsorBlockResult(segments, state)`, on the standard library's `urllib` (no new dependency, proxies taken from the environment); the category list is encoded as compact JSON, `["sponsor","selfpromo","interaction"]`, and a trailing `/` of the base URL is dropped.
- 2026-10-16: a 200 whose body is not a JSON array of objects carrying a numeric `segment: [start, end]` counts as `error` (no segments, the log `status` stays 200); a timeout counts as a network error (status 0); `sponsorblock.call` is logged at level `info` whatever the outcome, with the `video_id` and, when given, the `request_id`.
- 2026-10-16: step 2 is applied in `paragraphs` through `in_a_segment(midpoint, segments)`, before steps 3 to 5, so a dropped cue neither counts as the previous kept line nor as the previous kept cue for the paragraph gap.
- 2026-10-16: `sponsor_ratio(segments, duration)` is 0 when the duration is not positive, and a segment clipped to nothing (fully outside [0, duration], or with end ≤ start) is ignored.
