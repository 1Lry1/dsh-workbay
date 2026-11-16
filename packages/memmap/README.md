# dsh-workbench-memmap

Workbench page that turns a firmware build's linker map into a memory report you
can read without leaving DSH.

## What it does

1. **Detect** — looks for the newest map under the workspace (`Output/bin/map.txt`,
   a loose `map.txt`, or up to three ancestor SDK directories). The analysis
   script itself is **bundled with this plugin** (`tools/memmap_report.py`), so a
   project does not need its own `tools/` copy; a workspace copy still wins. When
   no map is found the page accepts a manual absolute path and remembers it.
2. **Run** — spawns the SDK's own script with an argv array (no shell), writing
   `memmap_data.json` + `memmap_report.html` into the plugin data directory.
3. **Show** — storage cards (internal RAM / PSRAM / Flash), per-region usage with
   a category composition bar, the delta against the previous run, recent runs,
   the largest variables/buffers and top object files — plus the full generated
   HTML report embedded in a blob iframe.
4. **Auto-run** — entering the page with a `map.txt` that is newer than the last
   run (or with no history at all) runs the analysis once, without a click.

Nothing is written into the user's repository. Each run lives under:

```
~/.dsh/workbench/memmap/roots/<sha1(workspace)>/runs/<runId>/
  memmap_data.json
  memmap_report.html
  summary.json
```

The last `keepRuns` (default 10) runs are kept; older ones are pruned.

## Requirements

- Python 3 on `PATH` (or a configured command). The script itself is
  standard-library only.
- The SDK tool at `tools/memmap_report/memmap_report.py`, and a GNU ld
  `map.txt` build artifact. lld / readelf maps are rejected by the script and the
  page shows its stderr verbatim.

## Config

| Key | Default | Meaning |
|---|---|---|
| `python` | `"python"` | Interpreter command. String, or an array for `py -3` / venv paths. |
| `timeoutMs` | `180000` | Kill the analysis after this long. |
| `keepRuns` | `10` | Runs kept per workspace (1–50). |
| `dataDir` | `~/.dsh/workbench/memmap` | Root for run artefacts. |

## RPC surface

`POST /dsh-workbench-memmap/api/<method>`

| Method | Purpose |
|---|---|
| `detect` | `{ root }` → tool path, maps, python status, latest run summary, history |
| `run` | `{ root, map? }` → summary + delta + history + stdout |
| `runs` | `{ root }` → history entries |
| `report` | `{ root, runId }` → the generated HTML |

## Tests

```bash
node --test packages/memmap/tests/host.test.mjs packages/memmap/tests/client.test.mjs
```

The host tests boot the plugin with a fake interpreter
(`tests/fixtures/fake_memmap_runner.mjs`), so they never depend on Python being
installed; the fake can be told to fail or to grow a region, which is how the
failure and baseline-delta paths are covered.
