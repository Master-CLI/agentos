import { useState } from 'react';
import { useApi } from '../hooks/useApi';

export function DialogInput() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const api = useApi();

  const submit = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    try {
      await api.post('/api/dialog', { prompt: prompt.trim() });
      setPrompt('');
    } catch (err) {
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
          {loading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
