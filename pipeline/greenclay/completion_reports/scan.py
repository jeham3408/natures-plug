"""Scan the split uncompressed tar in order, reading only JSON member payloads."""

import bisect
import csv
import importlib.util
import io
import itertools
import json
import os
import re
import sys
import tarfile
import types
from collections import Counter
from contextlib import ExitStack
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from paths import APP, OUT, data_dir


class SplitTar(io.RawIOBase):
    """Expose one logical offset across all parts, including split JSON members."""

    def __init__(self, paths, stack):
        self.files = [stack.enter_context(p.open("rb", buffering=0)) for p in paths]
        self.bounds = [0, *itertools.accumulate(p.stat().st_size for p in paths)]
        self.position = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        base = (0, self.position, self.bounds[-1])[whence]
        self.position = base + offset
        return self.position

    def readinto(self, buffer):
        view = memoryview(buffer)
        done = 0
        while done < len(view) and self.position < self.bounds[-1]:
            i = bisect.bisect_right(self.bounds, self.position) - 1
            self.files[i].seek(self.position - self.bounds[i])
            size = min(len(view) - done, self.bounds[i + 1] - self.position)
            count = self.files[i].readinto(view[done : done + size])
            if count != size:
                raise EOFError("Short read in archive part")
            done += count
            self.position += count
        return done


def load_reader():
    # Storage and nearest-formation annotations do not enter marker selection.
    if "FRHEG_REPO" not in os.environ:
        raise SystemExit("Set FRHEG_REPO to a checkout of frheg/hackathon-force.")
    path = Path(os.environ["FRHEG_REPO"]) / "app/sketches/greenclay.py"
    spec = importlib.util.spec_from_file_location("fredric_greenclay", path)
    reader = importlib.util.module_from_spec(spec)
    storage_modules = {
        "duckdb": types.ModuleType("duckdb"),
        "pandas": types.ModuleType("pandas"),
        "common": types.SimpleNamespace(DATA_DIR=OUT, norm=None, save_json=None),
    }
    with patch.dict(sys.modules, storage_modules), patch.object(sys, "dont_write_bytecode", True):
        spec.loader.exec_module(reader)
    pattern = re.compile(r"\b(" + "|".join(map(re.escape, reader.DISTINCT)) + r")\b")
    reader.formation_regex = lambda: pattern
    return reader


def norm(name):
    name = re.sub(r"^\s*NO\s+", "", name.upper()).strip()
    return re.sub(r"\s+", " ", re.sub(r"\s*-\s*", "-", name))


def parts():
    return [data_dir() / "completion_reports" / f"reports.tar.part{i:03}" for i in range(1, 5)]


def document(payload):
    data = json.loads(payload)
    return data if "pages" in data else next(iter(data.values()))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    reader = load_reader()
    necessary = re.compile(r"green\s*clay", re.IGNORECASE)
    with (APP / "pipeline/greenclay/gc_picks.csv").open() as f:
        ours = {norm(r["wellbore"]) for r in csv.DictReader(f)}
    layer = json.loads((APP / "data/layer1.json").read_text())
    eligible = {
        norm(w["n"]) for w in layer if w.get("ho") and w.get("ro") and re.search(r"\d$", w["n"])
    } - ours
    counts = Counter()
    with ExitStack() as stack:
        stream = SplitTar(parts(), stack)
        tar = stack.enter_context(tarfile.open(fileobj=stream, mode="r:"))
        files = stack.enter_context((OUT / "members.jsonl").open("w"))
        marks = stack.enter_context((OUT / "markers.jsonl").open("w"))
        for member in tar:
            path = PurePosixPath(member.name)
            if member.isfile() and path.suffix.lower() == ".json":
                well = norm(path.parent.parent.name.replace("_", "/", 1).replace("_", " "))
                report = document(tar.extractfile(member).read())
                pages = report["pages"]
                print(
                    json.dumps([well, member.name, member.offset_data, member.size, len(pages)]),
                    file=files,
                )
                counts["json"] += 1
                counts["pages"] += len(pages)
                for page in pages:
                    text = (page.get("OCR") or {}).get("ocr_markdown") or ""
                    if not necessary.search(text):
                        continue
                    labels, _ = reader.extract_page(text)
                    for label in labels:
                        if label["kind"] != "green clay" or not label["marker"]:
                            continue
                        print(
                            json.dumps(
                                dict(
                                    well=well,
                                    file=member.name,
                                    page=page["page_no"],
                                    eligible=well in eligible,
                                    **label,
                                )
                            ),
                            file=marks,
                        )
                        counts["marker_occurrences"] += 1
                if counts["json"] % 500 == 0:
                    print(dict(counts), flush=True)
            # Skip PDF payloads and tar padding; the next read is a member header.
            stream.seek(tar.offset)
    (OUT / "scan_counts.json").write_text(json.dumps(counts, indent=2) + "\n")
    print(dict(counts))


if __name__ == "__main__":
    main()
