import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

interface Suggestion {
  id: string;
  category: string;
  summary: string;
  detail: string;
  confidence: number;
  impact: string;
  status: string;
  converted_task_id?: string;
}

export function SuggestionInbox() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const api = useApi();

  useEffect(() => {
    const load = () => api.get<Suggestion[]>('/api/suggestions').then(setSuggestions).catch(() => {});
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [api]);

  const convert = async (id: string) => {
    await api.post(`/api/suggestions/${id}/convert`);
    const updated = await api.get<Suggestion[]>('/api/suggestions');
    setSuggestions(updated);
  };

  if (suggestions.length === 0) {
    return (
      <div className="card">
        <h2>Suggestions</h2>
        <p style={{ color: 'var(--text-dim)' }}>No suggestions yet. The system will generate them as it observes your project.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Suggestions</h2>
      {suggestions.map((s) => (
        <div key={s.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className={`badge ${s.status}`}>{s.status}</span>
            <span className="badge" style={{ background: 'var(--bg-input)' }}>{s.category}</span>
            <span className="badge" style={{
              background: s.impact === 'critical' ? '#f8717122' : s.impact === 'high' ? '#fb923c22' : 'var(--bg-input)',
              color: s.impact === 'critical' ? 'var(--red)' : s.impact === 'high' ? 'var(--orange)' : 'var(--text-dim)',
            }}>{s.impact}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              confidence: {(s.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.summary}</div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 6 }}>{s.detail}</div>
          {s.status === 'pending' && (
            <button className="btn btn-convert" onClick={() => convert(s.id)}>
              Let Agent Handle
            </button>
          )}
          {s.converted_task_id && (
            <span style={{ fontSize: 12, color: 'var(--accent)' }}>
              Converted to task {s.converted_task_id.slice(-6)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
