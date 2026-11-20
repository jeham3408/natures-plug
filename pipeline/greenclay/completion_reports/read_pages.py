"""Inspect OCR pages from an indexed JSON report without extracting the archive."""

import argparse
import json
import re
from contextlib import ExitStack
from pathlib import PurePosixPath

from scan import OUT, SplitTar, document, parts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("well")
    parser.add_argument("--file", help="substring of the report filename")
    parser.add_argument("--page", nargs="+", type=int, help="JSON page numbers")
    parser.add_argument("--search", help="print matching lines and their page numbers")
    args = parser.parse_args()
    pattern = re.compile(args.search, re.IGNORECASE) if args.search else None
    with ExitStack() as stack:
        stream = SplitTar(parts(), stack)
        for line in (OUT / "members.jsonl").read_text().splitlines():
            well, path, offset, size, _ = json.loads(line)
            name = PurePosixPath(path).name
            if well != args.well or (args.file and args.file not in name):
                continue
            stream.seek(offset)
            pages = document(stream.read(size))["pages"]
            for p in pages:
                number = p["page_no"]
                if args.page and number not in args.page:
                    continue
                text = (p.get("OCR") or {}).get("ocr_markdown") or ""
                if pattern:
                    text = "\n".join(s for s in text.splitlines() if pattern.search(s))
                if text:
                    print(f"\n{name} | page {number}\n{text}")


if __name__ == "__main__":
    main()
