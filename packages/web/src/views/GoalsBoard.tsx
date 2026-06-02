import { useState, useMemo } from 'react';

/* ── Types (mock; mirrors a denormalized daemon snapshot) ─────────── */

type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

interface TaskHistoryItem {
  ts: string;
  text: string;
}

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  plan_step?: { current: number; total: number };
  confidence?: number;        // 0..1 — only for AI-suggested or AI-driven tasks
  is_suggestion?: boolean;    // true = not yet promoted by user
  blocked_reason?: string;
  started_at?: string;
  completed_at?: string;
  history: TaskHistoryItem[];
}

interface Goal {
  id: string;
  title: string;
  motivation: string;
  completion_criteria: string;
  deadline?: string;
  status: 'active' | 'completed';
  tasks: Task[];
}

/* ── Mock data ─────────────────────────────────────────────────────── */

const MOCK_GOALS: Goal[] = [
  {
    id: 'g1',
    title: '完成 Form Lab v0.3 设计迭代闭环',
    motivation: '首个 production 用例,验证 Design Iteration Pipeline 的端到端可用性',
    completion_criteria: '能从 prompt 一键跑到打分 + 收敛 + 导出,中间无需 CLI',
    deadline: '2026-04-30',
    status: 'active',
    tasks: [
      {
        id: 't1', title: '接通 Krea API 渲染管道', status: 'done',
        plan_step: { current: 4, total: 4 },
        completed_at: '2026-04-12T14:20:00Z',
        history: [
          { ts: '2026-04-10', text: '创建任务' },
          { ts: '2026-04-11', text: '接入 Krea SDK' },
          { ts: '2026-04-12', text: '验证 4 张 variant 渲染成功' },
        ],
      },
      {
        id: 't2', title: 'Param matrix 配置面板', status: 'done',
        plan_step: { current: 3, total: 3 },
        completed_at: '2026-04-13T09:00:00Z',
        history: [{ ts: '2026-04-13', text: '面板上线' }],
      },
      {
        id: 't3', title: '五星打分 + 收敛流', status: 'in_progress',
        plan_step: { current: 2, total: 4 },
        started_at: '2026-04-15T10:00:00Z',
        history: [
          { ts: '2026-04-15', text: '启动' },
          { ts: '2026-04-16', text: 'ratings 状态机完成' },
        ],
      },
      {
        id: 't4', title: 'AI 评论入库 + 复用', status: 'in_progress',
        plan_step: { current: 1, total: 3 },
        started_at: '2026-04-16T15:30:00Z',
        history: [{ ts: '2026-04-16', text: '启动,正在设计 schema' }],
      },
      {
        id: 't5', title: '离线导出 JSON / Markdown', status: 'pending',
        plan_step: { current: 0, total: 2 },
        history: [{ ts: '2026-04-14', text: '已规划' }],
      },
      {
        id: 't6', title: 'WebSocket 实时回传', status: 'blocked',
        blocked_reason: '等 daemon WS 协议确认 v2',
        history: [
          { ts: '2026-04-14', text: '已规划' },
          { ts: '2026-04-15', text: '阻塞:WS 协议未定' },
        ],
      },
      {
        id: 't7', title: '加 timeline 视图', status: 'pending',
        is_suggestion: true, confidence: 0.62,
        history: [{ ts: '2026-04-17', text: 'daemon 观察到多轮迭代,建议加 timeline' }],
      },
    ],
  },
  {
    id: 'g2',
    title: 'AgentOS web 端可视化 1.0',
    motivation: '降低用户进入 AgentOS 的认知门槛,从 CLI 转移到可视化',
    completion_criteria: '5 大 view 全上线,能在不开 terminal 的情况下完成日常',
    status: 'active',
    tasks: [
      {
        id: 't8', title: '基础 layout + WebSocket', status: 'done',
        plan_step: { current: 3, total: 3 },
        completed_at: '2026-04-08T12:00:00Z',
        history: [{ ts: '2026-04-08', text: '上线' }],
      },
      {
        id: 't9', title: '事件流 view', status: 'done',
        plan_step: { current: 2, total: 2 },
        completed_at: '2026-04-10T18:00:00Z',
        history: [{ ts: '2026-04-10', text: '上线' }],
      },
      {
        id: 't10', title: '目标看板(本视图)', status: 'in_progress',
        plan_step: { current: 1, total: 3 },
        started_at: '2026-04-17T09:00:00Z',
        history: [
          { ts: '2026-04-17', text: '启动' },
          { ts: '2026-04-17', text: '完成 mock 版本,等设计讨论' },
        ],
      },
      {
        id: 't11', title: '建议收件箱二次设计', status: 'pending',
        plan_step: { current: 0, total: 4 },
        history: [{ ts: '2026-04-15', text: '已规划' }],
      },
      {
        id: 't12', title: '加键盘快捷键(j/k/enter)', status: 'pending',
        is_suggestion: true, confidence: 0.71,
        history: [{ ts: '2026-04-17', text: 'daemon 观察到反复鼠标操作,建议加快捷键' }],
      },
    ],
  },
  {
    id: 'g3',
    title: '信任分级 + DampingController 上线',
    motivation: '让 AI 建议有节奏地放开,避免一次给太多让用户疲劳',
    completion_criteria: 'shadow 数据 → confidence 阈值 → cooldown 形成完整链路',
    status: 'active',
    tasks: [
      {
        id: 't13', title: '影子模式数据采集', status: 'done',
        plan_step: { current: 5, total: 5 },
        completed_at: '2026-04-05T20:00:00Z',
        history: [{ ts: '2026-04-05', text: '上线两周采到 1240 条' }],
      },
      {
        id: 't14', title: '置信度阈值实验', status: 'in_progress',
        plan_step: { current: 2, total: 4 },
        started_at: '2026-04-12T10:00:00Z',
        history: [
          { ts: '2026-04-12', text: '启动' },
          { ts: '2026-04-15', text: '初版阈值 0.65,误报 12%' },
        ],
      },
      {
        id: 't15', title: '区域冷却机制(region cooldown)', status: 'pending',
        plan_step: { current: 0, total: 3 },
        history: [{ ts: '2026-04-13', text: '已规划' }],
      },
      {
        id: 't16', title: '真实项目上线试点', status: 'blocked',
        blocked_reason: '等 Form Lab 闭环完成',
        history: [{ ts: '2026-04-15', text: '阻塞:依赖 g1' }],
      },
    ],
  },
];

/* ── Helpers ──────────────────────────────────────────────────────── */

const STATUS_COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'pending', label: '待启动' },
  { key: 'in_progress', label: '进行中' },
  { key: 'done', label: '已完成' },
  { key: 'blocked', label: '阻塞' },
];

function statusBadgeClass(status: TaskStatus): string {
  switch (status) {
    case 'pending': return 'pending';
    case 'in_progress': return 'implementing';
    case 'done': return 'completed';
    case 'blocked': return 'cancelled';
  }
}

/* ── TaskCard ─────────────────────────────────────────────────────── */

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const className = [
    'task-card',
    task.is_suggestion ? 'suggestion' : '',
    task.status === 'in_progress' ? 'in-progress' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, flex: 1 }}>
          {task.title}
        </span>
        {task.is_suggestion && (
          <span className="badge" style={{ background: '#6c8cff22', color: 'var(--accent)', flexShrink: 0 }}>
            建议
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
        {task.plan_step && (
          <span>{task.plan_step.current}/{task.plan_step.total} 步</span>
        )}
        {task.blocked_reason && (
          <span style={{ color: 'var(--red)' }}>· {task.blocked_reason}</span>
        )}
      </div>

      {typeof task.confidence === 'number' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
            <span>置信度</span>
            <span>{Math.round(task.confidence * 100)}%</span>
          </div>
          <div className="conf-bar">
            <div className="conf-bar-fill" style={{ width: `${task.confidence * 100}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

/* ── Drawer (task detail) ─────────────────────────────────────────── */

function Drawer({
  task, goal, onClose, onAction,
}: {
  task: Task;
  goal: Goal;
  onClose: () => void;
  onAction: (action: 'start' | 'complete' | 'block' | 'promote') => void;
}) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span className={`badge ${statusBadgeClass(task.status)}`}>{task.status}</span>
          {task.is_suggestion && (
            <span className="badge" style={{ background: '#6c8cff22', color: 'var(--accent)' }}>建议</span>
          )}
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 18 }}
          >×</button>
        </div>

        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{task.title}</h3>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
          属于目标:{goal.title}
        </div>

        {task.plan_step && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              计划进度
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {Array.from({ length: task.plan_step.total }).map((_, i) => (
                <div key={i} style={{
                  flex: 1, height: 6, borderRadius: 3,
                  background: i < task.plan_step!.current ? 'var(--green)' : 'var(--bg-input)',
                }} />
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
              第 {task.plan_step.current} / {task.plan_step.total} 步
            </div>
          </div>
        )}

        {task.blocked_reason && (
          <div className="concern-row error" style={{ marginBottom: 16 }}>
            <strong>阻塞原因:</strong> {task.blocked_reason}
          </div>
        )}

        {typeof task.confidence === 'number' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              AI 置信度
            </div>
            <div className="conf-bar" style={{ height: 6 }}>
              <div className="conf-bar-fill" style={{ width: `${task.confidence * 100}%` }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              {Math.round(task.confidence * 100)}% — 由 daemon 推断,需要你 promote 后才会执行
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            历史
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {task.history.map((h) => (
              <div key={`${h.ts}::${h.text}`} style={{ fontSize: 12, color: 'var(--text)' }}>
                <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginRight: 8 }}>{h.ts}</span>
                {h.text}
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {task.is_suggestion && (
            <button className="btn btn-accept" onClick={() => onAction('promote')}>采纳建议</button>
          )}
          {task.status === 'pending' && !task.is_suggestion && (
            <button className="btn btn-convert" onClick={() => onAction('start')}>启动</button>
          )}
          {task.status === 'in_progress' && (
            <>
              <button className="btn btn-accept" onClick={() => onAction('complete')}>标记完成</button>
              <button className="btn btn-discard" onClick={() => onAction('block')}>标记阻塞</button>
            </>
          )}
          {task.status === 'blocked' && (
            <button className="btn btn-convert" onClick={() => onAction('start')}>解除阻塞</button>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
          所有操作以事件形式发往 daemon,UI 不直接修改状态(mock 阶段为本地模拟)
        </div>
      </div>
    </>
  );
}

/* ── GoalsBoard (main export) ─────────────────────────────────────── */

export function GoalsBoard() {
  const [goals, setGoals] = useState<Goal[]>(MOCK_GOALS);
  const [selected, setSelected] = useState<{ goalId: string; taskId: string } | null>(null);

  const stats = useMemo(() => {
    const allTasks = goals.flatMap((g) => g.tasks).filter((t) => !t.is_suggestion);
    return {
      done: allTasks.filter((t) => t.status === 'done').length,
      in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      blocked: allTasks.filter((t) => t.status === 'blocked').length,
      total: allTasks.length,
      suggestions: goals.flatMap((g) => g.tasks).filter((t) => t.is_suggestion).length,
    };
  }, [goals]);

  const selectedTask = useMemo(() => {
    if (!selected) return null;
    const goal = goals.find((g) => g.id === selected.goalId);
    const task = goal?.tasks.find((t) => t.id === selected.taskId);
    return goal && task ? { goal, task } : null;
  }, [selected, goals]);

  const handleAction = (action: 'start' | 'complete' | 'block' | 'promote') => {
    if (!selected) return;
    setGoals((prev) => prev.map((g) => {
      if (g.id !== selected.goalId) return g;
      return {
        ...g,
        tasks: g.tasks.map((t) => {
          if (t.id !== selected.taskId) return t;
          const now = new Date().toISOString().slice(0, 10);
          switch (action) {
            case 'start':
              return { ...t, status: 'in_progress', started_at: now,
                history: [...t.history, { ts: now, text: '启动' }] };
            case 'complete':
              return { ...t, status: 'done', completed_at: now,
                plan_step: t.plan_step ? { ...t.plan_step, current: t.plan_step.total } : undefined,
                history: [...t.history, { ts: now, text: '标记完成' }] };
            case 'block':
              return { ...t, status: 'blocked', blocked_reason: '手动标记',
                history: [...t.history, { ts: now, text: '标记阻塞' }] };
            case 'promote':
              return { ...t, is_suggestion: false, confidence: undefined,
                history: [...t.history, { ts: now, text: '建议被采纳' }] };
          }
        }),
      };
    }));
    setSelected(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Top bar — overall progress */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: 'var(--text)' }}>目标看板</h2>
        <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, height: 8, background: 'var(--bg-input)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${(stats.done / stats.total) * 100}%`, background: 'var(--green)' }} />
            <div style={{ width: `${(stats.in_progress / stats.total) * 100}%`, background: 'var(--yellow)' }} />
            <div style={{ width: `${(stats.blocked / stats.total) * 100}%`, background: 'var(--red)' }} />
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            {stats.done} / {stats.total} 完成
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <span><span style={{ color: 'var(--green)' }}>●</span> 完成 {stats.done}</span>
          <span><span style={{ color: 'var(--yellow)' }}>●</span> 进行中 {stats.in_progress}</span>
          <span><span style={{ color: 'var(--text-dim)' }}>●</span> 待启动 {stats.pending}</span>
          <span><span style={{ color: 'var(--red)' }}>●</span> 阻塞 {stats.blocked}</span>
          <span><span style={{ color: 'var(--accent)' }}>●</span> 建议 {stats.suggestions}</span>
        </div>
      </div>

      {/* Board */}
      <div className="board">
        {/* Header row */}
        <div className="board-header">目标</div>
        {STATUS_COLUMNS.map((col) => (
          <div key={col.key} className="board-header">{col.label}</div>
        ))}

        {/* Goal rows */}
        {goals.map((goal) => {
          const goalTasks = goal.tasks.filter((t) => !t.is_suggestion);
          const goalDone = goalTasks.filter((t) => t.status === 'done').length;
          return (
            <div key={goal.id} style={{ display: 'contents' }}>
              <div className="board-goal-cell">
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{goal.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.4 }}>
                  {goal.motivation}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  {goalDone} / {goalTasks.length} 完成
                  {goal.deadline && <span style={{ marginLeft: 8 }}>· 截止 {goal.deadline}</span>}
                </div>
                <div style={{ height: 4, marginTop: 6, background: 'var(--bg-input)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${(goalDone / goalTasks.length) * 100}%`, height: '100%', background: 'var(--green)' }} />
                </div>
              </div>

              {STATUS_COLUMNS.map((col) => (
                <div key={col.key} className="board-status-cell">
                  {goal.tasks
                    .filter((t) => t.status === col.key)
                    .map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onClick={() => setSelected({ goalId: goal.id, taskId: task.id })}
                      />
                    ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Drawer */}
      {selectedTask && (
        <Drawer
          task={selectedTask.task}
          goal={selectedTask.goal}
          onClose={() => setSelected(null)}
          onAction={handleAction}
        />
      )}
    </div>
  );
}
