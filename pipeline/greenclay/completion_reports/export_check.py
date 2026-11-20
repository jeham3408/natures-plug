"""Export the completion-report check for the Green Clay evidence sheet."""

import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
READER_REPO = "https://github.com/frheg/hackathon-force"
READER_REV = "e923fb230e824ca9ed63aa00d906fa2087c397e8"
MIN_TRAINING_DISTANCE_KM = 2


def main():
    result = json.loads((HERE / "result.json").read_text(encoding="utf-8"))
    independent = result["primary"]["independent"]
    sites = [
        {
            "well": site["source"]["well"],
            "field": site["field"],
            "observed": site["tvd"],
            "model": site["model"],
            "middle": site["middle"],
            "fixed": site["fixed"],
        }
        for site in result["per_site"]
        if not site["same_key"] and site["train_km"] >= MIN_TRAINING_DISTANCE_KM
    ]
    if len(sites) != independent["sites"]:
        raise ValueError("The exported sites do not match the independent group")
    check = {
        "date": "2026-11-20",
        "unit": result["unit"],
        "minimum_training_distance_km": MIN_TRAINING_DISTANCE_KM,
        "independent": independent,
        "all_new": result["primary"]["new"],
        "bootstrap": result["independent_cluster_bootstrap"],
        "calibration": result["calibration"]["retained"],
        "manual_check": result["manual_check"],
        "training_field_cv": result["training_field_cv"],
        "credit": "Green Clay tops read with Fredric Hegland's report reader (frheg/hackathon-force)",
        "reader_repository": READER_REPO,
        "reader_url": f"{READER_REPO}/blob/{READER_REV}/app/sketches/greenclay.py",
        "sites": sites,
    }
    output = HERE.parents[2] / "data" / "greenclay_check.json"
    output.write_text(json.dumps(check, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
