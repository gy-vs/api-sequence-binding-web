import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FileSearch, FlaskConical, Play, Save} from 'lucide-react';
import type {Diagnostic, RunRecord, ScenarioDoc} from '../shared/types';
import {
  analyzeDoc, cloneDoc, emptyDoc, parseScenario, renderRequest, stringifyDoc,
} from '../shared/scenario';
import {StepEditor} from './StepEditor';
import {RunView} from './RunView';

type Summary = {id: string; name: string; revision: number; updatedAt: string};
type Row = Summary & {content: string};
type Tab = 'diagnostics' | 'run';

const runKey = (id: string) => `api-studio.run.${id}`;

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<Row | null>(null);
  const [doc, setDoc] = useState<ScenarioDoc | null>(null);
  const [legacyText, setLegacyText] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [status, setStatus] = useState('就绪');
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const [preview, setPreview] = useState<{stepId: string; text: string} | null>(null);
  const [tab, setTab] = useState<Tab>('diagnostics');
  const [run, setRun] = useState<RunRecord | null>(null);
  const [runNote, setRunNote] = useState('');
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/scenarios').then(r => r.json()).then(setItems);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('加载中');
    setDoc(null);
    setLegacyText(null);
    setPreview(null);
    setRun(null);
    setRunNote('');
    setServerDiagnostics([]);
    fetch('/api/scenarios/' + selected)
      .then(r => r.json())
      .then((value: Row) => {
        if (cancelled) return;
        setRow(value);
        const parsed = parseScenario(value.content);
        if (parsed.doc) {
          setDoc(cloneDoc(parsed.doc));
        } else {
          setLegacyText(value.content);
        }
        setStatus('已加载');
      });
    return () => {cancelled = true;};
  }, [selected, loadNonce]);

  // Edit-time diagnostics, recomputed on every keystroke.
  const diagnostics = useMemo(() => (doc ? analyzeDoc(doc) : []), [doc]);
  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  // Attach to the last run after a page refresh.
  useEffect(() => {
    if (!selected || !row) return;
    const runId = localStorage.getItem(runKey(selected));
    if (!runId) return;
    fetch('/api/runs/' + runId).then(async r => {
      if (!r.ok) {
        localStorage.removeItem(runKey(selected));
        return;
      }
      const record = (await r.json()) as RunRecord;
      setRun(record);
      setTab('run');
      if (record.revision !== row.revision) {
        setRunNote(`该运行固定在 revision ${record.revision}，当前场景已保存到 revision ${row.revision}，运行内容不受影响。`);
      }
    });
  }, [selected, row]);

  // Poll while running.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let active = true;
    const tick = async () => {
      const res = await fetch('/api/runs/' + run.id);
      if (!active || !res.ok) return;
      const next = (await res.json()) as RunRecord;
      setRun(next);
      if (next.status === 'running') {
        pollRef.current = setTimeout(tick, 400);
      }
    };
    pollRef.current = setTimeout(tick, 200);
    return () => {
      active = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [run?.id, run?.status]);

  const dirty = useMemo(() => {
    if (!row) return false;
    if (doc) return stringifyDoc(doc) !== row.content;
    return legacyText !== row.content;
  }, [row, doc, legacyText]);

  const save = useCallback(async () => {
    if (!row) return;
    setStatus('保存中');
    const content = doc ? stringifyDoc(doc) : (legacyText ?? '');
    const response = await fetch('/api/scenarios/' + row.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content, revision: row.revision}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus('Revision 冲突：场景已被他人修改，请重新加载');
      return;
    }
    setRow(value);
    setStatus('已保存');
  }, [row, doc, legacyText]);

  const analyze = useCallback(async () => {
    if (!row) return;
    setStatus('分析中');
    const content = doc ? stringifyDoc(doc) : (legacyText ?? '');
    const response = await fetch('/api/scenarios/' + row.id + '/analyze', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content}),
    });
    const value = await response.json();
    setServerDiagnostics(value.diagnostics ?? []);
    setTab('diagnostics');
    setStatus('分析完成');
  }, [row, doc, legacyText]);

  const previewStep = useCallback((stepId: string) => {
    if (!doc) return;
    const index = doc.steps.findIndex(s => s.id === stepId);
    if (index < 0) return;
    // Single-step preview: resolve with initial variables plus variables that
    // earlier steps WOULD define (names only, shown as missing) — no network.
    const earlier = new Set<string>(Object.keys(doc.initialVariables));
    for (const earlierStep of doc.steps.slice(0, index)) {
      earlierStep.extract.forEach(e => earlier.add(e.name));
    }
    const variables: Record<string, unknown> = {};
    for (const name of earlier) {
      variables[name] = name in doc.initialVariables ? doc.initialVariables[name] : undefined;
    }
    // undefined for later-defined names: renderRequest marks them missing
    const rendered = renderRequest(doc.steps[index], variables);
    setPreview({stepId, text: JSON.stringify({
      method: rendered.method, url: rendered.url,
      headers: rendered.headers, body: rendered.body,
      uses: rendered.uses, warnings: rendered.warnings,
    }, null, 2)});
  }, [doc]);

  const startRun = useCallback(async () => {
    if (!row || !doc) return;
    if (dirty) {
      setStatus('有未保存修改：运行使用已保存的 revision，请先保存');
      return;
    }
    if (errorCount > 0) {
      setStatus(`存在 ${errorCount} 个未定义引用/错误，无法运行`);
      setTab('diagnostics');
      return;
    }
    const res = await fetch(`/api/scenarios/${row.id}/runs`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: row.revision}),
    });
    if (res.status === 409) {
      setStatus('场景已被修改，请重新加载后再运行');
      setLoadNonce(n => n + 1);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setStatus(`无法启动运行：${data?.error ?? res.status}`);
      setServerDiagnostics(data?.diagnostics ?? []);
      setTab('diagnostics');
      return;
    }
    const record = (await res.json()) as RunRecord;
    setRun(record);
    setRunNote('');
    setTab('run');
    localStorage.setItem(runKey(row.id), record.id);
    setStatus('运行已开始');
  }, [row, doc, dirty, errorCount]);

  const cancelRun = useCallback(async () => {
    if (!run) return;
    // Cancel is a request; the runner decides the single terminal state.
    await fetch(`/api/runs/${run.id}/cancel`, {method: 'POST'});
    setStatus('已请求取消…');
  }, [run]);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>API Scenario Studio</strong>
        <small>本地工作区</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>场景</h2>
          <div className="list">
            {items.map(item => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br/><small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane editor-pane">
          <div className="toolbar">
            <button className="primary" onClick={save}><Save size={15}/>保存</button>
            <button onClick={analyze}><FileSearch size={15}/>分析</button>
            <button onClick={startRun} disabled={!doc}><Play size={15}/>运行场景</button>
            <span className={`status ${dirty ? 'dirty' : ''}`}>{status}{dirty ? '（有未保存修改）' : ''}</span>
          </div>

          {doc && (
            <>
              <InitialVariablesEditor key={`${row?.id ?? ''}:${row?.revision ?? 0}:${loadNonce}`} doc={doc} onChange={setDoc}/>
              <StepEditor doc={doc} diagnostics={diagnostics}
                previewStepId={preview?.stepId ?? null}
                onChange={next => {setDoc(next); setPreview(null);}}
                onPreview={previewStep}/>
            </>
          )}
          {legacyText !== null && (
            <textarea aria-label="Content" value={legacyText} onChange={e => setLegacyText(e.target.value)}/>
          )}
        </section>

        <aside className="pane inspect-pane">
          <div className="tabs" role="tablist">
            <button className={tab === 'diagnostics' ? 'active' : ''} onClick={() => setTab('diagnostics')}>
              诊断 {errorCount + warningCount > 0 && <span className="count">{errorCount}/{warningCount}</span>}
            </button>
            <button className={tab === 'run' ? 'active' : ''} onClick={() => setTab('run')}>运行</button>
          </div>

          {tab === 'diagnostics' && (
            <div className="diagnostics-panel">
              {doc && (
                <div className="diag-summary">
                  <span className="pill error-pill">错误 {errorCount}</span>
                  <span className="pill warn-pill">警告 {warningCount}</span>
                  <span className="pill">信息 {diagnostics.filter(d => d.severity === 'info').length}</span>
                </div>
              )}
              <DiagnosticList title="编辑期实时检查" items={diagnostics}/>
              {serverDiagnostics.length > 0 && <DiagnosticList title="服务端分析结果" items={serverDiagnostics}/>}
              {preview && (
                <details open className="preview-block">
                  <summary>单步预览（不发送请求）</summary>
                  <pre>{preview.text}</pre>
                </details>
              )}
              {!doc && <p className="hint">当前内容不是结构化场景，保存/分析按纯文本处理（旧流程）。</p>}
            </div>
          )}

          {tab === 'run' && (
            <>
              {runNote && <div className="diag-line warning">{runNote}</div>}
              <RunView run={run} live={!!run && run.status === 'running'} onCancel={cancelRun}/>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}

function InitialVariablesEditor({doc, onChange}: {doc: ScenarioDoc; onChange: (doc: ScenarioDoc) => void}) {
  // Local text state is seeded once per loaded/saved revision (remount via key),
  // so typing never fights the JSON parser.
  const [text, setText] = useState(() => JSON.stringify(doc.initialVariables, null, 2));
  const [invalid, setInvalid] = useState(false);

  const commit = (value: string) => {
    setText(value);
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const initialVariables: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) initialVariables[k] = v === null ? '' : String(v);
        onChange({...doc, initialVariables});
        setInvalid(false);
      } else {
        setInvalid(true);
      }
    } catch {
      setInvalid(true);
    }
  };

  return (
    <details className="init-vars">
      <summary>初始变量</summary>
      <textarea aria-label="初始变量 JSON" rows={4} value={text}
        className={invalid ? 'invalid' : ''}
        onChange={e => commit(e.target.value)}/>
      {invalid && <div className="diag-line error">初始变量必须是 JSON 对象，例如 {'{"baseUrl":"/mock"}'}</div>}
    </details>
  );
}

function DiagnosticList({title, items}: {title: string; items: Diagnostic[]}) {
  return (
    <section className="diag-list">
      <h3>{title}（{items.length}）</h3>
      {items.length === 0 && <p className="hint">无问题。</p>}
      {items.map((d, i) => <div className={`diag-line ${d.severity}`} key={i}>{d.message}</div>)}
    </section>
  );
}
