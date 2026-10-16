from pathlib import Path

import pytest

from yt_digest_node.cleaning import Cue, clean_line, paragraphs, parse_vtt

FIXTURES = Path(__file__).parent / "fixtures" / "vtt"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# Step 1: parsing.


def test_parse_ignores_header_note_style_region_identifiers_and_settings() -> None:
    assert parse_vtt(fixture("manual.vtt")) == [
        Cue(1.0, 3.5, ("<v Alice>Welcome to the show.</v>",)),
        Cue(4.0, 6.0, ("Today we talk about <i>rivers</i>", "and <b>lakes</b>.")),
        Cue(7.9, 9.0, ("<u>This starts</u> after a 1.9 s gap.",)),
        Cue(11.0, 12.5, ("This starts after a 2.0 s gap.",)),
        Cue(3600.0, 3601.25, ("One hour in.",)),
    ]


def test_parse_keeps_blank_looking_lines_of_auto_tracks() -> None:
    cues = parse_vtt(fixture("auto.vtt"))
    assert len(cues) == 7
    assert cues[0] == Cue(
        0.0,
        2.31,
        (" ", "hello<00:00:00.480><c> everyone</c><00:00:00.960><c> and</c>"),
    )
    assert cues[1] == Cue(2.31, 2.32, ("hello everyone and", " "))


def test_parse_accepts_crlf_bom_and_timestamps_without_hours() -> None:
    text = "﻿WEBVTT\r\n\r\nid\r\n00:01.000 --> 01:02.500 align:start\r\nhi\r\n"
    assert parse_vtt(text) == [Cue(1.0, 62.5, ("hi",))]


def test_parse_skips_blocks_without_a_timing_line() -> None:
    text = "WEBVTT\n\nnot a cue\n\n00:00:01.000 --> 00:00:02.000\nok\n"
    assert parse_vtt(text) == [Cue(1.0, 2.0, ("ok",))]


# Step 3: cleaning each line.


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("<v Alice>Welcome</v>", "Welcome"),
        ("<i>a</i> <b>b</b> <u>c</u>", "a b c"),
        (
            "hello<00:00:00.480><c> everyone</c><c.colorE5E5E5> and</c>",
            "hello everyone and",
        ),
        ("Tom &amp; Jerry &quot;x&quot; &#39;y&#39;", "Tom & Jerry \"x\" 'y'"),
        ("&lt;3", "<3"),
        ("[Musique] a [Applause] b [Rires]", "a b"),
        ("  a \t  b  ", "a b"),
        ("a&nbsp;b", "a b"),
    ],
)
def test_clean_line(raw: str, clean: str) -> None:
    assert clean_line(raw) == clean


# Steps 3 to 5 on the fixtures.


def test_manual_track_paragraphs_break_at_2_0_s_not_1_9_s() -> None:
    assert paragraphs(parse_vtt(fixture("manual.vtt")), []) == [
        "Welcome to the show. Today we talk about rivers and lakes. "
        "This starts after a 1.9 s gap.",
        "This starts after a 2.0 s gap.",
        "One hour in.",
    ]


def test_auto_track_drops_rolling_duplicates_and_inline_timestamps() -> None:
    assert paragraphs(parse_vtt(fixture("auto.vtt")), []) == [
        "hello everyone and welcome to the show today we cook",
        "pasta tonight",
    ]


def test_annotations_and_entities() -> None:
    assert paragraphs(parse_vtt(fixture("annotations.vtt")), []) == [
        'Tom & Jerry are "back" Fish & chips <3 That\'s all, folks!'
    ]


# Steps 4 and 5 on hand-made cues.


def test_drops_empty_lines_and_a_line_equal_to_the_previous_kept_line() -> None:
    cues = [
        Cue(0.0, 1.0, ("a", "", "[Music]", "a", "b")),
        Cue(1.0, 2.0, ("<c>b</c>", "a")),
    ]
    assert paragraphs(cues, []) == ["a b a"]


def test_gap_is_measured_from_the_last_kept_cue() -> None:
    cues = [
        Cue(0.0, 1.0, ("a",)),
        Cue(1.5, 2.0, ("[Music]",)),
        Cue(3.0, 4.0, ("b",)),
    ]
    assert paragraphs(cues, []) == ["a", "b"]


def test_gap_threshold_is_exact_despite_float_rounding() -> None:
    cues = [Cue(0.0, 0.01, ("a",)), Cue(2.01, 3.0, ("b",))]
    assert 2.01 - 0.01 < 2.0
    assert paragraphs(cues, []) == ["a", "b"]


def test_no_cues_gives_no_paragraph() -> None:
    assert paragraphs([], []) == []


# Step 2: sponsor cuts by the cue midpoint.


def test_a_cue_whose_midpoint_is_a_segment_start_is_dropped() -> None:
    cues = [Cue(9.0, 11.0, ("a",)), Cue(11.0, 12.0, ("b",))]
    assert paragraphs(cues, [(10.0, 20.0)]) == []


def test_a_cue_whose_midpoint_is_a_segment_end_is_kept() -> None:
    cues = [Cue(9.0, 10.0, ("a",)), Cue(19.0, 21.0, ("b",))]
    assert paragraphs(cues, [(10.0, 20.0)]) == ["a", "b"]


def test_a_cue_overlapping_a_segment_with_its_midpoint_outside_is_kept() -> None:
    cues = [Cue(8.0, 11.0, ("a",)), Cue(11.0, 13.0, ("b",))]
    assert paragraphs(cues, [(10.0, 12.5)]) == ["a"]


def test_a_dropped_cue_does_not_count_as_the_previous_kept_line() -> None:
    cues = [Cue(0.0, 1.0, ("a",)), Cue(1.0, 2.0, ("b",)), Cue(2.0, 3.0, ("a",))]
    assert paragraphs(cues, []) == ["a b a"]
    assert paragraphs(cues, [(1.0, 2.0)]) == ["a"]


def test_the_gap_is_measured_over_a_dropped_cue() -> None:
    cues = [Cue(0.0, 1.0, ("a",)), Cue(1.0, 3.0, ("b",)), Cue(3.0, 4.0, ("c",))]
    assert paragraphs(cues, [(1.5, 2.5)]) == ["a", "c"]
