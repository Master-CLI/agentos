import * as fs from 'node:fs';
import * as path from 'node:path';

const DIRS = [
  'docs',
  'docs/concepts',
  'docs/goals',
  'docs/plans',
  'docs/tasks',
  'docs/sessions',
  'docs/decisions',
];

export function scaffoldDocs(targetDir: string): void {
  // Create directories
  for (const dir of DIRS) {
    const fullPath = path.join(targetDir, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // INDEX.md
  const indexPath = path.join(targetDir, 'docs', 'INDEX.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `# Project Documentation Index

> Auto-maintained by AgentOS. Updated when documents are created.

## Concepts
_(No entries yet)_

## Goals
_(No entries yet)_

## Plans
_(No entries yet)_

## Tasks
_(No entries yet)_

## Sessions
_(No entries yet)_

## Decisions
_(No entries yet)_
`);
  }

  // CLAUDE.md — Agent entry point with documentation rules
  const claudePath = path.join(targetDir, 'CLAUDE.md');
  const claudeContent = `# Project Rules

## Documentation System

This project uses a structured documentation system in \`docs/\`.

### Directory Structure

\`\`\`
docs/
├── INDEX.md             ← Global index (keep updated when adding docs)
├── concepts/            ← Ideas, explorations, design investigations
├── goals/               ← Project objectives and success criteria
├── plans/               ← Phase plans, milestones, roadmaps
├── tasks/               ← Actionable work items with acceptance criteria
├── sessions/            ← Conversation summaries ("记录讨论" goes here)
└── decisions/           ← Key decisions with rationale and alternatives
\`\`\`

### Document Types

| Type | Trigger | Filename | Content |
|------|---------|----------|---------|
| concept | New idea or technical exploration | \`YYYYMMDD-topic.md\` | What, why, open questions |
| goal | Establishing project objectives | \`goal-name.md\` | Objective, metrics, constraints |
| plan | Planning phase work | \`phase-N-name.md\` | Scope, milestones, dependencies |
| task | Actionable work breakdown | \`TASK-NNN-brief.md\` | What to do, acceptance criteria, status |
| session | User says "记录讨论"/"record this" | \`YYYYMMDD-topic.md\` | Key points, conclusions, action items |
| decision | Making a key choice | \`YYYYMMDD-topic.md\` | Decision, alternatives considered, rationale |

### Frontmatter Template

Every document should start with:

\`\`\`yaml
---
type: concept | goal | plan | task | session | decision
title: Brief descriptive title
date: YYYY-MM-DD
status: draft | active | completed | archived
tags: [relevant, tags]
---
\`\`\`

### Agent Behavior Rules

When the user says "记录讨论", "记录一下", "record this discussion", or similar:

1. Review the current conversation and extract: **key points**, **conclusions**, **action items**
2. Determine which document types apply (may produce multiple: session + concept + task)
3. Create files in the appropriate \`docs/\` subdirectory with correct frontmatter
4. Update \`docs/INDEX.md\` with links to new documents
5. Confirm to the user which files were created

When creating task documents, use sequential numbering: check existing \`docs/tasks/TASK-*.md\` files and increment.

### Document Status Flow

\`\`\`
draft → active → completed
                → archived (if abandoned)
\`\`\`

## AgentOS

This project is monitored by AgentOS. The daemon observes file changes, git activity, and project state.

- Config: \`.agentos/config.json\`
- Start daemon: \`agentos start\`
- Web console: \`agentos open\`
`;

  // Write or merge CLAUDE.md
  if (fs.existsSync(claudePath)) {
    const existing = fs.readFileSync(claudePath, 'utf-8');
    if (!existing.includes('Documentation System')) {
      // Append doc rules to existing CLAUDE.md
      fs.writeFileSync(claudePath, existing + '\n' + claudeContent);
    }
  } else {
    fs.writeFileSync(claudePath, claudeContent);
  }
}
