import { useState } from 'react';
import { useApi } from '../hooks/useApi';

interface DialogInputProps {
  onTaskCreated?: (taskId: string) => void;
}

export function DialogInput({ onTaskCreated }: DialogInputProps) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const api = useApi();

  const submit = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await api.post<{ task_id: string }>('/api/dialog', { prompt: prompt.trim() });
      setPrompt('');
      setFeedback(`Task created (${res.task_id.slice(-6)})`);
      onTaskCreated?.(res.task_id);
      setTimeout(() => setFeedback(null), 3000);
    } catch (err) {
      setFeedback('Failed to create task');
      console.error('Dialog error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="dialog-input">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Ask AgentOS anything... (e.g. 'Refactor the auth module')"
          disabled={loading}
        />
        <button onClick={submit} disabled={loading || !prompt.trim()}>
          {loading ? 'Sending...' : 'Send'}
        </button>
      </div>
      {feedback && (
        <div style={{
          marginTop: 8,
          fontSize: 13,
          color: feedback.startsWith('Failed') ? 'var(--red)' : 'var(--green)',
        }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
