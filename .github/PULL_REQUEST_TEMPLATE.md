## What

<!-- One or two sentences: what changes for the user, and which package(s) it touches. -->

## Why

<!-- The problem this solves. Link the issue (`Closes #123`) when there is one. -->

## How tested

<!--
Be concrete: which command did you run, and what did you see? For UI changes,
say which DSH version and Windows build you checked in, and attach a screenshot
with secrets/paths redacted. For gitcraft, "pnpm --filter dsh-gitcraft run test"
plus a manual pass in the panel is the baseline.
-->

- [ ] `pnpm test` (or the per-package commands touched by this change)
- [ ] Manual check in a running DSH profile (skip for docs-only changes)

## Checklist

- [ ] Tests pass: `pnpm test` / `pnpm --filter <pkg> run test`
- [ ] No machine-specific paths, environment values, DSH profile contents, or customer/project names are committed
- [ ] Browser-side changes keep the client half a self-contained `window.__ModuleLoader__.load({ id, factory })` file (no new npm imports, no imports from this repo)
- [ ] `@dsh-workbay/kit` is only imported from host halves
- [ ] Docs updated if behavior, install steps or the page contract changed (README / package README / `docs/architecture.md`)
- [ ] No commit of `node_modules/`, `*.log`, `*.bak*` or generated artifacts
