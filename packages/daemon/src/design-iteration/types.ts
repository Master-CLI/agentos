// --- Design Task ---

export interface DesignTask {
  id: string;                    // ULID
  created_at: string;
  title: string;
  description: string;
  baseline_path: string;
  param_matrix: ParamConfig[];
  round: number;
  status: 'active' | 'awaiting_review' | 'converged' | 'aborted';
  constraints: DesignConstraint[];
}

export interface ParamConfig {
  label: string;
  description: string;
  params: Record<string, string | number>;
}

// --- Variant ---

export interface DesignVariant {
  id: string;
  task_id: string;
  round: number;
  key: string;                   // "a", "b", "c"
  title: string;
  description: string;
  file_path: string;
  ai_scores: Record<string, number>;
  ai_comments: Record<string, string>;
}

// --- Render Matrix ---

export interface RenderEntry {
  variant_id: string;
  config_label: string;
  png_path: string;
  stats: Record<string, number>;
}

// --- Human Review ---

export interface DesignReview {
  task_id: string;
  round: number;
  exported_at: string;
  overall_pick: string;
  overall_comment: string;
  ratings: DesignRating[];
}

export interface DesignRating {
  config_label: string;
  variant_key: string;
  stars: number;                 // 1-5
  comment: string;
}

// --- Design Constraint (learned from feedback) ---

export interface DesignConstraint {
  id: string;
  created_at: string;
  round: number;
  rule: string;
  description: string;
  source_comment: string;
}
