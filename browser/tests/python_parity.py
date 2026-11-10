"""Record app.py's outputs for the browser parity tests.

Run from the repository root with the Streamlit edition's virtualenv:

    .venv/bin/python browser/tests/python_parity.py

It writes browser/tests/fixtures/python-parity.json, which
tests/parity.test.js compares against the browser ports.
"""
import contextlib
import io
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
logging.disable(logging.WARNING)

with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    import pandas as pd
    import app  # noqa: E402  (runs the Streamlit script in bare mode)

CASES = json.loads((Path(__file__).parent / "fixtures" / "parity-cases.json").read_text())


def records(df):
    return json.loads(df.to_json(orient="records"))


def capture(function):
    try:
        return {"value": function()}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def table(case):
    return pd.DataFrame(case["data"], columns=case["columns"], dtype=str)


def roster_output(df):
    columns = app.REQUIRED + ["_name", "_face", "_code"]
    return records(df[columns])


results = {
    "split": [list(app.split_archer_name(name)) for name in CASES["split"]],
    "prepare": [
        capture(lambda case=case: roster_output(app.prepare_import_roster(table(case))))
        for case in CASES["prepare"]
    ],
    "restore": [
        capture(lambda case=case: records(app.restore_imported_draw(
            table(case["draw"]),
            app.prepare_import_roster(table(case["roster"])),
        )))
        for case in CASES["restore"]
    ],
    "hth": [
        records(app.head_to_heads(app.normalize_headers(pd.DataFrame(roster))))
        for roster in CASES["hth"]
    ],
    "ianseo": [
        capture(lambda case=case: records(app.ianseo_import_dataframe(
            pd.DataFrame(case["roster"]), case["config"], pd.DataFrame(case["draw"]),
        )))
        for case in CASES["ianseo"]
    ],
    "swapBlocks": [
        capture(lambda case=case: records(app.swap_target_block_numbers(
            pd.DataFrame(case["draw"]), case["spec"],
        )))
        for case in CASES["swapBlocks"]
    ],
    "incompatible": [
        sorted(f"{s}|{t}" for s, t in app.incompatible_faces(pd.DataFrame(draw)))
        for draw in CASES["incompatible"]
    ],
    "classFields": [
        capture(lambda case=case: app.class_code_to_fields(case["code"], case["current"]))
        for case in CASES["classFields"]
    ],
    "summary": [records(app.refresh_summary(pd.DataFrame(draw))) for draw in CASES["summary"]],
}

out = Path(__file__).parent / "fixtures" / "python-parity.json"
out.write_text(json.dumps(results, ensure_ascii=False, indent=1) + "\n")
print(f"Wrote {out}")
