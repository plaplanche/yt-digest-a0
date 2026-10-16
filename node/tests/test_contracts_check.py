"""`./scripts/contracts.sh --check`, run on a copy of the repository."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PY_MODEL = "node/src/yt_digest_node/contracts/transcript_result.py"
TS_TYPES = "worker/src/contracts/transcript-result.ts"
SCHEMA = "contracts/transcript-result.schema.json"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A copy of what `contracts.sh` reads and writes, with the committed files."""
    copy = tmp_path / "repo"
    for path in ["contracts", "scripts", "worker/src/contracts", "node/src"]:
        shutil.copytree(
            ROOT / path, copy / path, ignore=shutil.ignore_patterns("__pycache__")
        )
    for path in ["node/pyproject.toml", "node/uv.lock", "node/.python-version"]:
        shutil.copy(ROOT / path, copy / path)
    return copy


def check(repo: Path) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    return subprocess.run(
        ["./scripts/contracts.sh", "--check"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def edit(repo: Path, path: str, old: str, new: str) -> None:
    target = repo / path
    text = target.read_text()
    assert old in text
    target.write_text(text.replace(old, new, 1))


def test_the_committed_files_pass(repo: Path) -> None:
    result = check(repo)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("path", [PY_MODEL, TS_TYPES])
def test_a_generated_file_edited_by_hand_fails(repo: Path, path: str) -> None:
    edit(repo, path, "pages", "paragraphs")
    result = check(repo)
    assert result.returncode == 1
    assert path in result.stderr


def test_a_schema_changed_without_regeneration_fails(repo: Path) -> None:
    edit(repo, SCHEMA, '"blocked"', '"blocked", "throttled"')
    result = check(repo)
    assert result.returncode == 1
    assert PY_MODEL in result.stderr
    assert TS_TYPES in result.stderr
    assert "log_event" not in result.stderr


def test_a_removed_generated_file_fails(repo: Path) -> None:
    (repo / TS_TYPES).unlink()
    result = check(repo)
    assert result.returncode == 1
    assert TS_TYPES in result.stderr
