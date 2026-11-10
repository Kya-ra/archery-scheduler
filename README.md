# Archery Scheduler

A Streamlit app for importing archer rosters, generating target assignments, managing a draw, and exporting schedules for Excel and IANSEO.
If you find this useful, why not make a small donation to a animal welfare charity, or another charity of your choice

## Run the app

Docker is the recommended setup. From this directory, run:

```bash
docker compose up --build
```

Open [http://localhost:8501](http://localhost:8501). Stop the app with `Ctrl+C`. The Compose setup mounts the project directory into the container, so local code and configuration changes are available to the app.

To run without Docker, use Python 3.12 or newer and install the requirements:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
streamlit run app.py
```

On Windows, activate the environment with `.venv\Scripts\activate` before installing and running. The app requires `config.json` beside `app.py`.

## Import a roster

Upload a CSV, TSV, TAB, TXT, XLSX, or ODS file. Choose **Import roster → Generate** and click **Import file**. CSV files may be comma- or tab-delimited. Headerless 21-column IANSEO List Load files are also recognized.

Each roster row needs these fields:

| Field | Notes |
| --- | --- |
| First Name | Archer's given name. |
| Last Name | Archer's family name. |
| Bow Type | `barebow`, `recurve`, or `compound`. |
| College | Club or college code, such as `QUB` or `UCD`. |
| Gender | Usually `open` or `female`; guest and senior league may also be represented here. |
| Category | `beginner`, `intermediate`, `advanced`, `guest`, or `senior league`. |
| Membership Number | Required and unique for every archer. IANSEO files may call this `Bib`. |
| Which Days | `both days`, `saturday only`, `sunday only`, or `no h2h`. |
| Session Preference | Blank, one session number, or comma-separated session numbers such as `1, 3`. |

Headers are matched without regard to capitalization. Common alternatives such as `Given Name`, `Surname`, `Bow`, `Club`, `Sex`, `AI Number`, `Bib`, `Attendance`, and `Preferred Session` are accepted. Combined name columns such as `Archer` or `Full Name` are split into first and last names when separate name fields are not provided. For an IANSEO file, `Name` is treated as the given name and `Family Name` as the surname.

Example roster:

```csv
First Name,Last Name,Bow Type,College,Gender,Category,Membership Number,Which Days,Session Preference
Alex,Archer,recurve,QUB,open,advanced,10001,both days,
Sam,Shooter,barebow,UCD,female,beginner,10002,saturday only,1
```

The roster import merges by membership number: matching rows are updated, new members are added, and existing members not in the uploaded file are retained. It clears any current draw because a roster import does not preserve allocations. Use **Clear all archers** to clear the roster and current draw.

### Attendance and head-to-head eligibility

`Which Days` controls session-day eligibility and head-to-head eligibility. `Both Days` is eligible for head-to-heads; Saturday-only and Sunday-only archers are not. `No H2H` is eligible for any configured session day but excluded from head-to-heads. In a `Shooting H2H` or equivalent binary source column, `yes`/`1` means `Both Days`, and `no`/`0` means `No H2H`.

Head-to-heads also exclude guest and senior league archers. Open and female classes are merged when either side has fewer than four eligible entrants.

## Copy an existing schedule

Choose **Copy existing schedule** before importing, then click **Import file**. This mode restores allocations as-is; it does not generate replacement assignments. The file must have `Session` and `Target` columns and identify each archer by membership number/Bib or by name.

Targets may be combined with their position (`14A`) or supplied as a target number plus a separate `Position` column. Positions must be `A`, `B`, `C`, or `D`; numeric targets without a separate position are invalid. Sessions must be numbered consecutively from 1, and each archer and target position must have a unique allocation. Invalid, ambiguous, or unmatched rows stop the import rather than being skipped.

## Configure and generate a draw

After importing a roster:

1. Set the number of sessions (1–8).
2. For each session, set its target count (1–200) and choose `Single` or `Double`. Single targets hold two archers (`A/B`); Double targets hold four (`A/B/C/D`). The app displays each session's and the event's total capacity.
3. Choose a target grouping mode.
4. Optionally enable **Replace all 3s faces with Vegas**.
5. Click **Generate schedule**.

Explicit session preferences are hard constraints. A blank preference uses the college's configured default as a soft preference. Every archer is assigned once, and the total configured capacity must be sufficient. Every target must be used, contain archers from at least two colleges, and include at least one qualifying archer: an archer on a 3s face, intermediate or advanced archer, or guest/senior league archer. Three or more archers from the same college are discouraged but allowed when needed.

### Target grouping modes

- **Campanile**: every target must contain at least one non-beginner archer.
- **Cluster by class**: disables the Campanile rule and makes a best effort to group gender-neutral classes. It prioritizes `C`, `BB`, `BI`, `BA`, `RB`, `RI`, then `RA`, with earlier groups favored on lower-numbered targets. Guest and senior league classes follow these groups. This is a preference, not a guarantee.
- **Standard**: uses neither the Campanile nor class-clustering objective.

These three choices are mutually exclusive. The target-validity requirements above apply in every mode.

### Target faces and Vegas

The default target face is derived from bow type, category, and gender: compound uses 3s; recurve advanced and guest/senior league use 3s; other recurve and barebow use 40.

When **Replace all 3s faces with Vegas** is enabled, every archer who would use a 3s face is labeled `Vegas`. Vegas has no face-pair constraint and may occupy any position. A Double target may have zero through four Vegas archers, including all four positions; a Single target is limited by its two available positions. Vegas uses the same physical shape as a 40 face, so targets may combine Vegas and 40 faces.

Without Vegas mode, the physical face pairs on a Double target are `A/C` and `B/D`; each pair must use a compatible face. The solver enforces this as a hard constraint. Single targets have the `A/B` pair.

## Manage the draw

The generated schedule shows a session summary, archer counts by class, and the shooting list. Use the tools under **Modify the draw** to make changes:

- **Edit archer**: change roster fields and regenerate while preferring to preserve existing allocations.
- **Duplicate archer into another session**: add a copy to a different session with a new membership number. The copy is a guest and is excluded from head-to-heads; the original is unchanged.
- **Delete an archer or allocation**: remove one allocation only, or remove the archer from every session and from the roster.
- **Batch session changes**: enter one allocation and destination session per line, for example `1.14A 2`. Changes are validated and solved together.
- **Swap session/target**: either set a session preference (for example `1, 3`) and regenerate, or move an archer to an occupied or empty position. Direct moves are checked for face compatibility.
- **Swap target face type**: enter comma-separated allocations such as `1.14A, 2.16B`. Each archer is switched to the opposite face type, and the app tries the changes together before trying each direction separately. If the current schedule uses Vegas, it is treated as a 3s face for this operation.
- **Swap target block numbers**: swap target numbers without changing sessions or archer positions. Use `8-9` to swap those target numbers in every session, or `1.8-9` to restrict the swap to session 1.
- **Swap archer class**: enter one allocation and destination class per line, for example `1.14A RBF`. Valid class codes include `BBO`, `BBF`, `BIO`, `BIF`, `BAO`, `BAF`, `BG`, `BS`, the corresponding `R` classes, and `CO`, `CF`, `CG`, `CS`. The app updates the roster and regenerates the draw.

An allocation is written as `session.target-position`, such as `1.14A`. Changes that regenerate the draw respect the current grouping and Vegas settings.

## Export

- **Download Excel workbook**: includes `Shooting List`, `Head to Heads`, and `Session Summary` sheets.
- **Download shooting list CSV**: exports the current allocation table.
- **IANSEO participant import**: copy the displayed headerless, tab-separated 21-column data into IANSEO List Load, or download the TSV file. The preview shows the exported columns and values.

IANSEO export requires a membership number, a current allocation, a valid class code, and a configured IANSEO short name for every college. If an export is not ready, the app reports what data or configuration is missing.

## Configuration

Edit `config.json` beside `app.py`:

| Key | Purpose |
| --- | --- |
| `default_session_by_college` | Soft default session by college code, for example `"QUB": 2`. |
| `malleable_colleges` | Colleges that have no default-session preference. |
| `session_days` | Optional mapping from session number (as a string) to a day label containing `Saturday` or `Sunday`; used to restrict Saturday-only and Sunday-only archers. An empty object disables these restrictions. |
| `solver_time_limit_seconds` | Maximum solver time in seconds. |
| `college_short_names` | College-code to IANSEO country-name mapping used in participant exports. |

All five keys are required. The app reports a configuration error if the file or a key is missing or malformed.

## Browser edition (Cloudflare Pages)

The `browser/` directory contains a static edition of the same app that runs entirely in the visitor's browser, with no backend, database, or paid Cloudflare service. Roster data and the current draw stay in memory in that browser tab and are discarded when it is reloaded. It reads the same `config.json` as the Streamlit edition.

It has the same features as the Streamlit edition:

- Import rosters from CSV, TSV, TAB, TXT, XLSX or ODS (including IANSEO exports and headerless List Load files), or copy an existing schedule.
- Generate schedules with the same rules and preferences: Campanile, Cluster by class or Standard grouping, Vegas faces, college default sessions, and keeping existing allocations when regenerating.
- Edit the draw: edit an archer, duplicate an archer into another session, delete allocations or archers, batch session changes, session/target swaps, target face swaps, target block number swaps and class swaps.
- Head-to-head analysis, the session summary and class counts.
- Download the Excel workbook or the shooting list CSV, and copy or download the IANSEO participant import.

The solver is HiGHS (a MIP solver compiled to WebAssembly) running in a Web Worker, in place of OR-Tools. It optimises the same weighted objective as `solve_schedule()` within `solver_time_limit_seconds`. A draw that fills every place while an odd number of archers shoot 3s faces is impossible (a full target holds 0, 2 or 4 such archers), so the page flags it and disables generation. A setup with more targets than the roster can fill (every target needs archers from two colleges) is flagged the same way. The browser edition also adds targets to the untouched default setup when it is too small for the roster.

Generate schedule always builds on the draw on screen, generated or copied, keeping existing allocations where they remain valid. Changing the setup only marks that draw as out of date, so several changes need one solve. Copying a schedule sets the session setup to the copied layout (highest target used per session, Double when C or D positions are used).

Where the two editions intentionally differ:

- A headerless IANSEO List Load CSV/TSV keeps its first archer (the Streamlit edition reads that row as a header and drops it).
- A duplicated archer keeps the source archer's actual face, as in the Streamlit edition, but is also placed by that face (the Streamlit edition places it by the Guest face, which can leave an incompatible face pair).
- Face overrides persist. A face set by "Swap target face type", kept by a duplicated archer, or recorded in a copied schedule applies to every later regeneration. It is cleared when that archer's bow, category or gender changes, when the archer is removed, or when a later face swap returns them to their usual face. Overridden faces are marked in the roster table. (The Streamlit edition applies a face swap to one solve only.)

SheetJS, used for XLSX/ODS files, is vendored in `browser/vendor/` from the official SheetJS distribution; the npm registry's `xlsx` package is outdated.

### Run locally

```bash
cd browser
npm ci
npm run dev
```

Run the browser scheduler tests and create the Pages production build with:

```bash
npm test
npm run build
```

`tests/parity.test.js` compares the browser ports with outputs recorded from `app.py`. After changing `app.py`, regenerate them from the repository root and rerun the tests:

```bash
.venv/bin/python browser/tests/python_parity.py
```

### Deploy from GitHub

The browser edition is on the `browser-scheduler-pages` branch. To have Cloudflare deploy it automatically when changes are merged into `main`:

1. In Cloudflare, open **Workers & Pages** and create a **Pages** project connected to `Kya-ra/archery-scheduler` on GitHub.
2. Set the production branch to `main` and the project root directory to `browser`.
3. Set the build command to `npm run build` and the output directory to `dist`.
4. Save and deploy. Each new commit on `main`, including a merged pull request, will trigger a new static deployment.
5. In the Pages project's **Custom domains** settings, add `ianseo.kyara.ie`. Complete the DNS setup Cloudflare presents; if your DNS is hosted elsewhere, add the requested CNAME record after associating the domain with the Pages project.

Cloudflare Pages is free for this static deployment. Do not use the original root-level Dockerfile or the Streamlit entry point as the Pages build; those are for the server-backed edition.