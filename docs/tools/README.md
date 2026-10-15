# Documentation Validation

Run from the project root:

```powershell
python -m pip install -r docs/tools/requirements.txt
npm.cmd run docs:check
```

Python >= 3.11 with jsonschema 4.26.0 is required. [requirements.txt](requirements.txt) pins the schema validator with format-check dependencies; Python supplies SQLite. The [Node launcher](validate-docs.mjs) finds a compatible local interpreter and runs [validate_docs.py](validate_docs.py). Set DESZO_DOCS_PYTHON to an interpreter path to choose one explicitly. Missing prerequisites produce a failing command with setup instructions; checks are never silently skipped. The check itself is offline and installs nothing.

## Checked assets

- All [JSON schemas](../schemas/) compile and local references resolve without network access.
- [Positive cases](../fixtures/manifest.json) and [negative cases](../fixtures/invalid/cases.json) validate their expected phase. A semantic-negative case must first pass JSON Schema and then produce its named error.
- Workflow DAG/ports/template slots, provider uniqueness, ordered Context use and advertised timeout compatibility are checked.
- The round-recovery map/index are checked for dependency cycles, section/reference closure, output scopes, engine-producing roles, embedded Agent-role references and test-command path dependencies.
- Markdown local links/anchors, fence balance, English authored prose and typed JSON examples are checked.
- [Decision fixtures](../fixtures/decisions.json) pin failure draining, independent Context review outcomes, creation/dispatch binding checks, cross-workspace capacity, all-inactive joins and Map verification bounds.
- [SQL fixtures](../fixtures/sql-cases.json) load [the reference DDL](../storage/m1.sql) into an in-memory database and test constraints, Context lookups, inline envelopes and fenced seek pagination.

## What this establishes

This is a documentation checker and a reference oracle for fixture expectations. It does not import the prototype engine, invoke a provider/tool, prove Windows Job cleanup, create workflow runs, or claim those runtime behaviors are implemented.

The M1 validator must consume the **same** fixture manifest and mutation format through its own implementation. Later runtime tests must consume relevant decision fixtures and exercise real scheduling, capture, persistence/recovery and IPC. Passing the reference oracle alone is not runtime exit evidence. Full M2–M6 workflow/Gate/template/event schemas remain separate milestone prerequisites.

[Fixture format and limits](../fixtures/README.md) describe reuse. The earlier v0.6 resolution's one-off checks were not saved at the time; this version supplies reproducible replacement checks, with current counts in [the v0.8 resolution](../reviews/2026-10-13-third-review-resolution.md). Historical response counts describe their recorded version.
