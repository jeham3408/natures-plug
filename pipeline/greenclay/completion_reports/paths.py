"""Locations shared by the archive scan, calibration and model check."""

import os
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
APP = Path(os.environ.get("NP_APP", PACKAGE.parents[2]))
OUT = Path(os.environ.get("NP_REPORT_WORK", "completion-report-work")).resolve()


def data_dir():
    if "NP_DATA" not in os.environ:
        raise SystemExit("Set NP_DATA to the directory containing completion_reports/ and factpages/.")
    return Path(os.environ["NP_DATA"])
