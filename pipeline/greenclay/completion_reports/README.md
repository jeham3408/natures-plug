# Check the Green Clay predictor against completion reports

The input is the split, uncompressed completion-report tar and the FactPages development and exploration CSVs. Python 3.10+ reads one JSON member at a time and seeks past PDFs. The scan calls Fredric Hegland's original marker and depth routines. Only his unused storage imports and nearest-formation annotation are replaced. The published run used commit `e923fb230e824ca9ed63aa00d906fa2087c397e8`. [Fredric's reader](https://github.com/frheg/hackathon-force/blob/e923fb230e824ca9ed63aa00d906fa2087c397e8/app/sketches/greenclay.py)

From the root of Nature's Plug, set the first three paths for your machine. The work directory holds offsets, snippets and OCR pages. The final command writes the compact result alongside the scripts. Pass `--output PATH` to write a comparison copy.

```bash
export NP_DATA=/path/to/data                         # contains completion_reports/ and factpages/
export FRHEG_REPO=/path/to/hackathon-force           # local checkout of Fredric's repository
export NP_REPORT_WORK=/path/to/writable/work         # scratch directory
p=pipeline/greenclay/completion_reports
python3 -B "$p/scan.py"
python3 -B "$p/collect.py"
python3 -B "$p/extract.py"                            # first compare against gc_picks.csv
python3 -B "$p/extract.py" --held-out
python3 -B "$p/evaluate.py"
```

To inspect the calibration discrepancy at 31/2-L-13 H, run `python3 -B "$p/read_pages.py" '31/2-L-13 H' --page 10`. Page numbers are the JSON `page_no` values. `NP_APP` optionally overrides the app checkout used for the frozen rule, group tops and training picks.

The extractor aligns an isolated Green Clay cell with its own table headers. An observed-depth table needs a depth datum in the header or caption. An MSL depth uses the FactPages KB elevation. Seven header families passed the within-5-m comparison in at least 90% of their readable key wells. The file [owners.csv](owners.csv) records which archived well a table actually describes. An empty owner excludes the entry. A shared upper section is counted once. The [manual sample](spot_check.csv) records 25 readings checked against the OCR, including the KB conversion where required.

The output has one record per accepted spatial/depth key under `per_site`. Each record carries the well list, representative source cell, file, page, column, units through its template and KB, reference well and predictions. `same_key` marks overlaps with the training sites. `primary` contains the aggregates after checking the source well, `as_archived` retains the archive assignment for comparison, and `production_purpose_only` restricts development wells to the FactPages production purpose. Error is predicted minus observed depth. The 90% intervals resample whole reference wells, including their sites, with the same draw for each method. [Result and provenance](result.json)
