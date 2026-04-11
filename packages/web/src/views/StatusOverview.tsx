import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

interface Metrics {
  dialog_count: number;
  avg_response_latency_ms: number;
  provider_usage: Record<string, number>;
  suggestions_total: number;
  suggestions_converted: number;
}

interface ProjectContext {
  snapshot: {
    metrics: { total_events: number; events_last_hour: number; active_files: number };
    recent_commits: Array<{ hash: string; message: string; date: string }>;
  };
  pendingSuggestions: number;
}

export function StatusOverview() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [context, setContext] = useState<ProjectContext | null>(null);
  const api = useApi();

  useEffect(() => {
    const load = () => {
      api.get<Metrics>('/api/telemetry/metrics').then(setMetrics).catch(() => {});
      api.get<ProjectContext>('/api/dialog/context').then(setContext).catch(() => {});
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [api]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Project overview */}
      <div className="card">
        <h2>Project</h2>
        <div className="metric-grid">
          <div className="metric-item">
            <div className="value">{context?.snapshot.metrics.total_events ?? 0}</div>
            <div className="label">Events Observed</div>
          </div>
          <div className="metric-item">
            <div className="value">{context?.snapshot.metrics.events_last_hour ?? 0}</div>
            <div className="label">Last Hour</div>
          </div>
          <div className="metric-item">
            <div className="value">{context?.snapshot.metrics.active_files ?? 0}</div>
            <div className="label">Active Files</div>
          </div>
          <div className="metric-item">
            <div className="value">{context?.pendingSuggestions ?? 0}</div>
            <div className="label">Pending Suggestions</div>
          </div>
        </div>
      </div>

      {/* System metrics */}
      <div className="card">
        <h2>System</h2>
        <div className="metric-grid">
          <div className="metric-item">
            <div className="value">{metrics?.dialog_count ?? 0}</div>
            <div className="label">Dialogs</div>
          </div>
          <div className="metric-item">
            <div className="value">{metrics?.suggestions_total ?? 0}</div>
            <div className="label">Suggestions</div>
          </div>
          <div className="metric-item">
            <div className="value">
              {(metrics?.avg_response_latency_ms ?? 0) > 0
                ? `${((metrics?.avg_response_latency_ms ?? 0) / 1000).toFixed(1)}s`
                : '—'}
            </div>
            <div className="label">Avg Response</div>
          </div>
        </div>
      </div>

      {/* Provider usage */}
      {metrics && Object.keys(metrics.provider_usage).length > 0 && (
        <div className="card">
          <h2>Provider Usage</h2>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {Object.entries(metrics.provider_usage).map(([name, count]) => (
              <div key={name} style={{ fontSize: 13 }}>
                <strong>{name}</strong>: {count} calls
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent commits */}
      {context && context.snapshot.recent_commits.length > 0 && (
        <div className="card">
          <h2>Recent Commits</h2>
          {context.snapshot.recent_commits.slice(0, 10).map((c, i) => (
            <div key={i} style={{ padding: '4px 0', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
              <code style={{ color: 'var(--accent)', marginRight: 8 }}>{c.hash.slice(0, 7)}</code>
              {c.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
