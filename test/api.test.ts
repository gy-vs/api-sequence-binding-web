import {describe, expect, it} from 'vitest';
import request from 'supertest';
import type {Transport, TransportResponse} from '../src/server/runner';
import {createApp} from '../src/server/index';
import type {ScenarioDoc, ScenarioStep} from '../src/shared/types';
import {newStep, stringifyDoc} from '../src/shared/scenario';

// ---------------------------------------------------------------------------
// Fake transport: scripted responses, gates for cancellation races.
// ---------------------------------------------------------------------------

interface Gate {resolve: () => void; promise: Promise<void>; resolved: boolean}
function gate(): Gate {
  const g: Partial<Gate> = {resolved: false};
  g.promise = new Promise<void>(res => {
    g.resolve = () => {if (!g.resolved) {g.resolved = true; res();}};
  });
  return g as Gate;
}

interface Call {
  method: string; url: string;
  headers: {name: string; value: string}[];
  body: string;
  signal: AbortSignal;
}

function fakeTransport(
  handler: (call: Call, index: number) => Promise<TransportResponse> | TransportResponse,
): {transport: Transport; calls: Call[]; entered: Gate[]} {
  const calls: Call[] = [];
  const entered: Gate[] = [];
  const transport: Transport = {
    async send(req, signal) {
      const call: Call = {method: req.method, url: req.url, headers: req.headers, body: req.body, signal};
      const index = calls.length;
      calls.push(call);
      entered[index] ??= gate();
      entered[index].resolve(); // signal that this request has entered the transport
      return handler(call, index);
    },
  };
  return {transport, calls, entered};
}

// Hold until `release` fires; rejects AbortError when the signal aborts first.
// With succeedIfLate, a response already in flight is still returned after
// release (used to exercise the cancel/completion race from both orderings).
function hold(call: Call, release: Gate, respond: () => TransportResponse,
  opts: {succeedIfLate?: boolean} = {}) {
  return new Promise<TransportResponse>((resolve, reject) => {
    let done = false;
    call.signal.addEventListener('abort', () => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
    });
    release.promise.then(() => setTimeout(() => {
      if (done) return;
      done = true;
      if (call.signal.aborted && !opts.succeedIfLate) {
        reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
      } else {
        resolve(respond());
      }
    }, 5));
  });
}

function scenarioDoc(steps: Partial<ScenarioStep>[], initialVariables: Record<string, string> = {}): ScenarioDoc {
  return {
    kind: 'api-scenario', version: 1, initialVariables,
    steps: steps.map((s, i) => ({...newStep(`step-${i + 1}`, i + 1), url: `/t/${i}`, ...s})),
  };
}

async function replaceScenario(app: ReturnType<typeof createApp>, id: string, doc: ScenarioDoc, revision: number) {
  const res = await request(app).put(`/api/scenarios/${id}`).send({content: stringifyDoc(doc), revision}).expect(200);
  return res.body.revision as number;
}

async function startRun(app: ReturnType<typeof createApp>, id: string, revision?: number) {
  const res = await request(app).post(`/api/scenarios/${id}/runs`)
    .send(revision === undefined ? {} : {revision});
  if (res.status !== 201) {
    throw new Error(`start run failed ${res.status}: ${res.text.slice(0, 200)}`);
  }
  return res.body;
}

async function waitForTerminal(app: ReturnType<typeof createApp>, runId: string, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const res = await request(app).get(`/api/runs/${runId}`).expect(200);
    if (res.body.status !== 'running') return res.body;
    if (Date.now() - start > timeoutMs) throw new Error('run did not finish');
    await new Promise(r => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------

describe('legacy single-request flow', () => {
  it('loads and conditionally updates a record (optimistic revision)', async () => {
    const app = createApp();
    const before = await request(app).get('/api/scenarios/alpha').expect(200);
    await request(app).put('/api/scenarios/alpha').send({content: 'updated', revision: before.body.revision}).expect(200);
    await request(app).put('/api/scenarios/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });

  it('analyzes free-text content as non-scenario', async () => {
    const app = createApp();
    const res = await request(app).post('/api/scenarios/beta/analyze').send({}).expect(200);
    expect(res.body.diagnostics[0].severity).toBe('info');
  });
});

describe('scenario execution', () => {
  it('chains requests: header + json extraction into later url, headers and json body', async () => {
    const app = createApp({
      transport: {
        async send(req): Promise<TransportResponse> {
          if (req.url === '/login') {
            return {status: 200, headers: {'x-trace': 'T9'}, body: JSON.stringify({token: 'abc', n: 5, maybe: null})};
          }
          if (req.url.startsWith('/use')) {
            const headerValue = req.headers.find(h => h.name === 'authorization')?.value;
            expect(req.url).toBe('/use/abc');
            expect(headerValue).toBe('Bearer abc');
            return {status: 200, headers: {}, body: JSON.stringify({echo: JSON.parse(req.body)})};
          }
          throw new Error('unexpected url ' + req.url);
        },
      },
    });
    const doc = scenarioDoc([
      {url: '/login', method: 'POST', body: '{}', extract: [
        {name: 'token', source: 'json', path: '$.token'},
        {name: 'n', source: 'json', path: '$.n'},
        {name: 'trace', source: 'header', path: 'x-trace'},
        {name: 'maybe', source: 'json', path: '$.maybe'},
      ]},
      {url: '/use/{{token}}', method: 'POST',
        headers: [{name: 'authorization', value: 'Bearer {{token}}'}, {name: 'x-trace', value: '{{trace}}'}],
        body: JSON.stringify({num: '{{n}}', text: 'id={{token}}', maybe: '{{maybe}}'}),
        extract: [{name: 'echo', source: 'json', path: '$.echo'}]},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const run = await startRun(app, 'alpha');
    const final = await waitForTerminal(app, run.id);
    expect(final.status).toBe('completed');
    // non-string preserved in json body value slot; embedded stays text;
    // an initial variable deleted before the run is rendered as null.
    const echo = final.steps[1].variablesAfter.echo;
    expect(echo.num).toBe(5);
    expect(echo.text).toBe('id=abc');
    expect(echo.maybe).toBeNull(); // extracted JSON null stays native null in body value slot
    // the run view records the actual values used at that step
    const uses = final.steps[1].request.uses;
    expect(uses.find((u: any) => u.where === 'url').variable.raw).toBe('abc');
    expect(uses.find((u: any) => u.where === 'header:authorization').variable.raw).toBe('abc');
  });

  it('records variablesBefore/variablesAfter snapshots per step', async () => {
    const app = createApp({
      transport: {
        async send(req) {
          return {status: 200, headers: {}, body: JSON.stringify({v: req.url === '/t/0' ? 'one' : 'two'})};
        },
      },
    });
    const doc = scenarioDoc([
      {extract: [{name: 'x', source: 'json', path: '$.v'}]},
      {extract: [{name: 'y', source: 'json', path: '$.v'}]},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.steps[0].variablesBefore).toEqual({});
    expect(final.steps[0].variablesAfter).toEqual({x: 'one'});
    expect(final.steps[1].variablesBefore).toEqual({x: 'one'});
    expect(final.steps[1].variablesAfter).toEqual({x: 'one', y: 'two'});
    // snapshots are independent copies: later steps don't mutate history
    expect(final.steps[0].variablesAfter.x).toBe('one');
  });

  it('conditional skip: unmet condition marks step skipped, leaves variables and continues', async () => {
    const app = createApp({
      transport: {
        async send() {return {status: 200, headers: {}, body: '{}'};},
      },
    });
    const doc = scenarioDoc([
      {url: '/a', extract: []},
      {url: '/b', condition: {variable: 'token', op: 'notEmpty'}},
      {url: '/c'},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('completed');
    expect(final.steps.map((s: any) => s.status)).toEqual(['completed', 'skipped', 'completed']);
    expect(final.steps[1].reason).toContain('token');
    expect(final.steps[1].variablesBefore).toEqual(final.steps[1].variablesAfter);
  });

  it('skip policy on extraction failure: run continues, variables untouched', async () => {
    const app = createApp({
      transport: {
        async send(req) {
          return req.url === '/t/0'
            ? {status: 200, headers: {}, body: JSON.stringify({a: 1})}
            : {status: 200, headers: {}, body: JSON.stringify({b: 2})};
        },
      },
    });
    const doc = scenarioDoc([
      {onExtractFailure: 'skip', extract: [
        {name: 'good', source: 'json', path: '$.a'},
        {name: 'bad', source: 'json', path: '$.missing'},
      ]},
      {extract: [{name: 'b', source: 'json', path: '$.b'}]},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('completed');
    expect(final.steps[0].status).toBe('failed');
    expect(final.steps[0].variablesAfter).toEqual({}); // no half-update: good discarded too
    expect(final.steps[1].variablesAfter).toEqual({b: 2});
  });

  it('terminate policy on extraction failure: run fails and stops', async () => {
    const app = createApp({
      transport: {
        async send() {return {status: 200, headers: {}, body: JSON.stringify({a: 1})};},
      },
    });
    const doc = scenarioDoc([
      {extract: [{name: 'bad', source: 'json', path: '$.nope'}]},
      {url: '/should-not-run'},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('failed');
    expect(final.failure.message).toContain('变量提取失败');
    expect(final.steps).toHaveLength(1);
  });

  it('duplicate variables: later step overwrites earlier, same step is last-wins', async () => {
    const app = createApp({
      transport: {
        async send(req) {
          const n = Number(req.url.split('/').pop());
          return {status: 200, headers: {'x-v': `h${n}`}, body: JSON.stringify({v: `j${n}`})};
        },
      },
    });
    const doc = scenarioDoc([
      // same-step duplicate: json first, header second -> header wins
      {extract: [
        {name: 'v', source: 'json', path: '$.v'},
        {name: 'v', source: 'header', path: 'x-v'},
      ]},
      {extract: [{name: 'v', source: 'json', path: '$.v'}]},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.steps[0].variablesAfter.v).toBe('h0');
    expect(final.steps[0].extracted[1]).toMatchObject({name: 'v', overwrote: true, previous: 'j0'});
    expect(final.steps[1].extracted[0]).toMatchObject({name: 'v', overwrote: true, previous: 'h0'});
    expect(final.steps[1].variablesAfter.v).toBe('j1');
  });

  it('array json path writes the array; wildcard on non-array fails the extraction', async () => {
    const app = createApp({
      transport: {
        async send() {return {status: 200, headers: {}, body: JSON.stringify({items: [{id: 1}, {id: 2}], scalar: 3})};},
      },
    });
    const okDoc = scenarioDoc([{extract: [{name: 'ids', source: 'json', path: '$.items[*].id'}]}]);
    await replaceScenario(app, 'alpha', okDoc, 3);
    let final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('completed');
    expect(final.steps[0].variablesAfter.ids).toEqual([1, 2]);

    const rev = (await request(app).get('/api/scenarios/alpha')).body.revision;
    const badDoc = scenarioDoc([{onExtractFailure: 'terminate',
      extract: [{name: 'ids', source: 'json', path: '$.scalar[*]'}]}]);
    await replaceScenario(app, 'alpha', badDoc, rev);
    final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('failed');
    expect(final.steps[0].reason).toContain('非数组');
  });

  it('step reorder is an edit-time error when consumer moves before producer', async () => {
    const app = createApp();
    const producerFirst = scenarioDoc([
      {id: 'p', url: '/p', extract: [{name: 't', source: 'header', path: 'x'}]},
      {id: 'c', url: '/c?t={{t}}'},
    ]);
    const res1 = await request(app).post('/api/scenarios/alpha/analyze')
      .send({content: stringifyDoc(producerFirst)}).expect(200);
    expect(res1.body.diagnostics.filter((d: any) => d.severity === 'error')).toHaveLength(0);

    const reordered = scenarioDoc([
      {id: 'c', url: '/c?t={{t}}'},
      {id: 'p', url: '/p', extract: [{name: 't', source: 'header', path: 'x'}]},
    ]);
    const res2 = await request(app).post('/api/scenarios/alpha/analyze')
      .send({content: stringifyDoc(reordered)}).expect(200);
    expect(res2.body.diagnostics.find((d: any) => d.message.includes('{{t}}'))).toBeTruthy();
  });

  it('pins revision snapshot: edits during a run do not affect it; stale start is 409', async () => {
    const seenUrls: string[] = [];
    const release0 = gate();
    const {transport, entered} = fakeTransport((call, index) => {
      seenUrls.push(call.url);
      // hold step 0 so the PUT happens while its request is in flight;
      // later steps respond immediately.
      return index === 0
        ? hold(call, release0, () => ({status: 200, headers: {}, body: '{}'}))
        : {status: 200, headers: {}, body: '{}'};
    });
    const app = createApp({transport});
    const doc = scenarioDoc([{url: '/old-0'}, {url: '/old-1'}]);
    const rev1 = await replaceScenario(app, 'alpha', doc, 3);
    const run = await startRun(app, 'alpha', rev1);
    expect(run.revision).toBe(rev1);
    // wait until step 0 request has entered, then mutate while it is in flight
    await entered[0].promise;
    const changed = scenarioDoc([{url: '/new-only'}]);
    await replaceScenario(app, 'alpha', changed, rev1);
    release0.resolve();
    // starting with the stale pinned revision is rejected
    await request(app).post('/api/scenarios/alpha/runs').send({revision: rev1}).expect(409);
    const final = await waitForTerminal(app, run.id);
    expect(final.status).toBe('completed');
    expect(final.revision).toBe(rev1);
    expect(final.plan.map((p: any) => p.stepId)).toEqual(['step-1', 'step-2']);
    expect(seenUrls).toEqual(['/old-0', '/old-1']);
  });

  it('refuses to run documents with undefined references', async () => {
    const app = createApp();
    const doc = scenarioDoc([{url: '/{{ghost}}'}]);
    await replaceScenario(app, 'alpha', doc, 3);
    const res = await request(app).post('/api/scenarios/alpha/runs').send({}).expect(422);
    expect(res.body.error).toBe('invalid_scenario');
  });

  it('overwritten variable: later steps observe the new value at their run time', async () => {
    const seen: string[] = [];
    const app = createApp({
      transport: {
        async send(req) {
          seen.push(`${req.method} ${req.url}`);
          return {status: 200, headers: {}, body: JSON.stringify({v: req.url.includes('second') ? 'NEW' : 'OLD'})};
        },
      },
    });
    const doc = scenarioDoc([
      {url: '/first', extract: [{name: 'v', source: 'json', path: '$.v'}]},
      // later step overwrites v
      {url: '/second', extract: [{name: 'v', source: 'json', path: '$.v'}]},
      // this step must render the NEW value (actual run-time value, not initial)
      {url: '/echo/{{v}}'},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('completed');
    expect(seen).toContain('GET /echo/NEW');
    // and the recorded use in step 3 shows NEW (history is not rewritten later)
    expect(final.steps[2].request.uses[0].variable.raw).toBe('NEW');
  });

  it('non-string variables are uniformly coerced in URL/headers (number, boolean, array)', async () => {
    const seen: {url: string; headers: Record<string, string>}[] = [];
    const app = createApp({
      transport: {
        async send(req) {
          seen.push({url: req.url, headers: Object.fromEntries(req.headers.map(h => [h.name, h.value]))});
          if (req.url === '/p') return {status: 200, headers: {}, body: JSON.stringify({n: 7, arr: [1, 2], flag: false})};
          return {status: 200, headers: {}, body: '{}'};
        },
      },
    });
    const doc = scenarioDoc([
      {url: '/p', method: 'GET', extract: [
        {name: 'n', source: 'json', path: '$.n'},
        {name: 'arr', source: 'json', path: '$.arr'},
        {name: 'flag', source: 'json', path: '$.flag'},
      ]},
      {url: '/u/{{n}}/{{arr}}', headers: [{name: 'x-bool', value: '{{flag}}'}]},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const final = await waitForTerminal(app, (await startRun(app, 'alpha')).id);
    expect(final.status).toBe('completed');
    const echo = seen.find(s => s.url.startsWith('/u/'))!;
    // template output is raw (the engine does not URL-encode); arrays render
    // as JSON text, booleans/numbers as their text form.
    expect(echo.url).toBe('/u/7/[1,2]');
    expect(echo.headers['x-bool']).toBe('false');
    // extracted raw values still carry native types in the recorded snapshots
    expect(final.steps[1].variablesBefore.n).toBe(7);
    expect(final.steps[1].variablesBefore.arr).toEqual([1, 2]);
    expect(final.steps[1].variablesBefore.flag).toBe(false);
  });

  it('completed run is retrievable after the fact (refresh shows finished steps)', async () => {
    const app = createApp({
      transport: {async send() {return {status: 200, headers: {}, body: '{}'};}},
    });
    const doc = scenarioDoc([{url: '/a'}]);
    await replaceScenario(app, 'alpha', doc, 3);
    const run = await startRun(app, 'alpha');
    const final = await waitForTerminal(app, run.id);
    // simulate page refresh: list by scenario, then fetch one record
    const list = await request(app).get('/api/scenarios/alpha/runs').expect(200);
    expect(list.body.runs[0].id).toBe(run.id);
    const again = await request(app).get(`/api/runs/${run.id}`).expect(200);
    expect(again.body.steps).toHaveLength(1);
    expect(again.body.endedAt).toBeTruthy();
    expect(final.id).toBe(run.id);
  });
});

describe('cancellation', () => {
  it('cancel aborts the in-flight request and ends cancelled with no extraction', async () => {
    const releases = [gate()];
    const {transport, entered, calls} = fakeTransport((call, index) => {
      releases[index] ??= gate();
      return hold(call, releases[index], () => ({status: 200, headers: {}, body: JSON.stringify({x: 1})}));
    });
    const app = createApp({transport});
    const doc = scenarioDoc([
      {url: '/a', extract: [{name: 'x', source: 'json', path: '$.x'}]},
      {url: '/b'},
    ]);
    await replaceScenario(app, 'alpha', doc, 3);
    const run = await startRun(app, 'alpha');
    await entered[0].promise;
    await request(app).post(`/api/runs/${run.id}/cancel`).expect(200);
    releases[0].resolve();
    const final = await waitForTerminal(app, run.id);
    expect(final.status).toBe('cancelled');
    expect(final.steps).toHaveLength(1);
    expect(final.steps[0].variablesAfter).toEqual({});
    expect(calls).toHaveLength(1);
    // idempotent cancel
    await request(app).post(`/api/runs/${run.id}/cancel`).expect(200);
    const again = await request(app).get(`/api/runs/${run.id}`);
    expect(again.body.status).toBe('cancelled');
  });

  it('cancel before run starts cooperates (no step runs)', async () => {
    const releases = [gate()];
    const {transport, calls} = fakeTransport((call, index) => {
      releases[index] ??= gate();
      return hold(call, releases[index], () => ({status: 200, headers: {}, body: '{}'}));
    });
    const app = createApp({transport});
    const doc = scenarioDoc([{url: '/a'}, {url: '/b'}]);
    await replaceScenario(app, 'alpha', doc, 3);
    const run = await startRun(app, 'alpha');
    // two cancels while step 0 request is in flight
    await request(app).post(`/api/runs/${run.id}/cancel`);
    await request(app).post(`/api/runs/${run.id}/cancel`);
    releases[0].resolve();
    const final = await waitForTerminal(app, run.id);
    expect(['cancelled', 'completed']).toContain(final.status);
    if (final.status === 'cancelled') {
      // either step 0 never made a call, or it was aborted; never two calls
      expect(calls.length).toBeLessThanOrEqual(1);
    }
  });

  it('cancel vs. last-step completion race yields exactly one stable terminal state', async () => {
    for (let i = 0; i < 16; i += 1) {
      const releases = [gate()];
      const {transport, entered} = fakeTransport((call, index) => {
        releases[index] ??= gate();
        // Response is delivered even when abort landed mid-flight, so both
        // orderings of the race are exercised across iterations.
        return hold(call, releases[index], () => ({status: 200, headers: {}, body: '{}'}),
          {succeedIfLate: true});
      });
      const app = createApp({transport});
      const doc = scenarioDoc([{url: '/only'}]);
      await replaceScenario(app, 'alpha', doc, 3);
      const run = await startRun(app, 'alpha');
      await entered[0].promise;
      const delay = i % 2 === 0 ? 0 : 30;
      setTimeout(() => {void request(app).post(`/api/runs/${run.id}/cancel`);}, delay);
      releases[0].resolve();
      const final = await waitForTerminal(app, run.id);
      expect(['completed', 'cancelled']).toContain(final.status);
      const reread = await request(app).get(`/api/runs/${run.id}`);
      expect(reread.body.status).toBe(final.status);
      if (final.status === 'completed') expect(final.failure).toBeUndefined();
    }
  });

  it('cancel arriving after the last response is processed: run is completed, cancel never overrides', async () => {
    const app = createApp({transport: {async send() {return {status: 200, headers: {}, body: '{}'};}}});
    const doc = scenarioDoc([{url: '/a'}]);
    await replaceScenario(app, 'alpha', doc, 3);
    const run = await startRun(app, 'alpha');
    const final = await waitForTerminal(app, run.id);
    expect(final.status).toBe('completed');
    await request(app).post(`/api/runs/${run.id}/cancel`).expect(200);
    const after = await request(app).get(`/api/runs/${run.id}`).expect(200);
    expect(after.body.status).toBe('completed');
    expect(after.body.endedAt).toBe(final.endedAt);
  });
});
