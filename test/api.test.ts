import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createServer, type IncomingHttpHeaders} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createApp, finishRun} from '../src/server/index';
import type {RunRecord} from '../src/shared/scenario';

const app = createApp();

async function waitForRun(id: string, timeout = 8000): Promise<RunRecord> {
  const t0 = Date.now();
  for (;;) {
    const r = await request(app).get('/api/runs/' + id);
    expect(r.status).toBe(200);
    if (r.body.status !== 'running') return r.body as RunRecord;
    if (Date.now() - t0 > timeout) throw new Error('run did not finish: ' + JSON.stringify(r.body));
    await new Promise(res => setTimeout(res, 20));
  }
}

async function putScenario(id: string, content: string) {
  const before = await request(app).get('/api/scenarios/' + id).expect(200);
  const r = await request(app).put('/api/scenarios/' + id).send({content, revision: before.body.revision});
  expect(r.status).toBe(200);
  return r.body;
}

async function startRun(id: string, extra: Record<string, unknown> = {}) {
  const r = await request(app).post(`/api/scenarios/${id}/runs`).send(extra);
  expect(r.status).toBe(201);
  return r.body as RunRecord;
}

type Received = {method: string; url: string; headers: IncomingHttpHeaders; body: string};
let target: {url: string; received: Received[]; close: () => void};

beforeAll(async () => {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      received.push({method: req.method!, url: req.url!, headers: req.headers, body});
      const path = new URL(req.url!, 'http://target').pathname;
      if (path === '/login') {
        res.writeHead(200, {'content-type': 'application/json', 'x-auth-token': 'hdr-abc'});
        res.end(JSON.stringify({token: 't-123', user: {id: 42, name: 'ada', admin: true, tags: ['a', 'b', 'c']}, items: [{id: 1}, {id: 2}]}));
      } else if (path === '/empty') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{}');
      } else if (path === '/slow') {
        setTimeout(() => {
          res.writeHead(200, {'content-type': 'application/json'});
          res.end('{"ok":true}');
        }, 400);
      } else if (path === '/echo') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({method: req.method, url: req.url, body}));
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  target = {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => server.close()};
});
afterAll(() => target.close());

describe('service', () => {
  it('loads and conditionally updates a record', async () => {
    const before = await request(app).get('/api/scenarios/alpha').expect(200);
    await request(app).put('/api/scenarios/alpha').send({content: 'updated', revision: before.body.revision}).expect(200);
    await request(app).put('/api/scenarios/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });
});

describe('analyze', () => {
  it('reports undefined references and duplicate extractions as diagnostics', async () => {
    const content = JSON.stringify({
      steps: [
        {id: 'a', url: 'http://x/', extract: [{name: 'v', from: 'json', key: '$.a'}, {name: 'v', from: 'json', key: '$.b'}]},
        {id: 'b', url: 'http://x/?q={{ghost}}'},
      ],
    });
    const r = await request(app).post('/api/scenarios/alpha/analyze').send({content}).expect(200);
    expect(r.body.diagnostics.some((d: {level: string; message: string}) => d.level === 'error' && d.message.includes('"ghost"'))).toBe(true);
    expect(r.body.diagnostics.some((d: {level: string; message: string}) => d.level === 'warning' && d.message.includes('duplicate'))).toBe(true);
  });
  it('flags content that is not a scenario', async () => {
    const r = await request(app).post('/api/scenarios/alpha/analyze').send({content: 'plain text'}).expect(200);
    expect(r.body.diagnostics[0].level).toBe('error');
  });
});

describe('runs', () => {
  it('executes steps, extracts from headers/json/array paths and substitutes typed values', async () => {
    await putScenario('alpha', JSON.stringify({
      steps: [
        {
          id: 'login',
          method: 'GET',
          url: target.url + '/login',
          extract: [
            {name: 'token', from: 'header', key: 'X-Auth-Token'},
            {name: 'userId', from: 'json', key: '$.user.id'},
            {name: 'admin', from: 'json', key: '$.user.admin'},
            {name: 'secondTag', from: 'json', key: '$.user.tags[1]'},
            {name: 'firstItem', from: 'json', key: '$.items[0]'},
            {name: 'allTags', from: 'json', key: '$.user.tags'},
          ],
        },
        {
          id: 'use',
          method: 'POST',
          url: target.url + '/echo?token={{token}}&tag={{secondTag}}',
          headers: {'x-user-id': '{{userId}}', 'content-type': 'application/json'},
          body: '{"id": {{userId}}, "admin": {{admin}}, "item": {{firstItem}}, "tags": {{allTags}}, "who": "{{token}}"}',
        },
      ],
    }));
    const started = await startRun('alpha');
    expect(started.revision).toBeGreaterThan(0);
    const run = await waitForRun(started.id);
    expect(run.status).toBe('completed');
    const [login, use] = run.steps;
    expect(login.status).toBe('success');
    // typed variables: numbers/booleans/objects stay non-string in the store
    expect(login.variablesAfter).toMatchObject({token: 'hdr-abc', userId: 42, admin: true, secondTag: 'b', firstItem: {id: 1}, allTags: ['a', 'b', 'c']});
    // the run view shows the values actually used by the step, not latest values
    expect(use.request!.url).toBe(target.url + '/echo?token=hdr-abc&tag=b');
    expect(use.request!.headers['x-user-id']).toBe('42');
    expect(JSON.parse(use.request!.body!)).toEqual({id: 42, admin: true, item: {id: 1}, tags: ['a', 'b', 'c'], who: 'hdr-abc'});
    expect(use.response!.status).toBe(200);
    const echo = target.received.find(r => r.url.startsWith('/echo'))!;
    expect(echo.headers['x-user-id']).toBe('42');
    expect(JSON.parse(echo.body).id).toBe(42);
  });

  it('skips steps conditionally on extracted values', async () => {
    const scenario = (skipIf: string) => JSON.stringify({
      steps: [
        {id: 'login', url: target.url + '/login', extract: [{name: 'admin', from: 'json', key: '$.user.admin'}]},
        {id: 'guarded', url: target.url + '/echo?guarded=1', skipIf},
        {id: 'after', url: target.url + '/echo?after=1'},
      ],
    });
    await putScenario('alpha', scenario('{{admin}}')); // admin === true -> skip
    const skipped = await waitForRun((await startRun('alpha')).id);
    expect(skipped.status).toBe('completed');
    expect(skipped.steps.map(s => s.status)).toEqual(['success', 'skipped', 'success']);
    expect(skipped.steps[1].request).toBeUndefined();
    expect(target.received.filter(r => r.url.includes('guarded'))).toHaveLength(0);

    await putScenario('alpha', scenario('false')); // literal false -> never skip
    const ran = await waitForRun((await startRun('alpha')).id);
    expect(ran.steps.map(s => s.status)).toEqual(['success', 'success', 'success']);
    expect(target.received.filter(r => r.url.includes('guarded'))).toHaveLength(1);
  });

  it('resolves duplicate variables: last extraction in a step wins, later steps overwrite', async () => {
    await putScenario('alpha', JSON.stringify({
      steps: [
        {
          id: 'first',
          url: target.url + '/login',
          extract: [
            {name: 'dup', from: 'json', key: '$.user.id'},
            {name: 'dup', from: 'json', key: '$.user.name'},
            {name: 'token', from: 'json', key: '$.token'},
          ],
        },
        {id: 'second', url: target.url + '/login', extract: [{name: 'token', from: 'header', key: 'x-auth-token'}]},
        {id: 'show', url: target.url + '/echo?dup={{dup}}&token={{token}}'},
      ],
    }));
    const run = await waitForRun((await startRun('alpha')).id);
    expect(run.status).toBe('completed');
    expect(run.steps[0].variablesAfter).toMatchObject({dup: 'ada', token: 't-123'}); // within-step: last wins
    expect(run.steps[1].variablesAfter!.token).toBe('hdr-abc'); // across steps: later overwrites
    expect(run.steps[2].request!.url).toBe(target.url + '/echo?dup=ada&token=hdr-abc');
  });

  it('reorders steps to change which extraction a reference sees', async () => {
    const stepA = {id: 'a', url: target.url + '/login', extract: [{name: 'x', from: 'json', key: '$.user.name'}]};
    const stepB = {id: 'b', url: target.url + '/login', extract: [{name: 'x', from: 'json', key: '$.token'}]};
    const show = {id: 'show', url: target.url + '/echo?x={{x}}'};
    await putScenario('alpha', JSON.stringify({steps: [stepA, stepB, show]}));
    const ab = await waitForRun((await startRun('alpha')).id);
    expect(ab.steps[2].request!.url).toBe(target.url + '/echo?x=t-123');
    await putScenario('alpha', JSON.stringify({steps: [stepB, stepA, show]}));
    const ba = await waitForRun((await startRun('alpha')).id);
    expect(ba.steps[2].request!.url).toBe(target.url + '/echo?x=ada');
  });

  it('aborts on extraction failure without half-applying the step variables', async () => {
    await putScenario('alpha', JSON.stringify({
      steps: [
        {id: 'seed', url: target.url + '/login', extract: [{name: 'kept', from: 'json', key: '$.token'}]},
        {
          id: 'fragile',
          url: target.url + '/login',
          onExtractError: 'abort',
          extract: [
            {name: 'good', from: 'json', key: '$.user.id'},
            {name: 'bad', from: 'json', key: '$.missing.deep'},
          ],
        },
        {id: 'never', url: target.url + '/echo?never=1'},
      ],
    }));
    const run = await waitForRun((await startRun('alpha')).id);
    expect(run.status).toBe('failed');
    expect(run.steps[1].status).toBe('failed');
    expect(run.steps[1].error).toMatch(/bad/);
    expect(run.steps[2].status).toBe('pending'); // never executed
    // atomicity: the good extraction from the failed step was NOT applied
    expect(run.steps[1].variablesAfter).toEqual({kept: 't-123'});
    expect(run.variables).toEqual({kept: 't-123'});
    expect(target.received.filter(r => r.url.includes('never'))).toHaveLength(0);
  });

  it('skips a failed extraction batch when configured, leaving variables untouched', async () => {
    await putScenario('alpha', JSON.stringify({
      steps: [
        {id: 'seed', url: target.url + '/login', extract: [{name: 'kept', from: 'json', key: '$.token'}]},
        {
          id: 'fragile',
          url: target.url + '/empty',
          onExtractError: 'skip',
          extract: [
            {name: 'good', from: 'json', key: '$.user.id'},
            {name: 'bad', from: 'json', key: '$.missing'},
          ],
        },
        {id: 'after', url: target.url + '/echo?kept={{kept}}'},
      ],
    }));
    const run = await waitForRun((await startRun('alpha')).id);
    expect(run.status).toBe('completed');
    expect(run.steps[1].status).toBe('success');
    expect(run.steps[1].error).toMatch(/extraction skipped/);
    expect(run.steps[1].variablesAfter).toEqual({kept: 't-123'}); // nothing half-applied
    expect(run.variables).toEqual({kept: 't-123'});
    expect(run.steps[2].request!.url).toBe(target.url + '/echo?kept=t-123');
  });

  it('fails a step that references an undefined variable at runtime', async () => {
    await putScenario('alpha', JSON.stringify({steps: [{id: 'a', url: target.url + '/login'}, {id: 'b', url: target.url + '/echo?x={{ghost}}'}]}));
    const run = await waitForRun((await startRun('alpha')).id);
    expect(run.status).toBe('failed');
    expect(run.steps[0].status).toBe('success');
    expect(run.steps[1].status).toBe('failed');
    expect(run.steps[1].error).toMatch(/ghost/);
  });

  it('pins the scenario revision: edits during execution do not affect the run', async () => {
    const before = await putScenario('alpha', JSON.stringify({
      steps: [
        {id: 'one', url: target.url + '/echo?mark=original'},
        {id: 'two', url: target.url + '/echo?mark=original2'},
      ],
    }));
    const started = await startRun('alpha', {delayMs: 200});
    expect(started.revision).toBe(before.revision);
    // modify the scenario while the run is in flight
    await putScenario('alpha', JSON.stringify({steps: [{id: 'one', url: target.url + '/echo?mark=edited'}]}));
    const run = await waitForRun(started.id);
    expect(run.status).toBe('completed');
    expect(run.revision).toBe(before.revision);
    expect(run.steps).toHaveLength(2);
    const marks = target.received.filter(r => r.url.includes('mark=')).map(r => r.url);
    expect(marks).toEqual(['/echo?mark=original', '/echo?mark=original2']);
    const after = await request(app).get('/api/scenarios/alpha').expect(200);
    expect(after.body.revision).toBe(before.revision + 1);
  });

  it('rejects run creation when the caller pins a stale revision', async () => {
    const row = await request(app).get('/api/scenarios/alpha').expect(200);
    await request(app).post('/api/scenarios/alpha/runs').send({expectedRevision: row.body.revision + 99}).expect(409);
  });

  it('refuses to run content that is not a valid scenario', async () => {
    await putScenario('beta', 'request sequences: beta\nstate: review');
    const r = await request(app).post('/api/scenarios/beta/runs').send({});
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('invalid_scenario');
  });

  it('fails the run when a request times out', async () => {
    await putScenario('alpha', JSON.stringify({steps: [{id: 'slow', url: target.url + '/slow'}]}));
    const run = await waitForRun((await startRun('alpha', {timeoutMs: 100})).id);
    expect(run.status).toBe('failed');
    expect(run.steps[0].status).toBe('failed');
    expect(run.steps[0].error).toMatch(/timed out/);
  });

  it('cancels a running run and never executes the remaining steps', async () => {
    await putScenario('alpha', JSON.stringify({
      steps: [
        {id: 'one', url: target.url + '/echo?n=1'},
        {id: 'two', url: target.url + '/echo?n=2'},
        {id: 'three', url: target.url + '/echo?n=3'},
      ],
    }));
    const started = await startRun('alpha', {delayMs: 250});
    // wait until the first step is done, then cancel while the run sleeps
    let mid: RunRecord | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await request(app).get('/api/runs/' + started.id);
      if (r.body.steps[0].status === 'success') {
        mid = r.body;
        break;
      }
      await new Promise(res => setTimeout(res, 15));
    }
    expect(mid?.steps[0].status).toBe('success');
    const cancelled = await request(app).post(`/api/runs/${started.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    const run = await waitForRun(started.id);
    expect(run.status).toBe('cancelled');
    expect(run.steps[0].status).toBe('success');
    expect(['cancelled', 'pending']).toContain(run.steps[1].status);
    expect(run.steps.every((s, i) => i === 0 || s.status !== 'success')).toBe(true);
    expect(target.received.filter(r => r.url === '/echo?n=2' || r.url === '/echo?n=3')).toHaveLength(0);
  });

  it('settles the cancel/finish race with exactly one terminal state', async () => {
    // cancel while the single (slow) step is in flight
    await putScenario('alpha', JSON.stringify({steps: [{id: 'slow', url: target.url + '/slow'}]}));
    const started = await startRun('alpha');
    await new Promise(res => setTimeout(res, 100));
    const [a, b] = await Promise.all([
      request(app).post(`/api/runs/${started.id}/cancel`),
      request(app).post(`/api/runs/${started.id}/cancel`),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]); // exactly one transition wins
    const run = await waitForRun(started.id);
    expect(run.status).toBe('cancelled');
    expect(run.steps[0].status).toBe('cancelled');
    // cancel after completion is rejected and cannot rewrite the terminal state
    await putScenario('alpha', JSON.stringify({steps: [{id: 'fast', url: target.url + '/echo?fast=1'}]}));
    const done = await waitForRun((await startRun('alpha')).id);
    expect(done.status).toBe('completed');
    await request(app).post(`/api/runs/${done.id}/cancel`).expect(409);
    const again = await request(app).get('/api/runs/' + done.id);
    expect(again.body.status).toBe('completed');
  });

  it('finishRun guard allows a single terminal transition', () => {
    const run: RunRecord = {id: 'r', scenarioId: 's', revision: 1, status: 'running', definition: {steps: []}, variables: {}, steps: [], stepDelayMs: 0, timeoutMs: 1000, createdAt: ''};
    expect(finishRun(run, 'completed')).toBe(true);
    expect(finishRun(run, 'cancelled')).toBe(false);
    expect(finishRun(run, 'failed')).toBe(false);
    expect(run.status).toBe('completed');
  });

  it('keeps completed runs queryable after the client reloads', async () => {
    await putScenario('alpha', JSON.stringify({
      steps: [
        {id: 'login', url: target.url + '/login', extract: [{name: 'token', from: 'json', key: '$.token'}]},
        {id: 'use', url: target.url + '/echo?t={{token}}'},
      ],
    }));
    const done = await waitForRun((await startRun('alpha')).id);
    expect(done.status).toBe('completed');
    // a fresh client would list runs for the scenario, then fetch the detail
    const list = await request(app).get('/api/scenarios/alpha/runs').expect(200);
    const summary = list.body.find((r: {id: string}) => r.id === done.id);
    expect(summary).toMatchObject({status: 'completed', steps: 2, finishedSteps: 2, revision: done.revision});
    const detail = await request(app).get('/api/runs/' + done.id).expect(200);
    expect(detail.body.steps[0]).toMatchObject({stepId: 'login', status: 'success'});
    expect(detail.body.steps[0].variablesAfter).toEqual({token: 't-123'});
    expect(detail.body.steps[1].request.url).toBe(target.url + '/echo?t=t-123');
    expect(detail.body.steps[1].response.status).toBe(200);
  });
});
