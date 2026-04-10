import { useState } from 'react';
import './styles.css';
import { useWebSocket } from './hooks/useWebSocket';
import { DialogInput } from './views/DialogInput';
import { TaskPanel } from './views/TaskPanel';
import { TaskDetail } from './views/TaskDetail';
import { SuggestionInbox } from './views/SuggestionInbox';
import { StatusOverview } from './views/StatusOverview';
import { ChangeStream } from './views/ChangeStream';

type View = 'tasks' | 'suggestions' | 'status' | 'events';

export default function App() {
  const { status, lastMessage } = useWebSocket();
  const [view, setView] = useState<View>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>AgentOS</h1>
        <div style={{ fontSize: 12, marginBottom: 12, color: 'var(--text-dim)' }}>
          <span className={`status-dot ${status}`} />
          {status === 'connected' ? 'Daemon 运行中' : status === 'connecting' ? '连接中...' : '未连接'}
        </div>
        <button className={view === 'tasks' ? 'active' : ''} onClick={() => { setView('tasks'); setSelectedTaskId(null); }}>
          Tasks
        </button>
        <button className={view === 'suggestions' ? 'active' : ''} onClick={() => setView('suggestions')}>
          Suggestions
        </button>
        <button className={view === 'status' ? 'active' : ''} onClick={() => setView('status')}>
          Status
        </button>
        <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>
          Events
        </button>
      </nav>

      <main className="main">
        <DialogInput />

        {view === 'tasks' && !selectedTaskId && (
          <TaskPanel onSelect={(id) => setSelectedTaskId(id)} />
        )}
        {view === 'tasks' && selectedTaskId && (
          <TaskDetail taskId={selectedTaskId} onBack={() => setSelectedTaskId(null)} />
        )}
        {view === 'suggestions' && <SuggestionInbox />}
        {view === 'status' && <StatusOverview />}
        {view === 'events' && <ChangeStream />}
      </main>
    </div>
  );
}
