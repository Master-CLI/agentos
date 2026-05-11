import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Marker on the first line so `agentos init` knows whether a hook is one of
 * ours (safe to overwrite) versus a user's own hook (never touch). Match by
 * prefix so older versions are detected and upgraded transparently.
 */
const HOOK_MARKER_PREFIX = '# AGENTOS-MANAGED-HOOK';
const HOOK_MARKER = `${HOOK_MARKER_PREFIX} v1`;

const PRE_COMMIT_HOOK = `#!/bin/sh
${HOOK_MARKER}
#
# Warns (does NOT block) when staged changes touch source files but
# CHANGELOG.md is not part of the commit. The check is a reminder — the
# user is always free to ignore it for internal refactors.
#
# Skip via:  AGENTOS_SKIP_CHANGELOG_CHECK=1 git commit ...
# Trigger paths: .agentos/changelog-rules.json -> {"triggers": ["src/", ...]}
# Default triggers below if no rules file is present.

[ "$AGENTOS_SKIP_CHANGELOG_CHECK" = "1" ] && exit 0

staged=$(git diff --cached --name-only)
[ -z "$staged" ] && exit 0

default_triggers='src/ web/src/ packages/'
triggers="$default_triggers"
rules_file=".agentos/changelog-rules.json"
if [ -f "$rules_file" ] && command -v node > /dev/null 2>&1; then
  derived=$(node -e "try { var r = JSON.parse(require('fs').readFileSync('$rules_file','utf8')); if (Array.isArray(r.triggers) && r.triggers.length) console.log(r.triggers.join(' ')); } catch(e){}" 2>/dev/null)
  if [ -n "$derived" ]; then triggers="$derived"; fi
fi

touched_src=0
for t in $triggers; do
  case " $(echo $staged | tr '\\n' ' ') " in
    *" $t"*|*" "$t*) touched_src=1; break;;
  esac
  if echo "$staged" | grep -q "^$t"; then
    touched_src=1
    break
  fi
done

[ "$touched_src" = "0" ] && exit 0

if echo "$staged" | grep -qiE '(^|/)CHANGELOG\\.md$'; then
  exit 0
fi

# Yellow text where supported, plain elsewhere.
if [ -t 2 ]; then
  printf '\\033[33m'
fi
echo ""
echo "[AgentOS] This commit touches source code but doesn't include CHANGELOG.md."
echo "          If this is a user-visible change, add a bullet under [Unreleased]"
echo "          in CHANGELOG.md and re-stage. Internal refactors can ignore this."
echo "          Suppress: AGENTOS_SKIP_CHANGELOG_CHECK=1 git commit ..."
echo ""
if [ -t 2 ]; then
  printf '\\033[0m'
fi
exit 0
`;

export interface InstallHooksOptions {
  /** Overwrite even if a non-agentos hook exists. Default false. */
  force?: boolean;
  /** Be quiet about no-ops. Default false. */
  quiet?: boolean;
}

export interface InstallResult {
  status: 'installed' | 'updated' | 'skipped-not-git' | 'skipped-foreign' | 'unchanged';
  hookPath: string | null;
  reason?: string;
}

/**
 * Installs (or updates) AgentOS-managed git hooks under .git/hooks/.
 * Safe to call repeatedly: only writes when content differs.
 * Refuses to touch a foreign (non-agentos) hook unless --force.
 */
export function installPreCommitHook(targetDir: string, opts: InstallHooksOptions = {}): InstallResult {
  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    return { status: 'skipped-not-git', hookPath: null, reason: 'not a git repository' };
  }

  // Respect `core.hooksPath` if the user set one — fall back to .git/hooks
  // otherwise. We don't try to read git config here; just write to the
  // default location which is the overwhelming-majority case.
  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    const isOurs = existing.includes(HOOK_MARKER_PREFIX);
    if (!isOurs && !opts.force) {
      return {
        status: 'skipped-foreign',
        hookPath,
        reason: 'a non-agentos pre-commit hook exists. Re-run with --force to overwrite.',
      };
    }
    if (existing === PRE_COMMIT_HOOK) {
      return { status: 'unchanged', hookPath };
    }
    fs.writeFileSync(hookPath, PRE_COMMIT_HOOK, { mode: 0o755 });
    try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows is fine without chmod */ }
    return { status: 'updated', hookPath };
  }

  fs.writeFileSync(hookPath, PRE_COMMIT_HOOK, { mode: 0o755 });
  try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows */ }
  return { status: 'installed', hookPath };
}

export async function installHooksCommand(opts: { force?: boolean }): Promise<void> {
  const result = installPreCommitHook(process.cwd(), { force: opts.force });
  switch (result.status) {
    case 'installed':
      console.log(`Installed AgentOS pre-commit hook at ${result.hookPath}`);
      break;
    case 'updated':
      console.log(`Updated AgentOS pre-commit hook at ${result.hookPath}`);
      break;
    case 'unchanged':
      console.log(`AgentOS pre-commit hook already up to date.`);
      break;
    case 'skipped-not-git':
      console.log(`Skipped: ${result.reason}`);
      process.exitCode = 1;
      break;
    case 'skipped-foreign':
      console.log(`Skipped: ${result.reason}`);
      process.exitCode = 1;
      break;
  }
}
