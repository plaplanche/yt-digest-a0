"""Transcript cleaning (spec 5.4): from VTT text to paragraphs of clean text."""

import html
import re
from collections.abc import Sequence
from dataclasses import dataclass

TIMESTAMP = r"(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})"
TIMING_LINE = re.compile(rf"^\s*{TIMESTAMP}\s+-->\s+{TIMESTAMP}(?:\s.*)?$")
IGNORED_BLOCKS = re.compile(r"^(?:NOTE|STYLE|REGION)(?:[ \t]|$)")
INLINE_TAG = re.compile(r"<[^>]*>")
ANNOTATION = re.compile(r"\[[^\]]*\]")
WHITESPACE = re.compile(r"\s+")
PARAGRAPH_GAP_MS = 2000


@dataclass(frozen=True)
class Cue:
    """One VTT cue: start and end in seconds, and its raw text lines."""

    start: float
    end: float
    lines: tuple[str, ...]


def _ms(hours: str | None, minutes: str, seconds: str, millis: str) -> int:
    return ((int(hours or 0) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(
        millis
    )


def _parse_block(block: list[str]) -> Cue | None:
    if IGNORED_BLOCKS.match(block[0]):
        return None
    for index, line in enumerate(block[:2]):
        timing = TIMING_LINE.match(line)
        if timing:
            groups = timing.groups()
            start = _ms(*groups[:4]) / 1000
            end = _ms(*groups[4:]) / 1000
            return Cue(start, end, tuple(block[index + 1 :]))
    return None


def parse_vtt(text: str) -> list[Cue]:
    """Parses VTT text into cues (step 1).

    The header, `NOTE`, `STYLE` and `REGION` blocks, cue identifiers and cue settings
    are ignored, as is any block without a valid timing line. Blocks are separated by
    empty lines; a line holding only spaces is a (blank) text line of its cue.
    """
    lines = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[list[str]] = [[]]
    for line in lines:
        if line == "":
            if blocks[-1]:
                blocks.append([])
        else:
            blocks[-1].append(line)
    cues: list[Cue] = []
    for number, block in enumerate(blocks):
        if not block or (number == 0 and block[0].startswith("WEBVTT")):
            continue
        cue = _parse_block(block)
        if cue is not None:
            cues.append(cue)
    return cues


def clean_line(line: str) -> str:
    """Cleans one text line (step 3)."""
    line = INLINE_TAG.sub("", line)
    line = html.unescape(line)
    line = ANNOTATION.sub("", line)
    return WHITESPACE.sub(" ", line).strip()


def paragraphs(
    cues: Sequence[Cue], segments: Sequence[tuple[float, float]]
) -> list[str]:
    """Returns the paragraphs of clean text of the cues (steps 2 to 5).

    `segments` are the SponsorBlock segments (start, end) in seconds. Step 2 (sponsor
    cuts) is not applied yet: it comes with the SponsorBlock work, and `segments` is
    empty until then. A cue is kept when at least one of its lines is kept.
    """
    result: list[list[str]] = []
    previous_line: str | None = None
    previous_end_ms: int | None = None
    for cue in cues:
        kept: list[str] = []
        for raw in cue.lines:
            line = clean_line(raw)
            if line and line != previous_line:
                kept.append(line)
                previous_line = line
        if not kept:
            continue
        start_ms = round(cue.start * 1000)
        if previous_end_ms is None or start_ms - previous_end_ms >= PARAGRAPH_GAP_MS:
            result.append([])
        result[-1].extend(kept)
        previous_end_ms = round(cue.end * 1000)
    return [" ".join(paragraph) for paragraph in result]
