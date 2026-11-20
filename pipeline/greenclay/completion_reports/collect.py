"""Gather only the OCR pages carrying Fredric's table markers, using saved tar offsets."""

import csv
import json
import re
from collections import defaultdict
from contextlib import ExitStack
from pathlib import Path

from paths import APP, OUT
from scan import SplitTar, document, parts


def main():
    index = OUT
    markers = defaultdict(lambda: defaultdict(set))
    for line in (index / "markers.jsonl").read_text().splitlines():
        m = json.loads(line)
        if m["source_kind"] == "table":
            markers[m["file"]][m["page"]].add(m["snippet"])
    with (APP / "pipeline/greenclay/gc_picks.csv").open() as f:
        key = {r["wellbore"]: float(r["tvd"]) for r in csv.DictReader(f)}
    with ExitStack() as stack:
        stream = SplitTar(parts(), stack)
        pages_file = stack.enter_context((OUT / "pages.jsonl").open("w"))
        rows_file = stack.enter_context((OUT / "rows.jsonl").open("w"))
        for line in (index / "members.jsonl").read_text().splitlines():
            well, file, offset, size, _ = json.loads(line)
            if file not in markers:
                continue
            stream.seek(offset)
            for p in document(stream.read(size))["pages"]:
                num = p["page_no"]
                if num not in markers[file]:
                    continue
                page = p["OCR"]["ocr_markdown"]
                common = {"well": well, "file": Path(file).name, "page": num}
                print(json.dumps(dict(**common, text=page)), file=pages_file)
                found = set()
                lines = page.splitlines()
                for i, line in enumerate(lines):
                    line = line.strip()
                    snippet = re.sub(r"\s+", " ", line.strip("| "))[:400]
                    if not line.startswith("|") or snippet not in markers[file][num]:
                        continue
                    found.add(snippet)
                    start = i
                    while start > 0 and lines[start - 1].strip().startswith("|"):
                        start -= 1
                    print(
                        json.dumps(dict(**common, line=i, start=start, key=key.get(well), row=line)),
                        file=rows_file,
                    )
                if found != markers[file][num]:
                    raise ValueError((file, num, markers[file][num] - found))


if __name__ == "__main__":
    main()
