import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
