"""Tests for the robustness findings of the review: abandoned requests, dead sessions, protocol corners."""
import http.client
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

import pytest

import server as sv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(live, path, headers=None, method="GET"):
    conn = http.client.HTTPConnection(live[0], live[1], timeout=30)
    try:
        conn.request(method, path, headers=headers or {})
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        conn.close()


# ------------------------------------------------------------------ abandoned requests
def test_engine_drops_work_for_a_client_that_left(live, synth):
    eng = live[2].RequestHandlerClass.engine
    q = {"t": ["2104"], "attr": ["env"], "flo": ["11"], "fhi": ["37"]}
    with pytest.raises(sv.ClientGone):
        eng.image("slice", q, gone=lambda: True)
    body, ctype, info = eng.image("slice", q, gone=lambda: False)
    assert info["cached"] is False and len(body) > 100        # nothing was cached by the abandoned attempt


def test_queued_request_of_a_closed_connection_is_abandoned(live, synth):
    """A heavy request waiting for a slot must not be computed after its client has gone,
    and a live request behind it reports the wait as queued_ms, not as compute time."""
    eng = live[2].RequestHandlerClass.engine
    eng._heavy.acquire()
    eng._heavy.acquire()                                       # both slots busy
    released = False
    try:
        before = eng.abandoned
        s = socket.create_connection((live[0], live[1]), timeout=10)
        s.sendall(b"GET /api/slice?t=2212&attr=env&flo=9&fhi=41 HTTP/1.1\r\nHost: x\r\n\r\n")
        time.sleep(0.3)                                        # the request is now queued
        assert eng.abandoned == before
        s.close()                                              # ... and its client leaves
        deadline = time.time() + 5
        while eng.abandoned == before and time.time() < deadline:
            time.sleep(0.02)
        assert eng.abandoned == before + 1                     # dropped while the slots were still busy

        result = {}

        def fetch():
            result["r"] = _get(live, "/api/slice?t=2216&attr=env&flo=9&fhi=41&fmt=png")
        th = threading.Thread(target=fetch)
        th.start()
        time.sleep(0.4)
        eng._heavy.release()
        eng._heavy.release()
        released = True
        th.join(timeout=30)
        status, hdr, _ = result["r"]
        info = json.loads(hdr["x-sv-info"])
        assert status == 200 and info["queued_ms"] >= 300.0
        assert info["ms"] < info["queued_ms"]                  # "ms" is compute time only
    finally:
        if not released:
            eng._heavy.release()
            eng._heavy.release()


# ------------------------------------------------------------------ protocol corners
def test_reset_connections_leave_no_traceback(live, capfd):
    linger = struct.pack("ii", 1, 0)                           # close() sends RST
    for payload in (b"GET /api/section?kind=zz HTTP/1.1\r\nHost: x\r\n\r\n", b""):
        for _ in range(8):
            s = socket.create_connection((live[0], live[1]), timeout=10)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
            if payload:
                s.sendall(payload)
            s.close()
    time.sleep(0.5)
    assert _get(live, "/api/health")[0] == 200
    err = capfd.readouterr().err
    assert "Traceback" not in err and "Exception" not in err, err[-600:]


def test_bad_content_length_gets_an_answer(live):
    with socket.create_connection((live[0], live[1]), timeout=10) as s:
        s.sendall(b"POST /api/health HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n")
        data = s.recv(65536)
    assert data.startswith(b"HTTP/1.1 405"), data[:80]


def test_gzip_q0_is_respected(live):
    for value, expect in (("gzip;q=0", False), ("gzip; q=0.0, identity", False), ("identity", False),
                          ("gzip;q=0.5", True), ("br, gzip", True), ("*", True), ("*;q=0", False)):
        hdr = _get(live, "/api/meta", headers={"Accept-Encoding": value})[1]
        assert (hdr.get("content-encoding") == "gzip") is expect, value


def test_error_message_for_absurd_line_number_is_short(live):
    status, _, body = _get(live, "/api/section?kind=il&line=1e300")
    assert status == 400 and len(body) < 200


# ------------------------------------------------------------------ process level
def _start(synth, web_dir, port, **popen):
    return subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--data", synth.dir,
                             "--port", str(port), "--web", web_dir], cwd="/", **popen)


def _wait_up(proc, port):
    deadline = time.time() + 30
    while time.time() < deadline and proc.poll() is None:
        try:
            if _get(("127.0.0.1", port), "/api/health")[0] == 200:
                return True
        except OSError:
            time.sleep(0.1)
    return False


def test_server_stops_when_its_session_disappears(synth, web_dir):
    """Started without a terminal (as "ssh host python server.py"): when the reader of stdout / stderr
    goes away the server must stop and free the port instead of living on as an orphan."""
    port = _free_port()
    proc = _start(synth, web_dir, port, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert _wait_up(proc, port), "server did not start"
        proc.stdout.close()
        proc.stderr.close()                                    # the session is gone
        assert proc.wait(timeout=10) == 0
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=2).close()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_server_keeps_running_with_output_in_a_file(synth, web_dir, tmp_path):
    """nohup-style start (output to a file) must NOT be mistaken for a dead session."""
    port = _free_port()
    with open(tmp_path / "log.txt", "wb") as log:
        proc = _start(synth, web_dir, port, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    try:
        assert _wait_up(proc, port), "server did not start"
        time.sleep(2.0)
        assert proc.poll() is None and _get(("127.0.0.1", port), "/api/health")[0] == 200
    finally:
        proc.terminate()
        assert proc.wait(timeout=10) == 0


def test_busy_port_gives_one_clear_line(synth, web_dir):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        port = s.getsockname()[1]
        proc = _start(synth, web_dir, port, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = proc.communicate(timeout=30)
    assert proc.returncode != 0
    assert b"already in use" in err and str(port).encode() in err
    assert b"Traceback" not in err and len(err.strip().splitlines()) == 1
