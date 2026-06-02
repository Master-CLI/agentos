import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

/* ── Types (mirrors daemon design-routes.ts) ─────────────────────── */

interface ParamConfig {
  label: string;
  description: string;
  params: Record<string, string | number>;
}

interface DesignTask {
  id: string;
  title: string;
  round: number;
  status: string;
  param_matrix: ParamConfig[];
  variants: DesignVariant[];
}

interface DesignVariant {
  id: string;
  key: string;
  title: string;
  description: string;
  ai_scores: Record<string, number>;
  ai_comments: Record<string, string>;
}

interface RenderEntry {
  variant_id: string;
  config_label: string;
  png_path: string;
  stats: Record<string, number>;
}

interface DesignRating {
  config_label: string;
  variant_key: string;
  stars: number;
  comment: string;
}

/* ── Stars component ─────────────────────────────────────────────── */

function Stars({
  value,
  interactive,
  onChange,
}: {
  value: number;
  interactive?: boolean;
  onChange?: (v: number) => void;
}) {
  return (
    <span style={{ cursor: interactive ? 'pointer' : 'default', userSelect: 'none' }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          onClick={() => interactive && onChange?.(n)}
          onKeyDown={(e) => {
            if (interactive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onChange?.(n); }
          }}
          style={{
            color: n <= value ? (interactive ? 'var(--yellow)' : 'var(--text-dim)') : 'var(--bg-input)',
            fontSize: 18,
            marginRight: 2,
          }}
        >
          &#9733;
        </span>
      ))}
    </span>
  );
}

/* ── Lightbox ────────────────────────────────────────────────────── */

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.85)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
      }}
    >
      <img src={src} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
    </div>
  );
}

/* ── VariantCard ──────────────────────────────────────────────────── */

function VariantCard({
  variant,
  configLabel,
  renderEntry,
  userRating,
  userComment,
  onRate,
  onComment,
  onImageClick,
}: {
  variant: DesignVariant;
  configLabel: string;
  renderEntry?: RenderEntry;
  userRating: number;
  userComment: string;
  onRate: (stars: number) => void;
  onComment: (text: string) => void;
  onImageClick: (src: string) => void;
}) {
  const aiScore = variant.ai_scores?.[configLabel] ?? 0;
  const imgSrc = renderEntry?.png_path ?? '';

  return (
    <div style={{
      background: 'var(--bg-input)', borderRadius: 'var(--radius)', padding: 12,
      minWidth: 200, flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{variant.title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{variant.description}</div>

      {imgSrc ? (
        <img
          src={imgSrc}
          alt={`${variant.key} / ${configLabel}`}
          onClick={() => onImageClick(imgSrc)}
          style={{ width: '100%', borderRadius: 4, cursor: 'zoom-in', background: '#000' }}
        />
      ) : (
        <div style={{
          height: 120, borderRadius: 4, background: 'var(--bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 12,
        }}>No render</div>
      )}

      {/* AI score (read-only) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={{ color: 'var(--text-dim)' }}>AI</span>
        <Stars value={aiScore} />
      </div>

      {/* User rating (interactive) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={{ color: 'var(--text)' }}>You</span>
        <Stars value={userRating} interactive onChange={onRate} />
      </div>

      <textarea
        rows={2}
        placeholder="Comment..."
        value={userComment}
        onChange={(e) => onComment(e.target.value)}
        style={{
          width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 4, padding: 6, color: 'var(--text)', fontSize: 12,
          fontFamily: 'var(--font)', resize: 'vertical',
        }}
      />

      {renderEntry && Object.keys(renderEntry.stats).length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {Object.entries(renderEntry.stats).map(([k, v]) => (
            <span key={k} style={{ marginRight: 8 }}>{k}: {v}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── ComparisonView (main export) ────────────────────────────────── */

interface TaskListItem { id: string; title: string; status: string; round: number }

export function ComparisonView() {
  const api = useApi();

  // Task list + selection
  const [taskList, setTaskList] = useState<TaskListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Current task data
  const [task, setTask] = useState<DesignTask | null>(null);
  const [renderEntries, setRenderEntries] = useState<RenderEntry[]>([]);

  // Review state
  const [overallPick, setOverallPick] = useState('');
  const [overallComment, setOverallComment] = useState('');
  const [ratings, setRatings] = useState<Record<string, DesignRating>>({});

  // Lightbox
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const ratingKey = (configLabel: string, variantKey: string) => `${configLabel}::${variantKey}`;

  // Load task list
  useEffect(() => {
    const load = () => api.get<TaskListItem[]>('/api/design-tasks').then(setTaskList).catch(() => {});
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [api]);

  // Load selected task detail + renders
  useEffect(() => {
    if (!selectedId) { setTask(null); return; }
    const load = () => {
      api.get<DesignTask>(`/api/design-tasks/${selectedId}`).then(setTask).catch(() => {});
      api.get<RenderEntry[]>(`/api/design-tasks/${selectedId}/renders`).then(setRenderEntries).catch(() => {});
    };
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [selectedId, api]);

  const findRender = useCallback(
    (variantId: string, configLabel: string) =>
      renderEntries.find((r) => r.variant_id === variantId && r.config_label === configLabel),
    [renderEntries],
  );

  const setRating = (configLabel: string, variantKey: string, stars: number) => {
    const k = ratingKey(configLabel, variantKey);
    setRatings((prev) => ({
      ...prev,
      [k]: { ...(prev[k] ?? { config_label: configLabel, variant_key: variantKey, stars: 0, comment: '' }), stars },
    }));
  };

  const setComment = (configLabel: string, variantKey: string, text: string) => {
    const k = ratingKey(configLabel, variantKey);
    setRatings((prev) => ({
      ...prev,
      [k]: { ...(prev[k] ?? { config_label: configLabel, variant_key: variantKey, stars: 0, comment: '' }), comment: text },
    }));
  };

  const ratedCount = Object.values(ratings).filter((r) => r.stars > 0).length;
  const totalCount = task ? task.param_matrix.length * task.variants.length : 0;

  const submitReview = async () => {
    if (!task) return;
    await api.post(`/api/design-tasks/${task.id}/review`, {
      overall_pick: overallPick,
      overall_comment: overallComment,
      ratings: Object.values(ratings),
    });
  };

  const converge = async () => {
    if (!task) return;
    await submitReview();
    await api.post(`/api/design-tasks/${task.id}/converge`);
  };

  const exportJSON = () => {
    if (!task) return;
    const payload = {
      task_id: task.id,
      round: task.round,
      exported_at: new Date().toISOString(),
      overall_pick: overallPick,
      overall_comment: overallComment,
      ratings: Object.values(ratings),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `review-${task.id}-r${task.round}.json`;
    a.click();
    // Revoke the object URL after the browser has had time to initiate the download
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /* ── Task list (no task selected) ─────────────────────────────── */
  if (!selectedId || !task) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card">
          <h2>Design Tasks</h2>
          {taskList.length === 0 && (
            <p style={{ color: 'var(--text-dim)' }}>
              No design tasks yet. Create one via the API to start iterating.
            </p>
          )}
          {taskList.map((t) => (
            <div
              key={t.id}
              className="task-row"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(t.id); } }}
            >
              <span className={`badge ${t.status}`}>{t.status}</span>
              <span className="prompt">{t.title}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Round {t.round}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── Review view ──────────────────────────────────────────────── */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {/* Header */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-discard" onClick={() => setSelectedId(null)}>Back</button>
        <h2 style={{ margin: 0 }}>Design Review -- Round {task.round}</h2>
        <span className={`badge ${task.status}`}>{task.status}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 'auto' }}>
          Rated: {ratedCount} / {totalCount}
        </span>
        <button className="btn btn-discard" onClick={exportJSON}>Export JSON</button>
        <button className="btn btn-accept" onClick={submitReview}>Save Review</button>
        <button className="btn btn-convert" onClick={converge}>Converge</button>
      </div>

      {/* Overall pick */}
      <div className="card">
        <h2>Overall Pick</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'start' }}>
          <select
            value={overallPick}
            onChange={(e) => setOverallPick(e.target.value)}
            style={{
              padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13,
            }}
          >
            <option value="">-- select variant --</option>
            {task.variants.map((v) => (
              <option key={v.key} value={v.key}>{v.title}</option>
            ))}
          </select>
          <textarea
            rows={2}
            placeholder="Overall comment..."
            value={overallComment}
            onChange={(e) => setOverallComment(e.target.value)}
            style={{
              flex: 1, minWidth: 200, padding: 8, background: 'var(--bg-input)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)', resize: 'vertical',
            }}
          />
        </div>
      </div>

      {/* Config rows */}
      {task.param_matrix.map((config) => (
        <div key={config.label} className="card">
          <h2>{config.label}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{config.description}</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {task.variants.map((variant) => (
              <VariantCard
                key={variant.key}
                variant={variant}
                configLabel={config.label}
                renderEntry={findRender(variant.id, config.label)}
                userRating={ratings[ratingKey(config.label, variant.key)]?.stars ?? 0}
                userComment={ratings[ratingKey(config.label, variant.key)]?.comment ?? ''}
                onRate={(stars) => setRating(config.label, variant.key, stars)}
                onComment={(text) => setComment(config.label, variant.key, text)}
                onImageClick={setLightboxSrc}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
