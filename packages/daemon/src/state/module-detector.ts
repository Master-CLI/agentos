import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModuleInfo } from './snapshot-engine.js';

/**
 * Detect project modules by scanning for package.json files
 * in the project directory structure.
 */
export function detectModules(projectDir: string): ModuleInfo[] {
  const modules: ModuleInfo[] = [];

  // Check root package.json for workspace definitions
  const rootPkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
      const workspaces: string[] = rootPkg.workspaces ?? [];

      if (workspaces.length > 0) {
        // Monorepo: scan workspace dirs
        for (const pattern of workspaces) {
          const wsDir = path.join(projectDir, pattern.replace(/\/\*$/, ''));
          if (fs.existsSync(wsDir) && fs.statSync(wsDir).isDirectory()) {
            // Check if pattern has wildcard
            if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
              const entries = fs.readdirSync(wsDir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  const mod = readModule(path.join(wsDir, entry.name));
                  if (mod) modules.push(mod);
                }
              }
            } else {
              const mod = readModule(wsDir);
              if (mod) modules.push(mod);
            }
          }
        }
        return modules;
      }
    } catch { /* ignore parse errors */ }
  }

  // Not a monorepo: scan common directory patterns for sub-modules
  const scanDirs = ['src', 'lib', 'packages', 'apps', 'services', 'modules'];
  for (const dirName of scanDirs) {
    const dir = path.join(projectDir, dirName);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const mod = readModule(path.join(dir, entry.name));
          if (mod) {
            modules.push(mod);
          } else {
            // Even without package.json, treat as a module if it has source files
            const subPath = path.join(dir, entry.name);
            const hasSource = fs.readdirSync(subPath).some((f) =>
              f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx')
            );
            if (hasSource) {
              modules.push({ name: entry.name, path: subPath, dependencies: [] });
            }
          }
        }
      }
    }
  }

  // If nothing found, treat root as single module
  if (modules.length === 0) {
    const rootMod = readModule(projectDir);
    if (rootMod) modules.push(rootMod);
  }

  return modules;
}

function readModule(dir: string): ModuleInfo | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    return {
      name: pkg.name ?? path.basename(dir),
      path: dir,
      dependencies: deps,
    };
  } catch {
    return null;
  }
}
