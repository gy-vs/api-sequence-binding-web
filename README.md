# API Scenario Studio

Local workbench for request sequences.

Run `npm install`, then `npm run dev`.

## Scenario format

A scenario's content is a JSON document with a `steps` array. Steps run in
order; each step is one HTTP request that can extract variables for later
steps:

```json
{
  "steps": [
    {
      "id": "login",
      "method": "POST",
      "url": "http://127.0.0.1:4174/api/bootstrap",
      "headers": {"content-type": "application/json"},
      "body": "{\"user\": \"{{username}}\"}",
      "skipIf": "{{loggedIn}}",
      "onExtractError": "abort",
      "extract": [
        {"name": "token", "from": "header", "key": "x-auth-token"},
        {"name": "userId", "from": "json", "key": "$.user.id"}
      ]
    }
  ]
}
```

- `{{name}}` references work in `url`, header values, `body` and `skipIf`.
- `extract[].from` is `header` (case-insensitive) or `json` (a path like
  `$.user.tags[1]` — dot segments, `[n]` array indexes and `["quoted keys"]`).
- `skipIf`: the step is skipped when the resolved value is boolean `true` or
  the string `"true"`.
- `onExtractError`: `abort` fails the run, `skip` continues (see atomicity).

## Semantics

- **Typed values.** Extracted values keep their raw JSON type
  (string/number/boolean/object/array). In templates, strings are inserted
  as-is; non-strings are inserted as their JSON text, so
  `{"id": {{userId}}}` with `userId = 42` renders `{"id": 42}`.
- **Overwrite rule.** Within a step, extractions apply in order — a later
  extraction with the same name wins. Across steps, a later step's extraction
  overwrites an earlier variable with the same name.
- **Atomicity.** A step's extractions are computed first and applied as one
  batch only if every extraction succeeds. On any failure the step applies
  nothing: `abort` fails the run, `skip` continues with the variable store
  untouched. A variable is never left half-updated.
- **Pinned revision.** A run snapshots the scenario definition and revision at
  creation; editing the scenario while a run executes never affects that run.
  `POST /api/scenarios/:id/runs` accepts `expectedRevision` to reject starting
  from a stale revision (409).
- **Step records.** Each step records the rendered request (the values
  actually used, not the latest variable values), the response (truncated),
  per-extraction results and the variable snapshot after the step.
- **Cancel.** `POST /api/runs/:runId/cancel` aborts the in-flight request and
  skips remaining steps. A single guarded transition decides the terminal
  state (`completed` / `failed` / `cancelled`): a cancel racing the final
  step's completion produces exactly one terminal state, and a second cancel
  or a cancel after completion is rejected with 409.
- **Persistence.** Runs are kept on the server; after a page refresh the run
  list and every finished step's record are still available via
  `GET /api/scenarios/:id/runs` and `GET /api/runs/:runId`.

## Editing

The editor offers a structured **Steps** view (reorder with the arrow
buttons) and a raw **Source** view; both edit the same draft saved through
the existing revision-checked save flow. Undefined variable references,
duplicate extractions and invalid JSON paths are flagged live while editing
and by `POST /api/scenarios/:id/analyze`.

## API

- `GET/PUT /api/scenarios/:id` — load / save (optimistic concurrency via `revision`)
- `POST /api/scenarios/:id/analyze` — static diagnostics for a draft
- `POST /api/scenarios/:id/runs` — start a run (`{delayMs, timeoutMs, expectedRevision}`)
- `GET /api/scenarios/:id/runs` — run summaries, newest first
- `GET /api/runs/:runId` — full run record with per-step details
- `POST /api/runs/:runId/cancel` — cancel a running run (409 once finished)

## Tests

`npm test` covers the shared semantics (templating, JSON paths, analysis) and
the HTTP API against a real local target server: conditional skips, duplicate
variables, array JSON paths, non-string values, step reordering, edits during
execution, extraction-failure atomicity (abort/skip), cancellation and its
race with completion, and run persistence across reloads.
