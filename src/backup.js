// Consistent snapshot of the live database for the "Download backup" button.
// The copy contains everything (password hash, SMTP / alert secrets), so it is written into a
// private, freshly created directory (mode 0700) and the whole directory is removed afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @returns {{dir: string, file: string, cleanup: () => void}}
 */
export function createBackupSnapshot(db, parentDir = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(parentDir, 'sitesteward-backup-'));
  try { fs.chmodSync(dir, 0o700); } catch { /* mkdtemp already uses 0700 on POSIX; Windows ignores modes */ }
  const file = path.join(dir, 'sitesteward.db');
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a virus scanner can briefly lock the file on Windows: try once more a bit later
      setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 2000).unref();
    }
  };
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { dir, file, cleanup };
}
