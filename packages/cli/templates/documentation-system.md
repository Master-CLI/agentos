## Documentation System

This project uses a structured documentation system in `docs/`. AgentOS writes most of these documents — agent behavior here matters.

### Directory Structure

```
docs/
├── INDEX.md             ← Global index (keep updated when adding docs)
├── concepts/            ← Ideas, explorations, design investigations
├── goals/               ← Project objectives and success criteria
├── plans/               ← Phase plans, milestones, roadmaps
├── tasks/               ← Actionable work items with acceptance criteria
├── sessions/            ← Conversation summaries ("记录讨论" goes here)
└── decisions/           ← Key decisions with rationale and alternatives
```

### Document Types

| Type | Trigger | Filename | Content |
|------|---------|----------|---------|
| concept | New idea or technical exploration | `YYYYMMDD-topic.md` | What, why, open questions |
| goal | Establishing project objectives | `goal-name.md` | Objective, metrics, constraints |
| plan | Planning phase work | `phase-N-name.md` | Scope, milestones, dependencies |
| task | Actionable work breakdown | `TASK-NNN-brief.md` | What to do, acceptance criteria, status |
| session | User says "记录讨论"/"record this" | `YYYYMMDD-topic.md` | Key points, conclusions, action items |
| decision | Making a key choice | `YYYYMMDD-topic.md` | Decision, alternatives considered, rationale |

### Frontmatter

Every document starts with:

```yaml
---
type: concept | goal | plan | task | session | decision
title: Brief descriptive title
date: YYYY-MM-DD
status: draft | active | completed | archived
tags: [relevant, tags]
---
```

### Agent Behavior

When the user says "记录讨论", "记录一下", "record this discussion", or similar:

1. Extract from the current conversation: **key points**, **conclusions**, **action items**
2. Determine which document types apply (may produce multiple: session + concept + task)
3. Create files in the appropriate `docs/` subdirectory with correct frontmatter
4. Update `docs/INDEX.md` with links to new documents
5. Confirm to the user which files were created

When creating task documents, check existing `docs/tasks/TASK-*.md` and increment.

### Status Flow

```
draft → active → completed
              ↓
           archived (if abandoned)
```

### Cross-document rules

- **New core capability / new architectural decision** → add a new file in `docs/concepts/` or `docs/decisions/`; don't append to an existing doc
- **Revising a prior decision** → add a "修订 / Revision" section at the bottom of the original file with date and reason; keep the history
