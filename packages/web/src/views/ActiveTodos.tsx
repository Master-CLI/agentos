import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';

interface TaskTodo {
  kind: 'task';
  id: string;
  title: string;
  status: string;
  date?: string;
  path: string;
}

interface MemoryTodo {
  kind: 'memory';
  title: string;
  description: string;
  file: string;
}

interface ActiveTodosSnapshot {
  generatedAt: string;
  projectDir: string;
  memoryDir: string | null;
  tasks: TaskTodo[];
  memory: MemoryTodo[];
  errors: string[];
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  active: { bg: '#34d39922', fg: 'var(--green)' },
  in_progress: { bg: '#34d39922', fg: 'var(--green)' },
  'in-progress': { bg: '#34d39922', fg: 'var(--green)' },
  draft: { bg: '#fbbf2422', fg: 'var(--yellow)' },
};

function statusBadge(status: string) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--bg-input)', fg: 'var(--text-dim)' };
  return (
    <span
      className="badge"
      style={{ background: c.bg, color: c.fg, textTransform: 'capitalize' }}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ActiveTodos() {
  const [snapshot, setSnapshot] = useState<ActiveTodosSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useApi();

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<ActiveTodosSnapshot>('/api/active-todos')
        .then((s) => {
          if (cancelled) return;
          setSnapshot(s);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api]);

  if (error) {
    return (
      <div className="card">
        <h2>Active TODOs</h2>
        <p style={{ color: 'var(--red)' }}>Failed to load: {error}</p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="card">
        <h2>Active TODOs</h2>
        <p style={{ color: 'var(--text-dim)' }}>Loading…</p>
      </div>
    );
  }

  const { tasks, memory, generatedAt, errors } = snapshot;
  const totalCount = tasks.length + memory.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2>Active TODOs ({totalCount})</h2>
          <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 'auto' }}>
            {new Date(generatedAt).toLocaleTimeString()}
          </span>
        </div>
        {totalCount === 0 && (
          <p style={{ color: 'var(--text-dim)', marginTop: 8 }}>
            No active tasks or project-memory pointers. You're at a clean checkpoint.
          </p>
        )}
      </div>

      {tasks.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>Tasks ({tasks.length})</h3>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            From <code>docs/tasks/</code> with status active or draft.
          </div>
          {tasks.map((t) => (
            <div
              key={t.id}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="badge" style={{ background: 'var(--bg-input)', fontFamily: 'var(--mono)' }}>
                  {t.id}
                </span>
                {statusBadge(t.status)}
                {t.date && (
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t.date}</span>
                )}
              </div>
              <div style={{ fontWeight: 600 }}>{t.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                {t.path}
              </div>
            </div>
          ))}
        </div>
      )}

      {memory.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>Project memory ({memory.length})</h3>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            <code>type: project</code> entries indexed by{' '}
            <code>~/.claude/projects/&lt;slug&gt;/memory/MEMORY.md</code>.
          </div>
          {memory.map((m) => (
            <div
              key={m.file}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ fontWeight: 600 }}>{m.title}</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>{m.description}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                {m.file}
              </div>
            </div>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <div className="card">
          <h3 style={{ color: 'var(--yellow)', marginBottom: 8 }}>Warnings</h3>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--text-dim)' }}>{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}
