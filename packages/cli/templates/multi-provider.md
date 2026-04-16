## Multi-Provider Pipelines

This project routes work across multiple LLM providers (Claude Code, Codex, Gemini, local Ollama). Pipeline stages intentionally use **different** providers so reviewer bias doesn't mask implementer bias.

**Rules**:
- `implementer` / `tester` / `reviewer` roles should be distinct providers when ≥2 are available. Single-provider mode is a degraded fallback, not the default.
- Before adding a new pipeline stage, decide: does it need structured output (JSON) or free text? Structured output needs a `parse*` helper with a sanitized fallback (never trust raw LLM output for file paths / shell args).
- Prompts to CLI agents go through **stdin**, never concatenated into argv. Use `shell: false`. Timeouts must `SIGTERM` then `SIGKILL` — `Promise.race` alone leaks child processes.
- Each provider's confidence is calibrated from user feedback (accept / reject). Treat raw confidence as a prior, not a verdict.

**When a reviewer rejects**:
- Feed the concerns back into the implementer prompt ("Address these: ...") and re-run up to `MAX_FIX_ATTEMPTS` times
- Record the rejection in the feedback tracker so the calibrator learns
