"""Shared fixtures: a freshly generated synthetic dataset and an in-process server."""
import json
import os
import sys
import threading

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import make_synthetic  # noqa: E402
import server as sv    # noqa: E402


class Synth:
    """The synthetic dataset opened directly from disk (independent of the server)."""

    def __init__(self, path):
        self.dir = path
        with open(os.path.join(path, "meta.json")) as fh:
            self.meta = json.load(fh)
        self.ixt = np.load(os.path.join(path, "cube_ixt.npy"), mmap_mode="r")
        self.tix = np.load(os.path.join(path, "cube_tix.npy"), mmap_mode="r")
        self.truth = self.meta["truth"]
        self.dt_s = self.meta["dt_ms"] / 1000.0

    def il_index(self, line):
        return (line - self.meta["il0"]) // self.meta["il_step"]

    def xl_index(self, line):
        return (line - self.meta["xl0"]) // self.meta["xl_step"]

    def t_index(self, t_ms):
        return int(round((t_ms - self.meta["t0_ms"]) / self.meta["dt_ms"]))


@pytest.fixture(scope="session")
def synth(tmp_path_factory):
    out = tmp_path_factory.mktemp("synthetic")
    make_synthetic.main(["--out", str(out)])
    return Synth(str(out))


@pytest.fixture(scope="session")
def web_dir(tmp_path_factory):
    base = tmp_path_factory.mktemp("site")
    web = base / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html><title>test index</title><p>INDEX-MARKER</p>")
    (web / "app.js").write_text("console.log('APP-MARKER');\n" * 60)
    (web / "style.css").write_text("body{margin:0}")
    (base / "secret.txt").write_text("TOP-SECRET-CONTENT")
    try:
        os.symlink(str(base / "secret.txt"), str(web / "link.txt"))
    except OSError:
        pass
    return str(web)


def _run(httpd):
    th = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    th.start()
    return th


@pytest.fixture(scope="session")
def live(synth, web_dir):
    """In-process server on a free port -> (host, port, httpd)."""
    httpd = sv.make_server(synth.dir, 0, web_dir, quiet=True)
    th = _run(httpd)
    yield httpd.server_address[0], httpd.server_address[1], httpd
    httpd.shutdown()
    httpd.server_close()
    th.join(timeout=5)


@pytest.fixture(scope="session")
def live_noweb(synth, tmp_path_factory):
    """Server whose web directory does not exist (placeholder page)."""
    missing = str(tmp_path_factory.mktemp("noweb") / "web")
    httpd = sv.make_server(synth.dir, 0, missing, quiet=True)
    th = _run(httpd)
    yield httpd.server_address[0], httpd.server_address[1], httpd
    httpd.shutdown()
    httpd.server_close()
    th.join(timeout=5)
