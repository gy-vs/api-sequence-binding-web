import express from 'express';
import {fileURLToPath} from 'node:url';
import {analyzeDoc, parseScenario, stringifyDoc, emptyDoc} from '../shared/scenario';
import type {RunRecord, ScenarioDoc} from '../shared/types';
import {executeRun, RunStore, type Transport} from './runner';
import {fetchTransport} from './transport';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};

function seedDoc(): string {
  const doc = emptyDoc();
  doc.initialVariables = {baseUrl: '/mock', token: ''};
  // emptyDoc creates a single step; rebuild a small illustrative scenario.
  doc.steps = [
    {
      id: 'step-1', name: '登录并取 token', enabled: true, method: 'POST',
      url: '{{baseUrl}}/login',
      headers: [{name: 'content-type', value: 'application/json'}],
      body: JSON.stringify({user: 'alice'}),
      condition: null, onExtractFailure: 'terminate',
      extract: [
        {name: 'token', source: 'json', path: '$.token'},
        {name: 'traceId', source: 'header', path: 'x-trace-id'},
      ],
    },
    {
      id: 'step-2', name: '查询订单（数组路径）', enabled: true, method: 'GET',
      url: '{{baseUrl}}/orders',
      headers: [{name: 'authorization', value: 'Bearer {{token}}'}],
      body: '',
      condition: {variable: 'token', op: 'notEmpty'},
      onExtractFailure: 'terminate',
      extract: [{name: 'firstOrderId', source: 'json', path: '$.items[0].id'}],
    },
    {
      id: 'step-3', name: '获取订单详情', enabled: true, method: 'GET',
      url: '{{baseUrl}}/orders/{{firstOrderId}}',
      headers: [{name: 'x-trace', value: '{{traceId}}'}],
      body: '', condition: null, onExtractFailure: 'skip',
      extract: [],
    },
  ];
  return stringifyDoc(doc);
}

function seedRows(): RecordRow[] {
  return [
    {id: 'alpha', name: 'Primary request sequences', revision: 3, content: seedDoc(), updatedAt: new Date(0).toISOString()},
    {id: 'beta', name: 'Secondary request sequences', revision: 5, content: 'request sequences: beta\nstate: review', updatedAt: new Date(1000).toISOString()},
  ];
}

export interface AppOptions {
  transport?: Transport;
}

export function createApp(options: AppOptions = {}) {
  const transport = options.transport ?? fetchTransport;
  const runStore = new RunStore();
  const rows = seedRows();
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'api-scenario', count: rows.length}));
  app.get('/api/scenarios', (_req, res) => res.json(rows.map(({content, ...row}) => row)));
  app.get('/api/scenarios/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/scenarios/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/scenarios/:id/analyze', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const content = String(req.body.content ?? row.content);
    const {doc, diagnostics: parseDiagnostics} = parseScenario(content);
    const diagnostics = doc
      ? [...parseDiagnostics, ...analyzeDoc(doc)]
      : parseDiagnostics;
    res.json({
      id: row.id, revision: row.revision,
      lines: content.split(/\r?\n/).length,
      diagnostics,
    });
  });

  // -------------------------------------------------------------------------
  // Scenario runs: pinned revision snapshot, per-step history, cancellation.
  // -------------------------------------------------------------------------

  app.post('/api/scenarios/:id/runs', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const {doc, diagnostics} = parseScenario(row.content);
    if (!doc) {
      return res.status(422).json({error: 'not_a_scenario', diagnostics});
    }
    const structuralErrors = analyzeDoc(doc).filter(d => d.severity === 'error');
    if (structuralErrors.length) {
      return res.status(422).json({error: 'invalid_scenario', diagnostics: structuralErrors});
    }
    // Optional explicit revision pin from the client; default pins current.
    if (typeof req.body?.revision === 'number' && req.body.revision !== row.revision) {
      return res.status(409).json({
        error: 'revision_conflict',
        message: `场景已被修改（当前 revision ${row.revision}），请重新加载后再运行。`,
        current: row.revision,
      });
    }
    // Deep-copy snapshot: edits during execution never affect the run.
    const snapshotDoc = JSON.parse(JSON.stringify(doc)) as ScenarioDoc;
    const pinnedRevision = row.revision;
    const run = runStore.start(row.id, pinnedRevision, snapshotDoc);
    // Fire-and-forget; progress is observed via GET.
    void executeRun(run, snapshotDoc, transport).catch(error => {
      // Defensive: the runner handles expected failures; this guards transport bugs.
      run.status = run.status === 'running' ? 'failed' : run.status;
      if (!run.endedAt) run.endedAt = new Date().toISOString();
      if (!run.failure) run.failure = {stepId: '', message: String(error?.message ?? error)};
    });
    res.status(201).json(runStore.publicView(run));
  });

  app.get('/api/scenarios/:id/runs', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.json({runs: runStore.list(row.id)});
  });

  app.get('/api/runs/:runId', (req, res) => {
    const run = runStore.get(req.params.runId);
    if (!run) return res.status(404).json({error: 'not_found'});
    res.json(runStore.publicView(run));
  });

  app.post('/api/runs/:runId/cancel', (req, res) => {
    const run = runStore.get(req.params.runId);
    if (!run) return res.status(404).json({error: 'not_found'});
    // Idempotent request: never throws when already terminal; never itself
    // transitions status — the runner owns the single terminal write.
    run.cancelRequested = true;
    run.currentAbort?.abort();
    res.json(runStore.publicView(run));
  });

  // -------------------------------------------------------------------------
  // Built-in mock target so the seeded scenario is runnable end to end.
  // -------------------------------------------------------------------------

  app.post('/mock/login', (_req, res) => {
    res.set('x-trace-id', 'trace-7f31');
    res.json({token: 'tok-abc-123', ok: true});
  });
  app.get('/mock/orders', (_req, res) => {
    res.json({
      items: [
        {id: 9001, total: 42.5},
        {id: 9002, total: 17},
      ],
    });
  });
  app.get(/\/mock\/orders\/\d+$/, (req, res) => {
    res.json({id: Number(req.path.split('/').pop()), detail: 'ok'});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}

export type {RunRecord};
