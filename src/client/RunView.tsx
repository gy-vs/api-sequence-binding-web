import {Ban, CheckCircle2, ChevronRight, CircleSlash, Play, XCircle} from 'lucide-react';
import type {RunRecord, StepRunRecord} from '../shared/types';

interface Props {
  run: RunRecord | null;
  live: boolean;
  onCancel: () => void;
}

const STATUS_META = {
  completed: {icon: CheckCircle2, className: 'completed', label: '完成'},
  skipped: {icon: CircleSlash, className: 'skipped', label: '跳过'},
  failed: {icon: XCircle, className: 'failed', label: '失败'},
  cancelled: {icon: Ban, className: 'cancelled', label: '已取消'},
  pending: {icon: ChevronRight, className: 'pending', label: '待执行'},
} as const;

export function RunView({run, live, onCancel}: Props) {
  if (!run) {
    return <div className="run-empty">尚未运行。保存场景后点击「运行场景」。</div>;
  }
  return (
    <div className="run-view">
      <header className="run-head">
        <strong>运行 {run.id.slice(0, 8)}</strong>
        <span className="pill">固定 revision {run.revision}</span>
        <RunBadge status={run.status}/>
        <div className="spacer"/>
        {run.status === 'running' && (
          <button type="button" className="danger-btn" onClick={onCancel}><Ban size={14}/>取消运行</button>
        )}
        {live && run.status === 'running' && <small className="live-dot">实时刷新中</small>}
      </header>
      {run.failure && <div className="diag-line error">终止原因：{run.failure.message}</div>}

      <ol className="step-timeline">
        {renderedSteps(run).map(entry => 'record' in entry
          ? <FinishedStep key={entry.record.stepId} record={entry.record}/>
          : <PendingStep key={entry.plan.stepId} index={entry.index} name={entry.plan.name}/>)}
      </ol>
      <footer className="run-foot">
        {run.endedAt ? `结束于 ${formatTime(run.endedAt)}` : `开始于 ${formatTime(run.createdAt)}`}
      </footer>
    </div>
  );
}

type TimelineEntry = {record: StepRunRecord} | {plan: {stepId: string; name: string}; index: number};

function renderedSteps(run: RunRecord): TimelineEntry[] {
  const entries: TimelineEntry[] = run.steps.map(record => ({record}));
  const seen = new Set(run.steps.map(s => s.stepId));
  run.plan.forEach((plan, index) => {
    if (!seen.has(plan.stepId)) entries.push({plan, index});
  });
  // sort pending entries by plan index among finished records by recorded index
  entries.sort((a, b) => {
    const ai = 'record' in a ? a.record.index : a.index;
    const bi = 'record' in b ? b.record.index : b.index;
    return ai - bi;
  });
  return entries;
}

function RunBadge({status}: {status: RunRecord['status']}) {
  const meta = STATUS_META[status === 'running' ? 'pending' : status];
  const Icon = status === 'running' ? Play : meta.icon;
  return <span className={`run-badge ${status}`}><Icon size={13}/>{status === 'running' ? '运行中' : meta.label}</span>;
}

function PendingStep({index, name}: {index: number; name: string}) {
  return (
    <li className="timeline-item pending">
      <header><ChevronRight size={15}/><span className="step-index">#{index + 1}</span><span>{name}</span><span className="tag">待执行</span></header>
    </li>
  );
}

function FinishedStep({record}: {record: StepRunRecord}) {
  const meta = STATUS_META[record.status];
  const Icon = meta.icon;
  return (
    <li className={`timeline-item ${record.status}`}>
      <header>
        <Icon size={15}/>
        <span className="step-index">#{record.index + 1}</span>
        <span className="step-title">{record.name}</span>
        <span className="tag">{meta.label}</span>
      </header>
      {record.reason && <div className="step-reason">{record.reason}</div>}

      {record.request && (
        <details className="step-detail">
          <summary>实际请求与使用的值</summary>
          <div className="detail-body">
            <code className="request-line">
              {record.request.method} {record.request.url}
            </code>
            {record.request.headers.length > 0 && (
              <table className="uses-table">
                <thead><tr><th>位置</th><th>变量</th><th>实际使用的值（运行时）</th><th>原始类型</th></tr></thead>
                <tbody>
                  {record.request.uses.map((use, i) => (
                    <tr key={i} className={use.variable.missing ? 'missing' : ''}>
                      <td>{use.where}</td>
                      <td>{`{{${use.variable.name}}}`}</td>
                      <td className="mono">{use.variable.missing ? <em>未定义 → 空串</em> : displayValue(use.variable.raw)}</td>
                      <td>{use.variable.missing ? '—' : typeName(use.variable.raw)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {record.request.headers.map((h, i) => (
              <div className="mono kv" key={i}>{h.name}: {h.value}</div>
            ))}
            {record.request.body && <pre className="body-pre">{record.request.body}</pre>}
            {record.request.warnings.length > 0 && record.request.uses.length === 0 && (
              <div className="diag-line warning">{record.request.warnings.join('；')}</div>
            )}
          </div>
        </details>
      )}

      {record.response && (
        <details className="step-detail">
          <summary>响应（HTTP {record.response.status}）</summary>
          <div className="detail-body">
            <div className="mono kv-list">
              {Object.entries(record.response.headers).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
            </div>
            <pre className="body-pre">{record.response.bodyPreview}</pre>
          </div>
        </details>
      )}

      <details className="step-detail" open={record.status === 'completed' && !!record.extracted?.length}>
        <summary>变量快照{record.extracted?.length ? `（本步写入 ${record.extracted.length} 个）` : ''}</summary>
        <div className="detail-body snapshot-grid">
          <div>
            <h4>本步之前</h4>
            <pre>{JSON.stringify(record.variablesBefore, null, 2) || '{}'}</pre>
          </div>
          <div>
            <h4>本步之后</h4>
            <pre>{JSON.stringify(record.variablesAfter, null, 2) || '{}'}</pre>
          </div>
        </div>
        {record.extracted && record.extracted.length > 0 && (
          <table className="uses-table">
            <thead><tr><th>变量</th><th>新值</th><th>覆盖</th><th>旧值</th></tr></thead>
            <tbody>
              {record.extracted.map((item, i) => (
                <tr key={i}>
                  <td>{item.name}</td>
                  <td className="mono">{displayValue(item.value)}</td>
                  <td>{item.overwrote ? '是' : '否'}</td>
                  <td className="mono">{item.overwrote ? displayValue(item.previous) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </li>
  );
}

function displayValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', {hour12: false});
}
