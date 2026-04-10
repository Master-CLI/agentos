import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

interface Metrics {
  tasks_total: number;
  tasks_by_status: Record<string, number>;
  tasks_by_origin: Record<string, number>;
  avg_pipeline_latency_ms: number;
  provider_usage: Record<string, number>;
  suggestions_total: number;
  suggestions_converted: number;
}

export function StatusOverview() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const api = useApi();

  useEffect(() => {
    const load = () => api.get<Metrics>('/api/telemetry/metrics').then(setMetrics).catch(() => {});
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [api]);

  if (!metrics) {
    return (
      <div className="card">
        <h2>Status</h2>
        <p style={{ color: 'var(--text-dim)' }}>Loading metrics...</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <h2>Metrics</h2>
        <div className="metric-grid">
          <div className="metric-item">
            <div className="value">{metrics.tasks_total}</div>
            <div className="label">Total Tasks</div>
          </div>
          <div className="metric-item">
            <div className="value">{metrics.avg_pipeline_latency_ms > 0 ? `${(metrics.avg_pipeline_latency_ms / 1000).toFixed(1)}s` : '—'}</div>
            <div className="label">Avg Pipeline</div>
          </div>
          <div className="metric-item">
            <div className="value">{metrics.suggestions_total}</div>
            <div className="label">Suggestions</div>
          </div>
          <div className="metric-item">
            <div className="value">{metrics.suggestions_converted}</div>
            <div className="label">Converted</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Tasks by Status</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {Object.entries(metrics.tasks_by_status).map(([status, count]) => (
            <div key={status}>
              <span className={`badge ${status}`}>{status}</span>
              <strong style={{ marginLeft: 6 }}>{count}</strong>
            </div>
          ))}
          {Object.keys(metrics.tasks_by_status).length === 0 && (
            <span style={{ color: 'var(--text-dim)' }}>No tasks yet</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Provider Usage</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {Object.entries(metrics.provider_usage).map(([name, count]) => (
            <div key={name} style={{ fontSize: 13 }}>
              <strong>{name}</strong>: {count} calls
            </div>
          ))}
          {Object.keys(metrics.provider_usage).length === 0 && (
            <span style={{ color: 'var(--text-dim)' }}>No provider calls yet</span>
          )}
        </div>
      </div>
    </div>
  );
}
