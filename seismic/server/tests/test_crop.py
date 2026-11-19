"""crop_segy.py, the sea-bed polarity check and the readers of prep_nini.py.

The SEG-Y file built here has what the released survey had that prep.py refuses: lines of different length, line and
CDP numbers in other header bytes, whole-metre coordinates, IBM floats and one line written twice.
"""
import json
import os

import numpy as np
import pytest

import crop_segy
import prep
import prep_nini
import prep_wells

N_T, DT_US = 50, 4000
LINES = range(100, 106)
IL_STEP, XL_STEP = (-5.8674, 11.0374), (-11.0374, -5.8674)       # metres per line and per CDP, as in a rotated survey


def true_xy(line, cdp):
    return (500000.0 + line * IL_STEP[0] + cdp * XL_STEP[0], 6200000.0 + line * IL_STEP[1] + cdp * XL_STEP[1])


def sample(line, cdp):
    """Samples that are exact in both float formats."""
    return (line - 100) * 1000.0 + (cdp - 200) * 8.0 + np.arange(N_T) / 8.0


def to_ibm(values):
    """float -> IBM hexadecimal float bit patterns (only used to build the test file)."""
    a = np.asarray(values, np.float64)
    out = np.zeros(a.shape, np.uint32)
    nz = a != 0
    m = np.abs(a[nz])
    e = np.floor(np.log(m) / np.log(16.0)) + 1
    e = np.where(m / 16.0 ** e >= 1.0, e + 1, e)
    mant = np.round(m / 16.0 ** e * (1 << 24)).astype(np.uint32)
    out[nz] = ((a[nz] < 0).astype(np.uint32) << 31) | ((e + 64).astype(np.uint32) << 24) | mant
    return out


def write_survey(path, fmt, twice=103, spoil=False):
    """Line L holds CDPs 200 + (L - 100) .. 230; line `twice` is written two times (the second time changed if spoil)."""
    with open(path, "wb") as fh:
        fh.write(("C01 TEST SURVEY".ljust(3200)).encode("cp037"))
        b = bytearray(400)
        b[16:18] = DT_US.to_bytes(2, "big")
        b[20:22] = N_T.to_bytes(2, "big")
        b[24:26] = fmt.to_bytes(2, "big")
        fh.write(bytes(b))
        order = []
        for line in LINES:
            order.append((line, False))
            if line == twice:
                order.append((line, True))
        for line, again in order:
            for cdp in range(200 + (line - 100), 231):
                h = bytearray(240)
                x, y = true_xy(line, cdp)
                h[20:24] = int(cdp).to_bytes(4, "big")
                h[70:72] = (1).to_bytes(2, "big")
                h[72:76] = int(round(x)).to_bytes(4, "big")
                h[76:80] = int(round(y)).to_bytes(4, "big")
                h[114:116] = N_T.to_bytes(2, "big")
                h[116:118] = DT_US.to_bytes(2, "big")
                h[180:184] = int(line).to_bytes(4, "big")
                d = sample(line, cdp) + (1.0 if again and spoil else 0.0)
                fh.write(bytes(h))
                fh.write((to_ibm(d).astype(">u4") if fmt == 1 else d.astype(">f4")).tobytes())
    return path


ARGS = ["--il-byte", "181", "--xl-byte", "21", "--x-byte", "73", "--y-byte", "77"]


def read_box(path, n_keep):
    dt = np.dtype({"names": ["scalar", "x", "y", "il", "xl", "d"], "formats": [">i2", ">i4", ">i4", ">i4", ">i4", (">f4", (n_keep,))],
                   "offsets": [70, 180, 184, 188, 192, 240], "itemsize": 240 + 4 * n_keep})
    return np.fromfile(path, dtype=dt, offset=3600)


def test_ibm_helper_round_trip():
    v = np.array([0.0, 1.0, -1.0, 0.125, 100.0, -4321.5, 5008.125])
    assert np.array_equal(prep.ibm_to_ieee(to_ibm(v)), v.astype("<f4"))


@pytest.mark.parametrize("fmt", [1, 5])
def test_box_out_of_an_irregular_survey(tmp_path, fmt):
    src = write_survey(str(tmp_path / "src.sgy"), fmt)
    out = str(tmp_path / "box.sgy")
    assert crop_segy.main([src, out, "--il", "101", "104", "--xl", "210", "225", "--t-max", "100"] + ARGS) == 0
    with open(out, "rb") as fh:
        head = fh.read(3600)
    assert head[:3200] == open(src, "rb").read(3200)                      # textual header untouched
    assert int.from_bytes(head[3220:3222], "big") == 26 and int.from_bytes(head[3224:3226], "big") == 5
    tr = read_box(out, 26)
    assert tr.size == 4 * 16
    assert np.array_equal(tr["il"], np.repeat(np.arange(101, 105), 16))
    assert np.array_equal(tr["xl"], np.tile(np.arange(210, 226), 4))
    assert np.all(tr["scalar"] == -100)
    want = np.array([true_xy(i, j) for i, j in zip(tr["il"], tr["xl"])])
    assert np.abs(tr["x"] / 100.0 - want[:, 0]).max() < 0.6 and np.abs(tr["y"] / 100.0 - want[:, 1]).max() < 0.6
    for q in (0, 17, 63):
        assert np.array_equal(tr["d"][q], sample(int(tr["il"][q]), int(tr["xl"][q]))[:26].astype(">f4"))
    rec = json.load(open(out + ".json"))
    assert rec["box"]["identical_repeats_dropped"] == 16 and rec["box"]["missing_filled"] == 0
    assert rec["geometry"]["largest_misfit_to_header_coordinates_m"] <= 0.75
    # ... and prep.py takes the result as it is
    cube_dir = str(tmp_path / "cube")
    assert prep.main([out, "--out", cube_dir, "--name", "t", "--polarity", "-1", "--polarity-note", "test"]) == 0
    meta = json.load(open(os.path.join(cube_dir, "meta.json")))
    assert (meta["n_il"], meta["n_xl"], meta["n_t"], meta["il0"], meta["xl0"]) == (4, 16, 26, 101, 210)
    assert meta["polarity"] == -1 and meta["polarity_note"] == "test"
    cube = np.load(os.path.join(cube_dir, "cube_ixt.npy"))
    assert np.array_equal(cube[2, 5], sample(103, 215)[:26].astype("<f4"))


def test_box_with_holes_is_refused_unless_filled(tmp_path):
    src = write_survey(str(tmp_path / "src.sgy"), 5)
    out = str(tmp_path / "box.sgy")
    with pytest.raises(SystemExit) as e:
        crop_segy.main([src, out, "--il", "100", "103", "--xl", "200", "210"] + ARGS)
    assert "have no trace" in str(e.value) and not os.path.exists(out)
    assert crop_segy.main([src, out, "--il", "100", "103", "--xl", "200", "210", "--fill-missing"] + ARGS) == 0
    tr = read_box(out, N_T)
    hole = (tr["il"] == 103) & (tr["xl"] == 201)
    assert hole.sum() == 1 and not tr["d"][hole].any()
    assert json.load(open(out + ".json"))["box"]["missing_filled"] == 1 + 2 + 3
    assert np.array_equal(tr["d"][(tr["il"] == 103) & (tr["xl"] == 203)][0], sample(103, 203).astype(">f4"))


def test_repeated_line_with_other_samples_stops(tmp_path):
    src = write_survey(str(tmp_path / "src.sgy"), 5, spoil=True)
    with pytest.raises(SystemExit) as e:
        crop_segy.main([src, str(tmp_path / "box.sgy"), "--il", "101", "104", "--xl", "210", "225"] + ARGS)
    assert "different samples" in str(e.value)


def test_existing_output_is_kept(tmp_path):
    src = write_survey(str(tmp_path / "src.sgy"), 5)
    out = tmp_path / "box.sgy"
    out.write_text("mine")
    with pytest.raises(SystemExit):
        crop_segy.main([src, str(out), "--il", "101", "104", "--xl", "210", "225"] + ARGS)
    assert out.read_text() == "mine"


@pytest.mark.parametrize("sign", [1.0, -1.0])
def test_sea_bed_polarity(sign):
    t = 4.0 * np.arange(60)
    cube = np.random.default_rng(1).normal(0.0, 0.05, (40, 40, 60)).astype(np.float32)
    cube[:, :, 20] += sign                                              # the sea bed at 80 ms
    cube[:, :, 26] -= 0.4 * sign                                        # a weaker lobe of the other sign after it
    chk = prep_wells.seabed_polarity(cube, t, 79.7, step=4)
    assert chk["traces"] == 100 and chk["median_time"] == 80.0
    assert chk["positive_share"] == (1.0 if sign > 0 else 0.0)
    assert prep_wells.seabed_polarity(cube, t, 5000.0) is None           # no samples near that time


def test_vsp_listing_and_log_step(tmp_path):
    p = tmp_path / "vsp.txt"
    p.write_text("""          WELL : X
    320.0    320.0    282.2     52.8    165.8    163.5      2.3    165.9     1702
                                                                                     180.0     99.5     1809
    500.0    500.0    462.2     52.8    264.0    263.0      2.3    265.3     1742
 Measured Vertical Vertical   Offset    Slant V. time  Source - Vertical  Average
""")
    assert prep_nini.read_vsp(str(p)) == [(320.0, 320.0, 282.2, 165.9), (500.0, 500.0, 462.2, 265.3)]
    # the same kind of table as a spreadsheet (Nini-5): a level row holds eleven numbers, interval rows fewer
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    for row in (["WELL:", "X"], ["Rec. No.", "D", "TVD", "Z", "X", "T", "TV", "TE", "TC", "AV.VEL", "RMS.VEL"],
                [1, 200, 200, 158.2, 64.9, 0.0969, 0.0899, 0.003, 0.093, 1702, 1713], [20, 0.0108, 1852],
                [2, 220, 220, 178.2, 65.2, 0.107, 0.1008, 0.003, 0.1038, 1716, 1727]):
        ws.append(row)
    wb.save(str(tmp_path / "vsp.xlsx"))
    got = prep_nini.read_vsp_xlsx(str(tmp_path / "vsp.xlsx"))
    assert [g[0] for g in got] == [200.0, 220.0] and got[0][3] == pytest.approx(93.0) and got[1][3] == pytest.approx(103.8)
    md = np.arange(1000.0, 1100.0, 0.5)
    gr = np.where(md < 1042.0, 90.0, 60.0)
    z, d = prep_nini.step_in(md, gr, 1020.0, 1060.0)
    assert abs(z - 1042.0) <= 0.5 and d == pytest.approx(-30.0)
