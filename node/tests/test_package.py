import re

import yt_digest_node


def test_version_is_the_package_version() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", yt_digest_node.__version__)
