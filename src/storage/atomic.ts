/**
 * Crash-safe file writes.
 *
 * `writeFileSync` truncates the target before writing its bytes, so a crash
 * or kill mid-write leaves a half-written (often empty) file. For Franklin
 * that means a wiped portfolio (cross-session P&L — the Trading vertical's
 * headline feature) or a wiped content library (budget `spentUsd`). We
 * instead write to a sibling temp file and `renameSync` it into place:
 * rename is atomic on the same filesystem, so a reader ever sees only the
 * complete old file or the complete new one — never a torn write. The
 * previous good copy is preserved as `<file>.bak` for recovery.
 */

import { writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function atomicWriteFileSync(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, 'utf-8');
  // Snapshot the last good file before swapping, so an interrupted future
  // write (or a corrupt new payload) is still recoverable from <file>.bak.
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, `${filePath}.bak`); } catch { /* best-effort */ }
  }
  renameSync(tmp, filePath);
}
