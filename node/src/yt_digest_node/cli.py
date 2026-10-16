"""The `yt-digest-node` command (spec 5): `transcript <video_id>`, run end to end."""

import argparse
import os
import re
import sys
from collections.abc import Sequence

from yt_digest_node import __version__
from yt_digest_node.contracts.log_event import LogEventName
from yt_digest_node.extractor import extractor_from_env
from yt_digest_node.log import emit
from yt_digest_node.pipeline import config_from_env, parse_langs, transcript

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _video_id(value: str) -> str:
    if not VIDEO_ID.match(value):
        raise argparse.ArgumentTypeError(f"invalid video id: {value!r}")
    return value


def _langs(value: str) -> tuple[str, ...]:
    try:
        return parse_langs(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="yt-digest-node")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser(
        "transcript", help="print the transcript result of a video as JSON"
    )
    command.add_argument("video_id", type=_video_id)
    command.add_argument(
        "--langs", type=_langs, help="language order, comma-separated (e.g. fr,en)"
    )
    command.add_argument("--request-id", help="request id carried by the log lines")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Exit 0 with a result on stdout whatever its status; 2 on a bad argument or an
    invalid configuration, without a result."""
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        config = config_from_env(os.environ)
        extractor = extractor_from_env(os.environ)
    except ValueError as error:
        parser.error(str(error))
    emit(LogEventName.SERVICE_STARTED, attrs={"version": __version__})
    result = transcript(
        args.video_id, args.langs or config.langs, config, extractor, args.request_id
    )
    print(result.model_dump_json(), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
