/**
 * Initiative — a declared, longer-lived direction for the project.
 *
 * Unlike Suggestion (reactive, triggered by an event pattern) and CodeTask
 * (short-lived executable unit), an Initiative expresses *where the project
 * is headed*. Suggestions and tasks can be tagged with an initiative_id so
 * the daemon can tell "this bug-fix suggestion falls under the auth-rewrite
 * initiative" and surface progress accordingly.
 */

export type InitiativeStatus = 'active' | 'completed' | 'abandoned';

export type InitiativeNoteKind = 'progress' | 'blocker' | 'decision';

export interface InitiativeNote {
  id: string;
  at: string;                // ISO timestamp
  text: string;
  kind: InitiativeNoteKind;
}

export interface Initiative {
  id: string;                // ULID
  created_at: string;
  title: string;
  motivation: string;        // why this matters
  completion_criteria: string; // how we'll know it's done
  owner?: string;            // free-form: username, email, or role
  deadline?: string;         // ISO date, if any
  status: InitiativeStatus;
  completed_at?: string;
  abandoned_at?: string;
  notes: InitiativeNote[];
}

export interface InitiativeUpdate {
  title?: string;
  motivation?: string;
  completion_criteria?: string;
  owner?: string | null;     // null = clear
  deadline?: string | null;  // null = clear
}
