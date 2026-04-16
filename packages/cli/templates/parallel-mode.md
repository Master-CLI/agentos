## Parallel Work Mode (main agent + subagents)

**Dispatch rule**: task boundary is clean (single file or single module) + no cross-package touching + no schema / pipeline-order / migration changes → dispatch to a subagent. Otherwise main agent runs serially.

**Must stay serial (main agent)**:
- Cross-package interface changes (daemon type changes → cli + web follow-up)
- Event / Snapshot schema evolution (persistence compatibility, one miss = broken replay)
- Pipeline stage order / dependency changes
- Database migrations
- Git side effects (commit / push / branch reset)

**Forbidden in every subagent prompt**:
- Do NOT modify `packages/*/package.json` dependencies (main agent manages these)
- Do NOT make cross-package edits (one subagent = one package)
- Do NOT run `npm install` (subagents only run `build` / `test`)
- Do NOT introduce `any` / `@ts-ignore` (unless the prompt explicitly allows it)

**Main-agent review checklist after subagent returns**:
- `git diff` — verify the scope matches what was asked
- `npm run build -w <package>` passes
- Relevant `vitest` suite still green
- No schema / migration files touched (unless it was a schema-focused task)

**Prompt template (what to include, not how to write it)**:
- Goal in one sentence
- Context (subagent can't see history) — project paths, tech stack, where this fits
- Inputs / outputs / success criteria
- Word limit for the report-back
- Blocker rule: report "BLOCKED: <reason>" instead of pretending to finish
