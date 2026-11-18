import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeGWorkspaceCredentialFile,
  GWORKSPACE_CREDENTIAL_FILENAME,
  type GWorkspaceCredentialFile,
} from '../src/trusted-process/gworkspace-credentials.js';

describe('writeGWorkspaceCredentialFile', () => {
  let testDir: string;
  /** Files the sandboxed server must never reach: outside its credential directory. */
  let outsideDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gworkspace-creds-test-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'gworkspace-creds-outside-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // The relay writes this file into a directory the srt-sandboxed
  // google-workspace server may write: a compromised server can plant any
  // entry there before the next token refresh.
  describe('in a directory the sandboxed server can write', () => {
    const filePath = (): string => join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);

    function expectRegularPrivateCredential(accessToken: string): void {
      const stats = lstatSync(filePath());
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.mode & 0o777).toBe(0o600);
      const content = JSON.parse(readFileSync(filePath(), 'utf-8')) as GWorkspaceCredentialFile;
      expect(content.access_token).toBe(accessToken);
    }

    it('never writes through symlinks planted at the old temporary name or the credential name', () => {
      const victimTmp = join(outsideDir, 'victim-tmp');
      const victimFinal = join(outsideDir, 'victim-final');
      writeFileSync(victimTmp, 'ORIGINAL-TMP\n');
      writeFileSync(victimFinal, 'ORIGINAL-FINAL\n');
      symlinkSync(victimTmp, `${filePath()}.tmp`);
      symlinkSync(victimFinal, filePath());

      writeGWorkspaceCredentialFile(testDir, 'ya29.refreshed-token', Date.now() + 3600_000, ['scope']);

      // The link targets outside the directory are untouched ...
      expect(readFileSync(victimTmp, 'utf-8')).toBe('ORIGINAL-TMP\n');
      expect(readFileSync(victimFinal, 'utf-8')).toBe('ORIGINAL-FINAL\n');
      expect(readdirSync(outsideDir).sort()).toEqual(['victim-final', 'victim-tmp']);
      // ... and the credential file replaced the planted link instead of following it.
      expectRegularPrivateCredential('ya29.refreshed-token');
    });

    it('never creates the target of a dangling symlink planted at the old temporary name', () => {
      const created = join(outsideDir, 'created-by-the-relay');
      symlinkSync(created, `${filePath()}.tmp`);

      writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

      expect(existsSync(created)).toBe(false);
      expectRegularPrivateCredential('ya29.token');
    });

    it('refuses a credential directory that is a symlink, writing nothing through it', () => {
      const linkedDir = join(testDir, 'linked-creds');
      symlinkSync(outsideDir, linkedDir);

      expect(() => writeGWorkspaceCredentialFile(linkedDir, 'ya29.token', Date.now() + 3600_000, ['scope'])).toThrow(
        expect.objectContaining({ code: 'NOT_DIRECTORY' }),
      );
      expect(readdirSync(outsideDir)).toEqual([]);
    });

    it('fails, leaving it in place, when a directory occupies the credential name', () => {
      mkdirSync(filePath());

      expect(() => writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope'])).toThrow(
        expect.objectContaining({ code: 'NOT_REGULAR_FILE' }),
      );
      expect(statSync(filePath()).isDirectory()).toBe(true);
      // No temporary file is left behind for the server to find.
      expect(readdirSync(testDir)).toEqual([GWORKSPACE_CREDENTIAL_FILENAME]);
    });
  });

  it('writes a valid credential file', () => {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];
    const expiresAt = Date.now() + 3600_000;

    writeGWorkspaceCredentialFile(testDir, 'ya29.test-token', expiresAt, scopes);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as GWorkspaceCredentialFile;
    expect(content.access_token).toBe('ya29.test-token');
    expect(content.expiry_date).toBe(expiresAt);
    expect(content.token_type).toBe('Bearer');
    expect(content.scope).toBe(scopes.join(' '));
  });

  it('does NOT include refresh_token in the output', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const raw = readFileSync(filePath, 'utf-8');

    // Check both the parsed object and raw text for extra safety
    expect(raw).not.toContain('refresh_token');
    const content = JSON.parse(raw) as Record<string, unknown>;
    expect(content).not.toHaveProperty('refresh_token');
  });

  it('creates the directory if it does not exist', () => {
    const nestedDir = join(testDir, 'nested', 'creds');
    expect(existsSync(nestedDir)).toBe(false);

    writeGWorkspaceCredentialFile(nestedDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(nestedDir, GWORKSPACE_CREDENTIAL_FILENAME))).toBe(true);
  });

  it('sets file permissions to 0o600', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const stats = statSync(filePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing file atomically', () => {
    const firstExpiry = Date.now() + 3600_000;
    const secondExpiry = Date.now() + 7200_000;

    writeGWorkspaceCredentialFile(testDir, 'ya29.first', firstExpiry, ['scope']);
    writeGWorkspaceCredentialFile(testDir, 'ya29.second', secondExpiry, ['scope']);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as GWorkspaceCredentialFile;
    expect(content.access_token).toBe('ya29.second');
    expect(content.expiry_date).toBe(secondExpiry);
  });

  it('does not leave a temporary file after successful write', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    expect(readdirSync(testDir)).toEqual([GWORKSPACE_CREDENTIAL_FILENAME]);
  });

  it('handles empty scopes array', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, []);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as GWorkspaceCredentialFile;
    expect(content.scope).toBe('');
  });
});
