import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

interface ReviewConcern {
  file: string;
  line?: number;
  severity: string;
  category: string;
  message: string;
  suggested_fix?: string;
}

interface ReviewReport {
  reviewer: string;
  verdict: string;
  concerns: ReviewConcern[];
}

interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  content: string;
}

interface TaskFull {
  id: string;
  prompt: string;
  origin: string;
  status: string;
  created_at: string;
  change_level: string;
  pipeline: {
    implementation: { provider: string | null; diff: FileDiff[]; };
    testing: { provider: string | null; run_result: { passed: boolean; total: number; failed: number; } | null; };
    reviews: ReviewReport[];
    consensus: string;
    fix_attempts: number;
    error?: string;
  };
}

export function TaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [task, setTask] = useState<TaskFull | null>(null);
  const api = useApi();

  useEffect(() => {
    const load = () => api.get<TaskFull>(`/api/tasks/${taskId}`).then(setTask).catch(() => {});
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [taskId, api]);

  const accept = async () => {
    await api.post(`/api/tasks/${taskId}/accept`);
    const updated = await api.get<TaskFull>(`/api/tasks/${taskId}`);
    setTask(updated);
  };

  const discard = async () => {
    await api.post(`/api/tasks/${taskId}/discard`);
    const updated = await api.get<TaskFull>(`/api/tasks/${taskId}`);
    setTask(updated);
  };

  if (!task) return <div className="card">Loading...</div>;

  const p = task.pipeline;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button className="btn btn-discard" onClick={onBack}>Back</button>
          <span className={`badge ${task.origin}`}>{task.origin === 'user' ? 'You' : 'System'}</span>
          <span className={`badge ${task.status}`}>{task.status}</span>
          <span className={`badge`} style={{ background: 'var(--bg-input)' }}>{task.change_level}</span>
        </div>
        <p style={{ fontSize: 15 }}>{task.prompt}</p>
        {task.status === 'awaiting_user' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-accept" onClick={accept}>Accept All</button>
            <button className="btn btn-discard" onClick={discard}>Discard</button>
          </div>
        )}
      </div>

      {/* Pipeline Error */}
      {p.error && (
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <h2 style={{ color: 'var(--red)' }}>Pipeline Error</h2>
          <p style={{ fontSize: 13 }}>{p.error}</p>
        </div>
      )}

      {/* Pipeline Status */}
      <div className="card">
        <h2>Pipeline</h2>
        <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
          <div>Implement: <strong>{p.implementation.provider ?? '—'}</strong></div>
          <div>Test: <strong>{p.testing.provider ?? '—'}</strong></div>
          <div>Reviews: <strong>{p.reviews.length}</strong></div>
          <div>Consensus: <span className={`badge ${p.consensus}`}>{p.consensus}</span></div>
          {p.fix_attempts > 0 && <div>Fix attempts: <strong>{p.fix_attempts}</strong></div>}
        </div>
      </div>

      {/* Diff */}
      {p.implementation.diff.length > 0 && (
        <div className="card">
          <h2>Changes ({p.implementation.diff.length} files)</h2>
          {p.implementation.diff.map((d, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                <strong>{d.path}</strong>
                <span style={{ color: 'var(--green)', marginLeft: 8 }}>+{d.additions}</span>
                <span style={{ color: 'var(--red)', marginLeft: 4 }}>-{d.deletions}</span>
              </div>
              {d.content && <pre className="diff">{d.content}</pre>}
            </div>
          ))}
        </div>
      )}

      {/* Test Results */}
      {p.testing.run_result && (
        <div className="card">
          <h2>Tests</h2>
          <div style={{ fontSize: 13 }}>
            <span className={`badge ${p.testing.run_result.passed ? 'pass' : 'reject'}`}>
              {p.testing.run_result.passed ? 'Passed' : 'Failed'}
            </span>
            <span style={{ marginLeft: 8 }}>
              {p.testing.run_result.total} total, {p.testing.run_result.failed} failed
            </span>
            <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>
              by {p.testing.provider}
            </span>
          </div>
        </div>
      )}

      {/* Reviews */}
      {p.reviews.map((r, i) => (
        <div className="card" key={i}>
          <h2>Review by {r.reviewer}</h2>
          <span className={`badge ${r.verdict}`}>{r.verdict}</span>
          {r.concerns.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {r.concerns.map((c, j) => (
                <div key={j} className={`concern-row ${c.severity}`}>
                  <strong>{c.file}{c.line ? `:${c.line}` : ''}</strong>
                  <span style={{ marginLeft: 8 }}>[{c.category}]</span>
                  <div>{c.message}</div>
                  {c.suggested_fix && (
                    <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 4 }}>
                      Fix: {c.suggested_fix}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {r.concerns.length === 0 && (
            <p style={{ color: 'var(--text-dim)', marginTop: 4 }}>No concerns.</p>
          )}
        </div>
      ))}
    </div>
  );
}
