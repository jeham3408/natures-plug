"""Evaluate the frozen model using the same site keys and reference wells as training."""

import argparse
import csv
import json
import math
import random
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from extract import find, load_lines, positions
from paths import APP, OUT, PACKAGE

METHODS = ("model", "fixed", "middle")
SEED = 20261120


def km(a, b, c, d):
    return math.hypot((b - d) * 111.32 * math.cos(math.radians(a)), (a - c) * 110.57)


def key(lat, lon, depth):
    return round(lat, 2), round(lon, 2), round(depth / 20)


def percentile(values, q):
    ordered = sorted(values)
    index = q * (len(ordered) - 1)
    return ordered[math.floor(index)] * (1 - index % 1) + ordered[math.ceil(index)] * (index % 1)


def metrics(sites):
    clusters = defaultdict(list)
    for site in sites:
        clusters[site["ref"]].append(site)
    out = {
        "sites": len(sites),
        "wells": sum(len(s["wells"]) for s in sites),
        "references": len(clusters),
        "troll_sites": sum(s["field"] == "TROLL" for s in sites),
    }
    for method in METHODS:
        errors = [s[method] - s["tvd"] for s in sites]
        if not errors:
            out[method] = None
            continue
        a = sorted(map(abs, errors))
        p90 = percentile(a, 0.9)
        per_ref = [
            statistics.mean(abs(s[method] - s["tvd"]) for s in group) for group in clusters.values()
        ]
        out[method] = {
            k: round(v, 1)
            for k, v in {
                "mae": statistics.mean(a),
                "median": statistics.median(a),
                "p90": p90,
                "bias": statistics.mean(errors),
                "reference_balanced_mae": statistics.mean(per_ref),
            }.items()
        }
    return out


def cluster_bootstrap(sites):
    """Resample whole reference wells, using the same draw for the paired difference."""
    clusters = defaultdict(list)
    for s in sites:
        clusters[s["ref"]].append(s)
    totals = []
    for ref in sorted(clusters):
        group = clusters[ref]
        model = sum(abs(s["model"] - s["tvd"]) for s in group)
        middle = sum(abs(s["middle"] - s["tvd"]) for s in group)
        totals.append((len(group), model, model - middle))
    if not totals:
        return None
    rng = random.Random(SEED)
    model_means, differences = [], []
    for _ in range(2000):
        draw = rng.choices(totals, k=len(totals))
        n, model, difference = map(sum, zip(*draw))
        model_means.append(model / n)
        differences.append(difference / n)

    def interval(values):
        return [round(percentile(values, q), 1) for q in (0.05, 0.95)]

    return {
        "seed": SEED,
        "draws": 2000,
        "confidence": 0.90,
        "resampling_unit": "reference well",
        "estimand": "site-weighted MAE",
        "model": interval(model_means),
        "model_minus_middle": interval(differences),
    }


def calibration(rows):
    def compare(rs):
        by = defaultdict(set)
        for r in rs:
            by[r["well"]].add(r["tvd"] - r["key"])
        differences = [abs(statistics.median_low(sorted(s))) for s in by.values()]
        return {
            "wells": len(by),
            "hits": sum(d <= 5 for d in differences),
            "rows": len(rs),
            "median_abs": round(statistics.median(differences), 2) if differences else None,
            "row_hits": sum(abs(r["tvd"] - r["key"]) <= 5 for r in rs),
        }

    templates = {
        t: compare([r for r in rows if r["template"] == t])
        for t in sorted({r["template"] for r in rows})
    }
    keep = {t for t, m in templates.items() if m["hits"] / m["wells"] >= 0.90}
    used = [r for r in rows if r["template"] in keep]
    # Copies of an upper-hole table across laterals are not independent calibration examples.
    unique = {}
    for r in used:
        slot = re.match(r"\d+/\d+-[A-Z]+-\d+", r["well"])[0]
        unique.setdefault((slot, r["tvd"], r["key"]), r)
    return keep, {
        "templates": templates,
        "accepted": sorted(keep),
        "all_candidate_templates": compare(rows),
        "retained": compare(used),
        "distinct_slot_depth_pairs": len(unique),
        "distinct_slot_depth_hits": sum(abs(r["tvd"] - r["key"]) <= 5 for r in unique.values()),
    }


def evaluate(rows, facts, model):
    refs = [
        r
        for r in json.loads((APP / "data/layer1.json").read_text())
        if r.get("ho") and r.get("ro") and re.search(r"\d$", r["n"])
    ]
    train = [r for r in model["sites"] if r["ok"]]
    train_keys = {key(r["la"], r["lo"], r["tvd"]) for r in train}
    rule = model["rule"]
    grouped = defaultdict(list)
    for r in rows:
        grouped[r["well"]].append(r)
    sites = {}
    for w, rs in sorted(grouped.items()):
        # Select an actual source depth (median_low), as in build_picks.py.
        tvd = statistics.median_low(sorted({r["tvd"] for r in rs}))
        pick = next(r for r in rs if r["tvd"] == tvd)
        source = {k: pick[k] for k in ("well", "file", "page", "cell", "column", "template", "kb")}
        pos = find(w, facts)
        k = key(pos["la"], pos["lo"], tvd)
        site = sites.setdefault(
            k,
            {
                "la": pos["la"],
                "lo": pos["lo"],
                "tvd": tvd,
                "field": pos["field"] or "35/11 (Fram area)",
                "source": source,
                "wells": [],
                "same_key": k in train_keys,
            },
        )
        site["wells"].append(w)
    excluded = Counter()
    accepted = []
    for s in sites.values():
        distance, ref = min(
            ((km(s["la"], s["lo"], r["la"], r["lo"]), r) for r in refs), key=lambda p: p[0]
        )
        top, base = ref["ho"][0], ref["ro"][0]
        h = base - top
        if distance > 6:
            excluded["reference_over_6km"] += 1
            continue
        if h <= 0 or not 0.05 < (s["tvd"] - top) / h < 0.98:
            excluded["outside_hordaland_window"] += 1
            continue
        near = min(km(s["la"], s["lo"], r["la"], r["lo"]) for r in train)
        s.update(
            ref=ref["n"],
            ref_km=distance,
            ho=top,
            ro=base,
            train_km=near,
            band="under_2" if near < 2 else "2_to_10" if near <= 10 else "over_10",
            model=base - min(h, max(rule["tmin"], min(rule["tmax"], rule["a"] + rule["b"] * h))),
            fixed=base - rule["height"],
            middle=top + 0.5 * h,
        )
        accepted.append(s)
    new = [s for s in accepted if not s["same_key"]]
    by_band = {b: metrics([s for s in new if s["band"] == b]) for b in ("under_2", "2_to_10", "over_10")}
    return {
        "assembled": len(sites),
        "excluded": dict(excluded),
        "matched_training_key": metrics([s for s in accepted if s["same_key"]]),
        "all_including_training_keys": metrics(accepted),
        "new": metrics(new),
        "distance": by_band,
        "independent": metrics([s for s in new if s["band"] != "under_2"]),
        "fields": {
            f: metrics([s for s in new if s["field"] == f]) for f in sorted({s["field"] for s in new})
        },
        "fields_by_distance": {
            f: {b: metrics([s for s in new if s["field"] == f and s["band"] == b]) for b in by_band}
            for f in sorted({s["field"] for s in new})
        },
        "sites": accepted,
    }


def attribute_sources(rows, known):
    owners = defaultdict(list)
    with (PACKAGE / "owners.csv").open() as f:
        for r in csv.DictReader(f):
            owners[r["slot"], float(r["tvd"])].append(
                (r["owner"], int(r["page"]) if r["page"] else None)
            )
    pages = {(r["well"], r["file"], r["page"]): r["text"] for r in load_lines("pages.jsonl")}
    known_pages = {text for (well, _, _), text in pages.items() if well in known}
    primary = []
    for row in rows:
        slot = re.match(r"\d+/\d+-[A-Z]+-\d+", row["well"])[0]
        if (slot, row["tvd"]) not in owners:
            raise ValueError(f"Review the source caption for {slot}, {row['tvd']} m.")
        if pages[row["well"], row["file"], row["page"]] in known_pages:
            continue
        if any(
            row["well"] == owner and (page is None or row["page"] == page)
            for owner, page in owners[slot, row["tvd"]]
        ):
            primary.append(row)
    return primary


def audit(rows, sites):
    fields = ("well", "file", "page", "line")

    def identity(row):
        return tuple(str(row[k]) for k in fields)

    sample = random.Random(SEED).sample(sorted(rows, key=lambda r: tuple(r[k] for k in fields)), 25)
    with (PACKAGE / "spot_check.csv").open() as f:
        manual = {identity(r): float(r["manual_tvd_rkb"]) for r in csv.DictReader(f)}
    if set(manual) != {identity(r) for r in sample}:
        raise ValueError("The saved manual review and the reproducible sample differ.")
    wrong = sum(abs(r["tvd"] - manual[identity(r)]) > 0.05 for r in sample)
    outliers = [s["source"] for s in sites if abs(s["model"] - s["tvd"]) > 150]
    return {
        "seed": SEED,
        "drawn": len(sample),
        "wrong": wrong,
        "correct": len(sample) - wrong,
        "population_rows": len(rows),
        "maximum_absolute_model_error_m": round(max(abs(s["model"] - s["tvd"]) for s in sites), 1),
        "outliers_over_150_m": outliers,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PACKAGE / "result.json")
    args = parser.parse_args()
    facts = positions()
    good, check = calibration(load_lines("known.jsonl"))
    raw = load_lines("held.jsonl")
    rows = [r for r in raw if r["template"] in good]
    model = json.loads((APP / "data/greenclay.json").read_text())
    with (APP / "pipeline/greenclay/gc_picks.csv").open() as f:
        known = {r["wellbore"] for r in csv.DictReader(f)}
    assert not any(r["well"] in known for r in rows)
    primary = attribute_sources(rows, known)
    analysis = evaluate(primary, facts, model)
    sites = analysis.pop("sites")
    independent = [s for s in sites if not s["same_key"] and s["band"] != "under_2"]
    as_archived = evaluate(rows, facts, model)
    with_actual_rkb = evaluate([r for r in raw if r["template"] in good | {"actual_rkb"}], facts, model)
    production = evaluate(
        [r for r in primary if find(r["well"], facts)["purpose"] == "PRODUCTION"], facts, model
    )
    marks = load_lines("markers.jsonl")
    all_rows = load_lines("rows.jsonl")
    counts = {
        "marker_wells": len({r["well"] for r in marks}),
        "overlap": len({r["well"] for r in marks} & known),
        "held_marker_wells": len({r["well"] for r in marks} - known),
        "known_table_wells": len({r["well"] for r in all_rows if r["key"] is not None}),
        "held_table_wells": len({r["well"] for r in all_rows if r["key"] is None}),
        "held_table_rows": sum(r["key"] is None for r in all_rows),
        "extracted_before_calibration": len(raw),
        "template_qualified_rows": len(rows),
        "attributed_rows": len(primary),
        "attributed_wells": len({r["well"] for r in primary}),
        "converted_rows": sum(r["kb"] is not None for r in primary),
        "held_extraction_drops": json.loads((OUT / "held_drops.json").read_text()),
    }
    data = {
        "unit": "metres TVD from rig floor",
        "source_reader": "Fredric Hegland's report reader (frheg/hackathon-force), app/sketches/greenclay.py at e923fb2",
        "interpretation": "Only new sites at least 2 km from a training site form the independent check. "
        "The nearer sites share platform or well-template areas with training. At 2 km or more "
        "the Hordaland midpoint performs as well as the model. Fixed height has higher MAE.",
        "scan": json.loads((OUT / "scan_counts.json").read_text()),
        "counts": counts,
        "calibration": check,
        "primary": analysis,
        "per_site": sites,
        "independent_cluster_bootstrap": cluster_bootstrap(independent),
        "manual_check": audit(primary, sites),
        "training_field_cv": model["cv"]["field"]["line"],
        "as_archived": {k: as_archived[k] for k in ("new", "distance", "independent")},
        "as_archived_including_actual_rkb": {
            k: with_actual_rkb[k] for k in ("new", "distance", "independent")
        },
        "production_purpose_only": {
            k: production[k] for k in ("new", "distance", "independent", "fields")
        },
        "source_conflicts": [
            {
                "wells": ["30/9-F-5", "30/9-F-5 A"],
                "key": 1681.7,
                "key_source": "drilling report",
                "final_md": 2718,
                "final_tvd_rkb": 1736.9,
                "file": "30_9-F-5_A_COMPLETION_REPORT.JSON",
                "page": 9,
                "note": "Final table for F-5 A also filed under F-5.",
            },
            {
                "wells": ["30/6-E-1"],
                "key": 1667,
                "key_source": "drilling programme",
                "final_tvd_rkb": 1657,
                "file": "30_6-E-1_A_COMPLETION_REPORT.JSON",
                "page": 21,
            },
            {
                "wells": ["31/2-L-13 H"],
                "key": 938.4,
                "key_source": "mud log",
                "final_tvd_rkb": 932,
                "file": "31_2-L-13_H_COMPLETION_REPORT.JSON",
                "page": 10,
            },
            {
                "wells": ["31/5-J-41"],
                "key": 790,
                "key_source": "MWD",
                "final_tvd_msl": 817,
                "kb": 23,
                "final_tvd_rkb": 840,
                "file": "31_5-J-41_31-05-J-41_PB-706-2390.JSON",
                "page": 16,
            },
        ],
        "interpretation_of_key": "Final formation tables provide better actual depth references than some labels in the answer key.",
        "supervisor_sensitivity": {
            "provenance": "Independent, broader extraction supplied by supervisor",
            "all_sites": 98,
            "all_site_mae": 55.0,
            "references": 29,
            "reference_balanced_model_mae": 65,
            "independent_sites": 57,
            "independent_references": 17,
            "site_mae": {"model": 55.3, "middle": 55.3, "fixed": 87.8},
            "independent_reference_balanced_mae": {"model": 74, "middle": 68},
            "spot_check": {"correct": 29, "drawn": 30, "error": "Prognosis in exploration well 31/4-10"},
        },
    }
    args.output.write_text(json.dumps(data, indent=1, allow_nan=False) + "\n")
    print(f"{len(primary)} source-attributed rows. Independent check: {analysis['independent']}")


if __name__ == "__main__":
    main()
