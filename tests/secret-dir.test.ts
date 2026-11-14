import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_DIR, inspectSecretDir, isSyncedPath, secretDir, secretDirProblem, secretPath, writeSecretFile } from '../src/near/secret-dir';
import { envFileSetsAllowMainnet } from '../src/near/setup-plan';

describe('QT_SECRET_DIR', () => {
  it('defaults to data/secret when no override is configured', () => { expect(secretDir({})).toBe(DEFAULT_SECRET_DIR); expect(secretDir({ QT_SECRET_DIR: '   ' })).toBe(DEFAULT_SECRET_DIR); expect(secretPath('mainnet-config.json', {})).toBe('data/secret/mainnet-config.json'); });
  it('uses the override (a folder on another drive) and strips trailing separators', () => {
    expect(secretDir({ QT_SECRET_DIR: 'D:\\qt-secrets\\' })).toBe('D:\\qt-secrets');
    expect(secretPath('mainnet-config.json', { QT_SECRET_DIR: 'D:\\qt-secrets' })).toBe('D:\\qt-secrets/mainnet-config.json');
  });
  it('a secret file name can never carry a path (no traversal out of the secret directory)', () => { expect(() => secretPath('..\\x.json', {})).toThrow(); expect(() => secretPath('a/b.json', {})).toThrow(); });
});

describe('refuses cloud-synchronised folders for mainnet keys', () => {
  const env = { OneDrive: 'C:\\Users\\me\\OneDrive' };
  it('detects the OneDrive root from the environment (the situation of this repository)', () => {
    expect(isSyncedPath('C:\\Users\\me\\OneDrive\\Desktop\\near\\data\\secret', env).synced).toBe(true);
    expect(isSyncedPath('c:\\users\\me\\onedrive\\Desktop', env).synced).toBe(true); // case-insensitive
  });
  it('detects well-known sync folder names even without the environment variable', () => {
    for (const p of ['C:\\Users\\me\\Dropbox\\k', 'C:\\Users\\me\\OneDrive - Contoso\\k', '/home/me/Google Drive/k', '/Users/me/iCloud Drive/k']) expect(isSyncedPath(p, {}).synced, p).toBe(true);
  });
  it('a folder on another drive is fine', () => { expect(isSyncedPath('D:\\qt-secrets', env).synced).toBe(false); expect(isSyncedPath('/srv/qt-secrets', {}).synced).toBe(false); });
  it('mainnet: a synced secret directory is a blocking problem with an actionable message; testnet is not blocked', () => {
    const cwd = 'C:\\Users\\me\\OneDrive\\Desktop\\near';
    const p = secretDirProblem(true, { ...env }, cwd); expect(p).toMatch(/QT_SECRET_DIR/); expect(p).toMatch(/cloud drive/);
    expect(secretDirProblem(false, { ...env }, cwd)).toBeNull();
    expect(secretDirProblem(true, { ...env, QT_SECRET_DIR: 'D:\\qt-secrets' }, cwd)).toBeNull();
  });
  it('inspect reports whether the directory is inside the repository', () => {
    expect(inspectSecretDir({}, '/repo', '/repo').insideRepo).toBe(true);
    expect(inspectSecretDir({ QT_SECRET_DIR: '/elsewhere/s' }, '/repo', '/repo').insideRepo).toBe(false);
  });
});

describe('writing secrets', () => {
  it('creates the directory and the file with restrictive permissions where the OS enforces them, and never echoes content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qt-secret-test-')); const file = join(dir, 'nested', 'x-config.json');
    const logs: unknown[] = []; const orig = console.log; console.log = (...a) => { logs.push(a); };
    try {
      writeSecretFile(file, JSON.stringify({ secretKey: 'ed25519:TOPSECRET' }));
      expect(readFileSync(file, 'utf8')).toContain('TOPSECRET');
      if (process.platform !== 'win32') { expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700); }
    } finally { console.log = orig; rmSync(dir, { recursive: true, force: true }); }
    expect(JSON.stringify(logs)).not.toContain('TOPSECRET');
  });
});

describe('mainnet consent can only come from the shell', () => {
  it('detects ALLOW_MAINNET in .env text (any spelling) and ignores look-alikes', () => {
    expect(envFileSetsAllowMainnet('A=1\nALLOW_MAINNET=1\n')).toBe(true);
    expect(envFileSetsAllowMainnet('  export ALLOW_MAINNET = 1')).toBe(true);
    expect(envFileSetsAllowMainnet('# ALLOW_MAINNET=1')).toBe(false);
    expect(envFileSetsAllowMainnet('NOT_ALLOW_MAINNET=1\nQT_FUNDER_ACCOUNT=x.near')).toBe(false);
  });
});
