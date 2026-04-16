export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'converted';
export type SuggestionCategory = 'ci_failure' | 'pr_blocked' | 'dependency_drift' | 'test_coverage' | 'architecture' | 'general';

export interface Suggestion {
  id: string;
  created_at: string;
  category: SuggestionCategory;
  summary: string;
  detail: string;
  evidence: string[];
  confidence: number;
  impact: 'low' | 'medium' | 'high' | 'critical';
  status: SuggestionStatus;
  converted_task_id?: string;
  region?: string;           // For cooldown tracking — which area of code this targets
  initiative_id?: string;    // Optional: which Initiative this suggestion supports
}
