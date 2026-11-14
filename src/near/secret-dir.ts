// Where account keys are written. Default: data/secret (git-ignored, inside the repo). Override: QT_SECRET_DIR (for example a folder on another drive).
// Nothing here prints a key. A mainnet command refuses to run if the secret directory sits inside a cloud-synchronised folder (OneDrive, Dropbox, ...).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const DEFAULT_SECRET_DIR = 'data/secret';
type Env = Record<string, string | undefined>;

export function secretDir(env: Env = process.env): string {
  const o = env.QT_SECRET_DIR?.trim();
  return o ? o.replace(/[\\/]+$/, '') : DEFAULT_SECRET_DIR;
}
/** Path of a secret file. `name` is a plain file name such as `mainnet-config.json`. */
export function secretPath(name: string, env: Env = process.env): string {
  if (/[\\/]/.test(name)) throw new Error(`secret file name must not contain a path separator: ${name}`);
  return `${secretDir(env)}/${name}`;
}

/** A path that starts with a drive letter or \\\\ is a Windows path on EVERY OS: use win32 rules for it, so the same input gives the same answer on a Windows laptop and on a Linux CI runner. */
const looksWindows = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
const pathFor = (...ps: string[]) => (ps.some(looksWindows) ? nodePath.win32 : nodePath);
const underDir = (child: string, parent: string) => {
  const m = pathFor(child, parent), n = (x: string) => m.resolve(x).toLowerCase();
  return n(child) === n(parent) || n(child).startsWith(n(parent) + m.sep);
};

/** Folders that a sync client uploads. Environment roots (Windows sets these) plus well-known names anywhere in the path. */
export function syncedRoots(env: Env = process.env): string[] {
  return ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map((k) => env[k]).filter((v): v is string => !!v);
}
export function isSyncedPath(path: string, env: Env = process.env, cwd = process.cwd()): { synced: boolean; why: string } {
  const pm = pathFor(path, cwd, ...syncedRoots(env));
  const abs = pm.isAbsolute(path) ? path : pm.resolve(cwd, path);
  for (const r of syncedRoots(env)) if (underDir(abs, r)) return { synced: true, why: `inside the OneDrive folder ${r}` };
  const m = abs.match(/(^|[\\/])(onedrive[^\\/]*|dropbox|google drive|icloud drive|iclouddrive|box sync|sync\.com)([\\/]|$)/i);
  if (m) return { synced: true, why: `the path contains a synchronised-folder name ("${m[2]}")` };
  return { synced: false, why: 'not inside a known synchronised folder' };
}

export interface SecretDirReport { dir: string; resolved: string; synced: boolean; why: string; overridden: boolean; insideRepo: boolean }
export function inspectSecretDir(env: Env = process.env, cwd = process.cwd(), repoRoot = cwd): SecretDirReport {
  const dir = secretDir(env);
  const m = pathFor(dir, cwd, repoRoot);
  const resolved = m.isAbsolute(dir) ? m.resolve(dir) : m.resolve(cwd, dir);
  const s = isSyncedPath(resolved, env, cwd);
  return { dir, resolved, synced: s.synced, why: s.why, overridden: !!env.QT_SECRET_DIR?.trim(), insideRepo: underDir(resolved, repoRoot) };
}

/** Mainnet keys must not be uploaded to a cloud drive. Returns a problem text, or null when fine. */
export function secretDirProblem(mainnet: boolean, env: Env = process.env, cwd = process.cwd()): string | null {
  const r = inspectSecretDir(env, cwd);
  if (mainnet && r.synced) {
    return `the secret directory (${r.resolved}) is ${r.why}: mainnet keys would be uploaded to a cloud drive. Set QT_SECRET_DIR to a folder outside it (for example QT_SECRET_DIR=D:\\qt-secrets) and run again.`;
  }
  return null;
}
/** Exit(1) with a clear message when a mainnet command would write keys into a synchronised folder. */
export function requireSafeSecretDir(mainnet: boolean) {
  const p = secretDirProblem(mainnet);
  if (p) { console.error('STOP:', p); process.exit(1); }
}

/** Create the secret directory (owner-only where the OS supports it) and write one file the same way. Never logs content. */
export function writeSecretFile(path: string, content: string) {
  const dir = nodePath.dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows: POSIX modes are not enforced; the folder ACL of the user profile applies */ }
}
export function ensureSecretDir(env: Env = process.env) {
  const dir = secretDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
