"""Truncation (spec 5.5) and pages (spec 5.6) of the cleaned paragraphs."""

from collections.abc import Sequence

MARKER = "[…]"


def count_words(text: str) -> int:
    """The whitespace-separated tokens of `text`, the `[…]` marker excluded.

    Cleaning removes every bracketed annotation, so the marker cannot be a word of
    the transcript itself.
    """
    return sum(1 for word in text.split() if word != MARKER)


def _regroup(words: Sequence[tuple[int, str]]) -> list[str]:
    """Joins (paragraph index, word) pairs back into paragraphs."""
    result: list[str] = []
    previous: int | None = None
    for index, word in words:
        if index == previous:
            result[-1] += f" {word}"
        else:
            result.append(word)
            previous = index
    return result


def truncate(paragraphs: Sequence[str], max_words: int) -> tuple[list[str], bool]:
    """The paragraphs, and whether they were truncated to `max_words` words.

    Beyond `max_words` words, keeps the first and the last `max_words // 2` words with
    the paragraph breaks inside them, and puts a `[…]` paragraph between the two parts.
    """
    words = [
        (index, word)
        for index, paragraph in enumerate(paragraphs)
        for word in paragraph.split()
    ]
    if len(words) <= max_words:
        return list(paragraphs), False
    half = max_words // 2
    head = words[:half]
    tail = words[len(words) - half :]
    return [*_regroup(head), MARKER, *_regroup(tail)], True


def paginate(paragraphs: Sequence[str], page_words: int) -> list[str]:
    """Pages of at most `page_words` words, each paragraphs joined by `\\n\\n`.

    Whole paragraphs are added to the current page while it stays within the limit;
    otherwise the paragraph starts a new page. A paragraph longer than `page_words` on
    its own is cut at word boundaries into pages of `page_words` words, its last piece
    staying open for the next paragraphs. No page is empty.
    """
    pages: list[list[str]] = []
    current: list[str] = []
    current_words = 0
    for paragraph in paragraphs:
        words = count_words(paragraph)
        if current and current_words + words > page_words:
            pages.append(current)
            current, current_words = [], 0
        if words <= page_words:
            current.append(paragraph)
            current_words += words
            continue
        tokens = paragraph.split()
        pieces = [
            tokens[start : start + page_words]
            for start in range(0, len(tokens), page_words)
        ]
        pages.extend([" ".join(piece)] for piece in pieces[:-1])
        current, current_words = [" ".join(pieces[-1])], len(pieces[-1])
    if current:
        pages.append(current)
    return ["\n\n".join(page) for page in pages]
