from yt_digest_node.pages import MARKER, count_words, paginate, truncate


def numbered(start: int, stop: int) -> str:
    return " ".join(f"w{n}" for n in range(start, stop))


def words_of(pages: list[str]) -> list[str]:
    return [word for page in pages for word in page.split() if word != MARKER]


# Truncation (5.5)


def test_a_text_within_max_words_is_kept_as_is() -> None:
    text = [numbered(0, 6), numbered(6, 10)]
    assert truncate(text, 10) == (text, False)


def test_25_words_with_max_10_keep_the_first_5_and_last_5_around_the_marker() -> None:
    text = [numbered(0, 25)]
    kept, truncated = truncate(text, 10)
    assert truncated
    assert kept == [numbered(0, 5), MARKER, numbered(20, 25)]
    pages = paginate(kept, 12000)
    assert sum(count_words(page) for page in pages) == 10


def test_truncation_keeps_the_paragraph_breaks_inside_the_kept_parts() -> None:
    text = [numbered(0, 3), numbered(3, 12), numbered(12, 22), numbered(22, 25)]
    kept, truncated = truncate(text, 10)
    assert truncated
    assert kept == [
        numbered(0, 3),
        numbered(3, 5),
        MARKER,
        numbered(20, 22),
        numbered(22, 25),
    ]


def test_an_odd_max_words_keeps_max_words_halved_on_each_side() -> None:
    kept, _ = truncate([numbered(0, 25)], 11)
    assert kept == [numbered(0, 5), MARKER, numbered(20, 25)]


def test_the_marker_is_not_a_word() -> None:
    assert count_words(f"a b\n\n{MARKER}\n\nc") == 3


# Pages (5.6)


def test_whole_paragraphs_fill_a_page_within_the_limit() -> None:
    text = [numbered(0, 2), numbered(2, 5), numbered(5, 8), numbered(8, 10)]
    assert paginate(text, 5) == [
        f"{numbered(0, 2)}\n\n{numbered(2, 5)}",
        f"{numbered(5, 8)}\n\n{numbered(8, 10)}",
    ]


def test_a_12_word_paragraph_is_cut_at_word_boundaries() -> None:
    text = [numbered(0, 3), numbered(3, 15), numbered(15, 17)]
    pages = paginate(text, 5)
    assert pages == [
        numbered(0, 3),
        numbered(3, 8),
        numbered(8, 13),
        f"{numbered(13, 15)}\n\n{numbered(15, 17)}",
    ]
    assert all(0 < count_words(page) <= 5 for page in pages)
    assert words_of(pages) == numbered(0, 17).split()


def test_pages_read_in_order_give_back_the_text() -> None:
    text = [numbered(0, 4), numbered(4, 5), numbered(5, 9), numbered(9, 14)]
    pages = paginate(text, 5)
    assert all(0 < count_words(page) <= 5 for page in pages)
    assert words_of(pages) == numbered(0, 14).split()
    assert "\n\n".join(pages) == "\n\n".join(text)


def test_the_marker_takes_no_room_on_a_page() -> None:
    kept, _ = truncate([numbered(0, 3), numbered(3, 20)], 10)
    pages = paginate(kept, 5)
    assert pages == [
        f"{numbered(0, 3)}\n\n{numbered(3, 5)}\n\n{MARKER}",
        numbered(15, 20),
    ]


def test_no_text_gives_no_page() -> None:
    assert paginate([], 5) == []
