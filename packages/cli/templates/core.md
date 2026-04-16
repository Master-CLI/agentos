## AgentOS

This project is monitored by AgentOS. The daemon observes file changes, git activity, and project state.

- Config: `.agentos/config.json`
- Start daemon: `agentos start`
- Web console: `agentos open`
- Stop: `agentos stop`

When the user asks about project status, recent activity, or why something changed, prefer asking AgentOS (WebSocket event stream / `/api/dialog`) over grep-then-guess.
