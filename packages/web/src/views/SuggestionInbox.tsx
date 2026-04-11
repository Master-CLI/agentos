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
  created_at: string;
}

export function SuggestionInbox() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const api = useApi();

  const load = () => api.get<Suggestion[]>('/api/suggestions').then(setSuggestions).catch(() => {});

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [api]);

  const dismiss = async (id: string) => {
    await api.post(`/api/suggestions/${id}/dismiss`);
    load();
  };

  const acknowledge = async (id: string) => {
    await api.post(`/api/suggestions/${id}/acknowledge`);
    load();
  };

  const pending = suggestions.filter((s) => s.status === 'pending');
  const handled = suggestions.filter((s) => s.status !== 'pending');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <h2>Suggestions ({pending.length} pending)</h2>
        {pending.length === 0 && (
          <p style={{ color: 'var(--text-dim)' }}>
            No pending suggestions. The system will generate them as it observes your project.
          </p>
        )}
        {pending.map((s) => (
          <div key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="badge" style={{ background: 'var(--bg-input)' }}>{s.category}</span>
              <span className="badge" style={{
                background: s.impact === 'critical' ? '#f8717122' : s.impact === 'high' ? '#fb923c22' : s.impact === 'medium' ? '#fbbf2422' : 'var(--bg-input)',
                color: s.impact === 'critical' ? 'var(--red)' : s.impact === 'high' ? 'var(--orange)' : s.impact === 'medium' ? 'var(--yellow)' : 'var(--text-dim)',
              }}>{s.impact}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                {(s.confidence * 100).toFixed(0)}% confidence
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 'auto' }}>
                {new Date(s.created_at).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.summary}</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>{s.detail}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-accept" onClick={() => acknowledge(s.id)}>Got it</button>
              <button className="btn btn-discard" onClick={() => dismiss(s.id)}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>

      {handled.length > 0 && (
        <div className="card">
          <h2>History ({handled.length})</h2>
          {handled.map((s) => (
            <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <span className={`badge ${s.status}`}>{s.status}</span>
              <span style={{ marginLeft: 8 }}>{s.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
