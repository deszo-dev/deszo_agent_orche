import { readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Workspace roots must exist. realpath resolves symbolic links and Windows junctions before comparison.
export function resolveWorkspaceRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('Workspace root is not a path.');
  const root = realpathSync.native(resolve(cwd));
  if (!statSync(root).isDirectory()) throw new Error('Workspace root is not a directory.');
  return root;
}

function containsOrEquals(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// path.relative supplies platform path semantics and, unlike a string prefix, respects path components
// and returns an absolute result for roots on different Windows volumes.
export function workspaceRootsOverlap(first, second) {
  return containsOrEquals(first, second) || containsOrEquals(second, first);
}

// Entries one alias walk may visit before the workspace is refused. Past the budget the walk cannot prove the absence of an alias.
export const ALIAS_WALK_ENTRY_LIMIT = 250_000;

// A junction or symbolic link reaches its target: a write through it lands there, and an alias may lead to a directory that holds
// another alias. Root overlap compares only the workspace's own real directory, so the walk follows every alias chain from the
// workspace, reporting an overlap for any reached directory or alias target that overlaps a protected root. Each real directory is
// visited once, so a cycle ends. It also reports an overlap for a directory it cannot read, and for a walk past its entry budget:
// each of those leaves the workspace unproven, so it is refused.
export function workspaceAliasOverlap(root, protectedRoots, { maxEntries = ALIAS_WALK_ENTRY_LIMIT } = {}) {
  let visited = 0;
  const reached = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let real;
    try { real = realpathSync.native(directory); }
    catch { return true; }
    if (reached.has(real)) continue;
    reached.add(real);
    if (protectedRoots.some(protectedRoot => workspaceRootsOverlap(protectedRoot, real))) return true;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { return true; }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) return true;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (aliasTargetOverlaps(path, protectedRoots)) return true;
        if (aliasIsDirectory(path)) pending.push(path);
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return false;
}

// Node reports a Windows junction as a symbolic link, and its realpath is the directory it reaches. A dangling alias has no real
// target yet, so its declared target counts instead: a target that appears later cannot slip past the check. An unreadable target
// overlaps, because the walk cannot tell where it leads.
function aliasTargetOverlaps(path, protectedRoots) {
  let target;
  try { target = realpathSync.native(path); }
  catch {
    try { target = resolve(dirname(path), readlinkSync(path)); }
    catch { return true; }
  }
  return protectedRoots.some(protectedRoot => workspaceRootsOverlap(protectedRoot, target));
}

// A dangling alias or an alias to a file has no directory to walk into; its target was checked above.
function aliasIsDirectory(path) {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}
