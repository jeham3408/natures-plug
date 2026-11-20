"""Read metric, actual Green Clay tops from aligned OCR table headers."""

import argparse
import csv
import itertools
import json
import re
import statistics
from collections import Counter, defaultdict

from paths import OUT, data_dir


def load_lines(name):
    return [json.loads(l) for l in (OUT / name).read_text().splitlines()]


def positions():
    positions = {}
    directory = data_dir() / "factpages"
    for kind in ("development", "exploration"):
        with (directory / f"wellbore_{kind}_all.csv").open(encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if r["wlbNsDecDeg"]:
                    positions[r["wlbWellboreName"]] = {
                        "name": r["wlbWellboreName"],
                        "la": float(r["wlbNsDecDeg"]),
                        "lo": float(r["wlbEwDecDeg"]),
                        "kb": float(r["wlbKellyBushElevation"] or 0),
                        "field": r.get("wlbField") or "",
                        "purpose": r.get("wlbPurpose") or "",
                        "kind": kind,
                    }
    return positions


def find(name, positions):
    # Same successive sidetrack fallbacks as build_greenclay.py.
    s = name
    for _ in range(4):
        if s in positions:
            return positions[s]
        s2 = re.sub(r"\s*T\d+$", "", s)
        if s2 == s and " " in s:
            s2 = re.sub(r"(\s[A-Z]+)?(Y\d)?H?$", "", s).strip()
        if s2 == s:
            break
        s = s2
    return None


def cells(line):
    return [c.strip() for c in line.strip().removeprefix("|").removesuffix("|").split("|")]


def compact(cell):
    return re.sub(r"[^a-z0-9]", "", cell.lower())


def depth(cell):
    # Accept separated thousands and decimal commas, but never a range, tolerance or time.
    m = re.fullmatch(
        r"\s*(-?(?:\d{1,2}(?:[ \u00a0]\d{3})+|\d+)(?:[.,]\d+)?)\s*(?:m(?:\s*TVD(?:\s*RKB)?)?)?\s*",
        cell,
        re.IGNORECASE,
    )
    if m:
        return float(re.sub(r"\s", "", m[1]).replace(",", "."))
    return None


LABEL = re.compile(
    r"(?:top\s+(?:of\s+)?(?:the\s+)?)?green\s*clay(?:st(?:one)?\.?|\s*(?:marker|fm\.?|formation|member))?(?:\s*\([^|]*\))?\s*:?",
    re.IGNORECASE,
)
DATUM = re.compile(r"(?:rkb|brt)\s*\(?\s*tvd|tvd\s*\)?\s*(?:rkb|brt)", re.IGNORECASE)


def extract(r, page, pos):
    lines = page.splitlines()
    values = cells(r["row"])
    if not any(
        LABEL.fullmatch(c.strip("* ")) or re.fullmatch(r"BOLIG\s*\(Top Green Clay\)", c, re.IGNORECASE)
        for c in values
    ):
        return None, "no isolated top cell"
    previous = lines[r["start"] : r["line"]]
    before = "\n".join(lines[max(0, r["start"] - 8) : r["start"]])
    headers = [(l, [compact(c) for c in cells(l)]) for l in previous]
    candidates = []
    for raw, h in headers:
        if len(h) != len(values):
            continue
        if not any("tvd" in c or "observed" in c or "twowaytime" in c for c in h):
            continue
        for i, c in enumerate(h):
            if re.search(
                r"uncert|diff|thick|deviat|progn|predict|delta|coord|time|twt|utmeast|utmno", c
            ):
                continue
            if re.search(r"actual|result|drilled|observed|encountered", c) and "tvd" in c:
                if "rkb" in c or "brt" in c:
                    family = "time_and_actual_rkb" if any("twt" in v for v in h) else "actual_rkb"
                    candidates.append((0, family, i, raw))
                elif "msl" in c or "tvdss" in c:
                    if any(("result" in v or "actual" in v or "drilled" in v) and "md" in v for v in h):
                        family = "actual_msl_with_md"
                    elif re.search(r"\b(?:R?KB)\s*(?:=|:)\s*\d+(?:[.,]\d+)?\s*m\b", page, re.IGNORECASE):
                        family = "actual_msl_page_kb"
                    else:
                        family = "actual_msl_only"
                    candidates.append((2, family, i, raw))
            elif c.startswith("observed") and DATUM.search(before):
                candidates.append((0, "observed_rkb", i, raw))
            elif c in ("depthm", "depth") and any("twowaytime" in v for v in h) and DATUM.search(before):
                candidates.append((0, "depth_and_time_rkb", i, raw))
            elif c in ("mtvdrkb", "tvdrkb") and any(v in ("mmdrkb", "mdrkb") for v in h):
                standalone = all(
                    v
                    in (
                        "",
                        "group",
                        "formation",
                        "seriesandformation",
                        "mmdrkb",
                        "mdrkb",
                        "mtvdrkb",
                        "tvdrkb",
                        "mtvdmsl",
                        "tvdmsl",
                        "thicknessmtvd",
                    )
                    for v in h
                )
                if (
                    standalone
                    and re.search(r"formation\s*tops", page, re.IGNORECASE)
                    and not re.search(r"progn|predict", before, re.IGNORECASE)
                ):
                    family = "formation_msl_column" if any("msl" in v for v in h) else "formation_rkb"
                    candidates.append((1, family, i, raw))

    # Two consecutive header lines: require an explicit actual label over the TVD RKB column.
    for (raw_a, h1), (raw_b, h2) in itertools.pairwise(headers):
        if len(h1) == len(h2) == len(values):
            group = ""
            for i, (upper, lower) in enumerate(zip(h1, h2)):
                if upper:
                    group = upper
                if group in ("actual", "results", "result", "observed") and lower in (
                    "tvdrkb",
                    "mtvdrkb",
                ):
                    candidates.append((0, "grouped_rkb", i, raw_a + "\n" + raw_b))
        # Hydro table omits the two label headers and the final uncertainty header in its units row.
        if (
            h1 == ["group", "formation", "prognosed", "", "actual", "", "", "uncertmtvd"]
            and h2 == ["mmd", "mtvd", "mmd", "mtvd", "mmsl"]
            and len(values) == 8
            and re.search(r"all depths from RKB", page, re.IGNORECASE)
        ):
            candidates.append((0, "grouped_rkb", 5, raw_a + "\n" + raw_b))

    if not candidates:
        return None, "uncertain header, alignment or datum"
    for _, family, i, header in sorted(set(candidates)):
        value = depth(values[i])
        if value is None:
            continue
        if family.startswith("actual_msl"):
            if pos is None or not 0 < pos["kb"] < 150:
                return None, "missing KB elevation"
            datum = re.search(r"\b(?:R?KB)\s*(?:=|:)\s*(\d+(?:[.,]\d+)?)\s*m\b", page, re.IGNORECASE)
            if datum and abs(depth(datum[1]) - pos["kb"]) > 2:
                return None, "report and FactPages KB differ"
            value = abs(value) + pos["kb"]
        if 200 <= value <= 4000:
            return {
                "template": family,
                "tvd": round(value, 2),
                "cell": values[i],
                "column": i + 1,
                "kb": pos["kb"] if family.startswith("actual_msl") else None,
                "header": header,
            }, None
    return None, "no valid numeric actual depth"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--held-out", action="store_true")
    args = parser.parse_args()
    facts = positions()
    pages = {(p["well"], p["file"], p["page"]): p["text"] for p in load_lines("pages.jsonl")}
    output, dropped = [], Counter()
    for r in load_lines("rows.jsonl"):
        if bool(r["key"]) == args.held_out:
            continue
        pos = find(r["well"], facts)
        if not pos or pos["kind"] != "development":
            dropped["outside development data"] += 1
            continue
        pick, reason = extract(r, pages[r["well"], r["file"], r["page"]], pos)
        if pick is None:
            dropped[reason] += 1
            continue
        output.append(
            {**{k: r[k] for k in ("well", "file", "page", "line", "start", "row", "key")}, **pick}
        )
    label = "held" if args.held_out else "known"
    (OUT / f"{label}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in output))
    (OUT / f"{label}_drops.json").write_text(json.dumps(dropped, indent=2) + "\n")
    print(label, len(output), dict(dropped))
    if not args.held_out:
        by = defaultdict(lambda: defaultdict(set))
        for r in output:
            by[r["template"]][r["well"]].add(r["tvd"] - r["key"])
        for t, w in sorted(by.items()):
            diffs = {k: round(statistics.median(d), 2) for k, d in w.items()}
            print(t, sum(abs(v) <= 5 for v in diffs.values()), len(diffs), diffs)


if __name__ == "__main__":
    main()
