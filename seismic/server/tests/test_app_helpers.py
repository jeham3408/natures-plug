"""Runs the pure-function checks of the web page (tests/check_app.js) when node is available."""
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_app_js_helpers():
    app = os.path.join(ROOT, "..", "app.js")
    assert subprocess.run(["node", "--check", app], capture_output=True, timeout=60).returncode == 0
    r = subprocess.run(["node", os.path.join(ROOT, "tests", "check_app.js")], capture_output=True, timeout=60)
    assert r.returncode == 0, r.stderr.decode()[-2000:]
    assert b"all checks passed" in r.stdout
