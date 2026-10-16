# yt-digest, lot 1: foundations and the transcript pipeline

This is the frozen specification of lot 1. It is derived from `DESIGN.md` (v5.1, sections 5.3, 11, 12, 18.3, 19.1, 19.2 and milestones M0 and M1) and fixes every choice the design leaves open, so that every attempt builds the same thing. When this file and the design disagree, this file wins. Anything this file does not cover is out of scope for lot 1.

## 1. Goal

A monorepo with its own checks and CI, shared contracts generated for Python and TypeScript, and the node's transcript pipeline: from a video id to a cleaned, sponsor-free, truncated and paginated transcript, driven from the command line. Nothing calls YouTube, Google or Cloudflare: subtitles come from a fake extractor that reads fixture files, and SponsorBlock is reached at a configurable URL.

Out of scope for lot 1: the Worker's HTTP and MCP surface, D1, R2, OAuth, the node ↔ Worker protocol, the node daemon and `/health`, containers, deployment, infrastructure, Playwright.

## 2. Repository layout

| Path | Content |
| --- | --- |
| `contracts/` | JSON Schema files, the single source of shared shapes (section 4) |
| `node/` | Python 3.12 package `yt_digest_node`, managed with `uv` (`node/pyproject.toml`, `node/uv.lock`) |
| `worker/` | TypeScript package (Node 22, npm, `worker/package.json`, `worker/package-lock.json`), strict mode |
| `scripts/` | `check.sh` and the scripts it calls; `contracts.sh` (section 4.3) |
| `ci/jobs.json` | The CI jobs (section 3.2) |
| `spec/` | This specification; never edited by an attempt |
| `CLAUDE.md` | Working rules for agents, including the checks |

## 3. Checks and CI

### 3.1 Checks

`./scripts/check.sh <name>` runs one check and exits non-zero when it fails; `./scripts/check.sh all` runs them all in this order and stops at the first failure. `check.sh` is provided and is not edited: it runs `scripts/checks/<name>.sh`, and skips a check whose script does not exist yet; lot 1 writes the four scripts. Every check runs from the repository root on Linux with only `uv`, Node 22 and npm installed beforehand (each check installs its own dependencies, for example `uv sync --locked` or `npm ci`).

| Name | What it runs |
| --- | --- |
| `lint` | Python: `ruff check`, `ruff format --check`, `mypy --strict` on `node/`. TypeScript: `tsc --noEmit`, ESLint on `worker/`. Shell: `shellcheck` on `scripts/**/*.sh`, run as `uvx --from shellcheck-py shellcheck` so that only uv is needed |
| `contracts` | `./scripts/contracts.sh --check` (section 4.3) |
| `test-node` | `pytest` on `node/tests/` |
| `test-worker` | Vitest on `worker/` |

### 3.2 CI

The workflow `.github/workflows/ci.yml` is fixed and must not be edited. It runs, on every pull request and every push to `main`, one job per entry of `ci/jobs.json`: `[{"name": "...", "run": "<bash command>"}, ...]`, with optional `os` (default `ubuntu-latest`), `node` (default `22`) and `python` (default `3.12`). Lot 1's `ci/jobs.json` has one job per check of 3.1, each running `./scripts/check.sh <name>`.

## 4. Contracts

### 4.1 Transcript result: `contracts/transcript-result.schema.json`

The output of the pipeline (section 5) and, in later lots, the payload the node sends to the Worker.

| Field | Type | Rule |
| --- | --- | --- |
| `video_id` | string | `^[A-Za-z0-9_-]{11}$` |
| `status` | enum | `ok`, `no_transcript`, `unavailable`, `blocked` |
| `lang` | string or null | the language of the chosen track; null unless `ok` |
| `source` | enum or null | `manual` or `auto`; null unless `ok` |
| `word_count` | integer ≥ 0 | words of all pages together (section 5.6); 0 unless `ok` |
| `truncated` | boolean | section 5.5; false unless `ok` |
| `sponsor_ratio` | number in [0, 1] or null | section 5.3; null when the status is not `ok`, and when SponsorBlock failed |
| `pages` | array of strings | section 5.6; empty unless `ok` |

No other field is allowed (`additionalProperties: false`).

### 4.2 Log events: `contracts/log-event.schema.json`

One JSON object per line. Common fields: `ts` (ISO 8601 UTC with milliseconds and `Z`), `level` (`debug`, `info`, `warn`, `error`), `service` (`node` or `worker`), `event`, optional `request_id`, optional `video_id`, `attrs` (object). The catalogue of lot 1 is the enum of `event`:

| Event | Service | `attrs` |
| --- | --- | --- |
| `service.started` | node, worker | `version` |
| `fetch.transcript` | node | `outcome` (the `status`), `source`, `words`, `pages`, `sponsor_ratio`, `sponsorblock` (`ok`, `none`, `error`), `duration_ms` |
| `sponsorblock.call` | node | `status` (HTTP status, or 0 on a network error), `segments`, `duration_ms` |

A log line never contains transcript or subtitle text: only counts, ratios, durations and identifiers.

### 4.3 Generation

`./scripts/contracts.sh` generates, from every schema in `contracts/`, TypeScript types in `worker/src/contracts/` and Pydantic v2 models in `node/src/yt_digest_node/contracts/`, each generated file starting with a line saying it is generated and must not be edited. The log catalogue is generated as a TypeScript union type of the event names and a Python `enum.StrEnum`. `./scripts/contracts.sh --check` regenerates into a temporary directory and exits 1, naming the files, when a committed generated file differs.

### 4.4 Loggers

- Python: `yt_digest_node.log.emit(event, level="info", **fields)` writes one line to standard error, validated against the generated model; an event outside the catalogue, or an unknown field, raises `ValueError`.
- TypeScript: `log(event, fields)` in `worker/src/log.ts`, same rule, enforced by the type system and by a runtime check that throws.

## 5. The transcript pipeline

Package `yt_digest_node`, command `uv run --project node yt-digest-node transcript <video_id> [--langs fr,en] [--request-id ID]`. It prints one transcript result (4.1) as JSON on standard output, logs on standard error (4.2), and exits 0 whatever the `status`; it exits 2 on a bad argument (an invalid video id included) without printing a result.

### 5.1 Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRANSCRIPT_LANGS` | `fr,en` | language order when `--langs` is absent |
| `MAX_WORDS` | `60000` | truncation threshold (5.5) |
| `PAGE_WORDS` | `12000` | page size (5.6) |
| `SPONSORBLOCK_URL` | `https://sponsor.ajay.app` | SponsorBlock base URL |
| `FETCHER_FAKE_YTDLP` | unset | `1` selects the fake extractor (5.2) |
| `FAKE_YTDLP_DIR` | unset | the fixture directory of the fake extractor; required when `FETCHER_FAKE_YTDLP=1` |
| `YT_DELAY_SECONDS` | `2-5` | random delay range before each YouTube request; forced to 0 with the fake extractor |

### 5.2 Extractors and track choice

An extractor returns, for a video id, either a failure (`unavailable` or `blocked`) or the video's duration in seconds and its subtitle tracks (language, `manual` or `auto`, VTT text).

- **Fake extractor** (`FETCHER_FAKE_YTDLP=1`): reads `$FAKE_YTDLP_DIR/<video_id>/`. No such directory: `unavailable`. `meta.json` holds `{"duration": <seconds>}` and may hold `"status": "unavailable"` or `"status": "blocked"`, which is returned as is. Each file `<lang>.<manual|auto>.vtt` is one track.
- **yt-dlp extractor** (default): yt-dlp as a library with `skip_download=True`, `writesubtitles=True`, `writeautomaticsub=True`, `subtitlesformat="vtt"`, without cookies; maps yt-dlp's errors to `unavailable` (private, age-restricted, removed) and `blocked` (bot check). It is never called by tests; unit tests replace yt-dlp with a stub.
- **Choice**: the first track found by trying `manual` tracks in the order of the languages, then `auto` tracks in the same order. No matching track: `no_transcript`.

### 5.3 SponsorBlock

`GET {SPONSORBLOCK_URL}/api/skipSegments?videoID=<id>&categories=["sponsor","selfpromo","interaction"]` (the list URL-encoded), timeout 10 s. 200: a JSON array whose items carry `segment: [start, end]` in seconds. 404: no segments. Anything else, or a network error: no segments, `sponsor_ratio` null, `attrs.sponsorblock` = `error`, and the result is otherwise produced normally. Each call logs `sponsorblock.call`.

`sponsor_ratio` = length of the union of the segments, clipped to [0, duration], divided by the duration, rounded to 3 decimals; 0 when there is no segment.

### 5.4 Cleaning

1. Parse the VTT into cues (start, end, text lines); ignore the header, `NOTE`, `STYLE` and `REGION` blocks and cue settings.
2. Drop every cue whose midpoint ((start + end) / 2) lies in a SponsorBlock segment (start inclusive, end exclusive).
3. In each line: remove inline tags (`<c>`, `</c>`, `<c.color>`, inline timestamps such as `<00:00:01.500>`, `<i>`, `<b>`, `<u>`, voice tags), decode HTML entities, remove every bracketed annotation `[…]` (for example `[Musique]`, `[Applause]`), collapse whitespace, trim.
4. Drop empty lines, and drop a line equal to the line kept just before it (rolling-caption duplicates).
5. Paragraphs: a new paragraph starts when the gap between the end of the previous kept cue and the start of the next kept cue is at least 2.0 s. Lines of a paragraph are joined with one space; paragraphs with one blank line (`\n\n`).

### 5.5 Truncation

Words are the whitespace-separated tokens of the cleaned text. When the count exceeds `MAX_WORDS`, keep the first `MAX_WORDS // 2` words and the last `MAX_WORDS // 2` words, keeping the paragraph breaks that fall inside them, put a paragraph `[…]` between the two parts, and set `truncated` to true. The marker is not a word.

### 5.6 Pages

Split the paragraphs into pages of at most `PAGE_WORDS` words: add whole paragraphs to the current page while it stays within the limit; a paragraph longer than `PAGE_WORDS` on its own is cut at word boundaries. Pages hold their paragraphs joined by `\n\n`. No page is empty. `word_count` is the sum of the words of the pages, the `[…]` marker excluded. Reading the pages in order gives back the words of the cleaned (and truncated) text in order, and joining them with `\n\n` gives back the text itself when no paragraph had to be cut.

### 5.7 Logging

One `fetch.transcript` line per command, with the attributes of 4.2, `video_id` and the `request_id` given with `--request-id`. A `service.started` line first, with the package version.

## 6. Quality bar

- Python: `mypy --strict` clean; no network in unit tests; fixtures under `node/tests/fixtures/`.
- TypeScript: `strict: true`; no `any` in generated or written code.
- Every rule of section 5 is covered by a test that fails without it.
- `CLAUDE.md` lists the checks of 3.1 and the rule that `spec/` and `.github/workflows/` are never edited.
