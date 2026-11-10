// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspect } from 'node:util';
import { asPersonalMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

const h = vi.hoisted(() => ({
  userData: '',
  readError: null as NodeJS.ErrnoException | null,
  available: vi.fn(() => true),
  decrypt: vi.fn((bytes: Buffer) => bytes.toString('utf8')),
  encrypt: vi.fn((json: string) => Buffer.from(json)),
  log: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  safeStorage: { isEncryptionAvailable: h.available, decryptString: h.decrypt, encryptString: h.encrypt },
}));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (h.readError) throw h.readError;
    return actual.readFileSync(...args);
  } };
});
vi.mock('../../utils/logger', () => ({ logger: { main: { info: h.log, warn: h.log, error: h.log } } }));
vi.mock('../analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ getDistinctId: () => 'test' }) } }));

const original = { encryptionKeySeed: Buffer.alloc(32, 7).toString('base64'), createdAt: 1700000000000 };
const credentialPath = () => join(h.userData, 'sync-credentials.enc');

beforeEach(() => {
  vi.resetModules();
  h.userData = fs.mkdtempSync(join(tmpdir(), 'nimbalyst-sync-credentials-'));
  h.readError = null;
  h.log.mockClear();
  h.available.mockReset().mockReturnValue(true);
  h.decrypt.mockReset().mockImplementation(bytes => bytes.toString('utf8'));
  h.encrypt.mockReset().mockImplementation(json => Buffer.from(json));
});
afterEach(() => { h.readError = null; fs.rmSync(h.userData, { recursive: true, force: true }); });

describe('existing sync credentials', () => {
  it.each(['json', 'decrypt', 'metadata'])('does not disclose credential contents through %s errors or logs', async source => {
    const secret = 'KEYSECRET';
    fs.writeFileSync(credentialPath(), source === 'json' ? secret : JSON.stringify({ ...original, createdAt: secret }));
    if (source === 'decrypt') h.decrypt.mockImplementation(() => { throw new Error(secret); });
    const service = await import('../CredentialService');
    if (source === 'metadata') {
      expect(service.getCredentials().encryptionKeySeed).toBe(original.encryptionKeySeed);
    } else {
      let failure: unknown;
      try { service.getCredentials(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(secret);
    }
    expect(inspect(h.log.mock.calls, { depth: null })).not.toContain(secret);
  });

  it.each(['read', 'decrypt', 'json', 'unavailable keychain'])('preserves the file after a %s failure and can retry', async failure => {
    const bytes = Buffer.from(JSON.stringify(original));
    fs.writeFileSync(credentialPath(), bytes);
    if (failure === 'read') h.readError = Object.assign(new Error('access denied'), { code: 'EACCES' });
    if (failure === 'decrypt') h.decrypt.mockImplementation(() => { throw Object.assign(new Error('keychain locked'), { code: 'ENOENT' }); });
    if (failure === 'json') h.decrypt.mockReturnValue('{invalid json');
    if (failure === 'unavailable keychain') {
      fs.writeFileSync(credentialPath(), Buffer.from([0, 255, 1, 2]));
      h.available.mockReturnValue(false);
    }
    const savedBytes = failure === 'unavailable keychain' ? Buffer.from([0, 255, 1, 2]) : bytes;
    const service = await import('../CredentialService');
    expect(() => service.getCredentials()).toThrow();
    expect(h.encrypt).not.toHaveBeenCalled();
    h.readError = null;
    expect(fs.readFileSync(credentialPath())).toEqual(savedBytes);
    h.available.mockReturnValue(true);
    h.decrypt.mockReturnValue(JSON.stringify(original));
    expect(service.getCredentials()).toEqual(original);
    expect(fs.readFileSync(credentialPath())).toEqual(savedBytes);
  });

  it.each([null, {}, { ...original, encryptionKeySeed: 'short' }, { ...original, encryptionKeySeed: 123 }])('preserves invalid stored credentials: %j', async value => {
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(credentialPath(), bytes);
    const service = await import('../CredentialService');
    expect(() => service.getCredentials()).toThrow();
    expect(fs.readFileSync(credentialPath())).toEqual(bytes);
    expect(h.encrypt).not.toHaveBeenCalled();
  });

  it.each([true, false])('loads the same existing key with safeStorage available=%s', async available => {
    h.available.mockReturnValue(available);
    fs.writeFileSync(credentialPath(), JSON.stringify(original));
    const service = await import('../CredentialService');
    expect(service.getCredentials()).toEqual(original);
    expect(service.getEncryptionKeySeed()).toBe(original.encryptionKeySeed);
    expect(h.encrypt).not.toHaveBeenCalled();
  });
});

it('creates a key only when the credential file is absent, and reloads it after restart', async () => {
  const service = await import('../CredentialService');
  const credentials = service.getCredentials();
  expect(Buffer.from(credentials.encryptionKeySeed, 'base64')).toHaveLength(32);
  expect(JSON.parse(fs.readFileSync(credentialPath(), 'utf8'))).toEqual(credentials);
  vi.resetModules();
  expect((await import('../CredentialService')).getCredentials()).toEqual(credentials);
  expect(h.encrypt).toHaveBeenCalledTimes(1);
});

it('pairs a second computer of the same account and keeps its previous key in a backup', async () => {
  fs.writeFileSync(credentialPath(), JSON.stringify(original));
  const studio = await import('../CredentialService');
  const code = studio.createComputerPairingCode(asPersonalMemberId('member-1'));
  expect(JSON.parse(Buffer.from(code.replace('nimbalyst-computer-pair:1:', ''), 'base64url').toString('utf8'))).toEqual({ u: 'member-1', s: original.encryptionKeySeed });

  fs.writeFileSync(credentialPath(), JSON.stringify({ encryptionKeySeed: Buffer.alloc(32, 9).toString('base64'), createdAt: 1 }));
  vi.resetModules();
  const laptop = await import('../CredentialService');
  expect(() => laptop.readComputerPairingCode(code, asPersonalMemberId('member-2'))).toThrow('different Nimbalyst account');
  expect(() => laptop.readComputerPairingCode('hello', asPersonalMemberId('member-1'))).toThrow('not a Nimbalyst computer pairing code');
  expect(() => laptop.readComputerPairingCode(code.slice(0, -10), asPersonalMemberId('member-1'))).toThrow('incomplete');
  const body = code.slice(code.indexOf('pair:1:'));
  expect(laptop.readComputerPairingCode(body, asPersonalMemberId('member-1'))).toBe(original.encryptionKeySeed);
  expect(laptop.readComputerPairingCode(`${code.slice(0, 40)}\n${code.slice(40)}`, asPersonalMemberId('member-1'))).toBe(original.encryptionKeySeed);
  expect(() => laptop.adoptEncryptionKeySeed('short')).toThrow('Invalid sync key');

  const adopted = laptop.adoptEncryptionKeySeed(laptop.readComputerPairingCode(`  ${code}\n`, asPersonalMemberId('member-1')));
  expect(adopted.changed).toBe(true);
  expect(adopted.backupPath).toContain('sync-credentials.enc.before-pairing-');
  expect(fs.existsSync(`${credentialPath()}.tmp`)).toBe(false);
  expect(laptop.getEncryptionKeySeed()).toBe(original.encryptionKeySeed);
  vi.resetModules();
  expect((await import('../CredentialService')).getEncryptionKeySeed()).toBe(original.encryptionKeySeed);
  const backups = fs.readdirSync(h.userData).filter(name => name.startsWith('sync-credentials.enc.before-pairing-'));
  expect(backups).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(join(h.userData, backups[0]), 'utf8')).encryptionKeySeed).toBe(Buffer.alloc(32, 9).toString('base64'));
  expect(laptop.adoptEncryptionKeySeed(original.encryptionKeySeed)).toEqual({ changed: false });
  expect(inspect(h.log.mock.calls, { depth: null })).not.toContain(original.encryptionKeySeed);
});

it('shows the same short key fingerprint on paired computers without revealing the key', async () => {
  fs.writeFileSync(credentialPath(), JSON.stringify(original));
  const service = await import('../CredentialService');
  const fingerprint = service.getSyncKeyFingerprint();
  expect(fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  expect(original.encryptionKeySeed).not.toContain(fingerprint.replace('-', ''));
  service.adoptEncryptionKeySeed(Buffer.alloc(32, 3).toString('base64'));
  expect(service.getSyncKeyFingerprint()).not.toBe(fingerprint);
  service.adoptEncryptionKeySeed(original.encryptionKeySeed);
  expect(service.getSyncKeyFingerprint()).toBe(fingerprint);
});
