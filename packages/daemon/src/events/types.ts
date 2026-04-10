export interface ProjectEvent {
  id: string;
  timestamp: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  metadata: {
    project_id: string;
    correlation_id?: string;
  };
}
