import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

interface Task {
  id: string;
  prompt: string;
  origin: string;
  status: string;
  created_at: string;
  change_level: string;
}

export function TaskPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const api = useApi();

  useEffect(() => {
    const load = () => api.get<Task[]>('/api/tasks').then(setTasks).catch(() => {});
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [api]);

  if (tasks.length === 0) {
    return (
      <div className="card">
        <h2>Tasks</h2>
        <p style={{ color: 'var(--text-dim)' }}>No tasks yet. Use the dialog above to get started.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Tasks</h2>
      {tasks.map((t) => (
        <div key={t.id} className="task-row" onClick={() => onSelect(t.id)}>
          <span className={`badge ${t.origin}`}>{t.origin === 'user' ? 'You' : 'System'}</span>
          <span className={`badge ${t.status}`}>{t.status}</span>
          <span className="prompt">{t.prompt}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {new Date(t.created_at).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
  );
}
