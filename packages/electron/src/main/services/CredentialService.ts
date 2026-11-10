/**
 * CredentialService - Manages encryption key for E2E encrypted sync.
 *
 * This service handles:
 * - Auto-generating secure encryption key seed on first launch
 * - Storing the key seed securely using Electron's safeStorage API (OS keychain)
 * - Providing the encryption key seed for session sync and mobile device pairing
 *
 * Security notes:
 * - Encryption key seed is generated locally and NEVER sent to the server
 * - The key seed is only shared via QR code for mobile pairing
 * - Authentication is handled separately by StytchAuthService
 */

import { safeStorage } from 'electron';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { AnalyticsService } from './analytics/AnalyticsService';
import type { PersonalMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

/**
 * Encryption credentials for E2E encrypted sync.
 * Authentication is handled by StytchAuthService.
 */
export interface SyncCredentials {
  encryptionKeySeed: string; // Base64 encoded 32 bytes - never sent to server
  createdAt: number;
}

const CREDENTIALS_FILE = 'sync-credentials.enc';
const CREDENTIAL_LOAD_ERROR = 'Sync credentials could not be loaded. The existing encryption key file has been preserved.';

let cachedCredentials: SyncCredentials | null = null;

/**
 * Get the path to the encrypted credentials file.
 */
function getCredentialsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, CREDENTIALS_FILE);
}

/**
 * Generate a cryptographically secure random string (base64 encoded).
 */
function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('base64');
}

/**
 * Check if safeStorage is available for encryption.
 */
function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Create new credentials with auto-generated encryption key seed.
 */
function createCredentials(): SyncCredentials {
  return {
    encryptionKeySeed: generateSecureToken(32),
    createdAt: Date.now(),
  };
}

/**
 * Save credentials to disk using safeStorage encryption.
 */
function saveCredentials(credentials: SyncCredentials): void {
  const credentialsPath = getCredentialsPath();
  const jsonData = JSON.stringify(credentials);
  // Write then rename, so a crash never leaves a truncated key file.
  const tempPath = `${credentialsPath}.tmp`;

  if (isSafeStorageAvailable()) {
    // Encrypt using OS keychain
    const encrypted = safeStorage.encryptString(jsonData);
    fs.writeFileSync(tempPath, encrypted);
    logger.main.info('[CredentialService] Credentials saved with safeStorage encryption');
  } else {
    // Fallback: save as plain JSON (with warning)
    logger.main.warn('[CredentialService] safeStorage not available - saving credentials without encryption');
    fs.writeFileSync(tempPath, jsonData, 'utf8');
  }
  fs.renameSync(tempPath, credentialsPath);
}

/**
 * Load credentials from disk using safeStorage decryption.
 */
function loadCredentials(): SyncCredentials | null {
  const credentialsPath = getCredentialsPath();

  let fileData: Buffer;
  try {
    fileData = fs.readFileSync(credentialsPath);
  } catch (error) {
    // Only a missing file permits creating a key. Access/keychain failures must
    // never replace the key that existing synced data was encrypted with.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(CREDENTIAL_LOAD_ERROR);
  }

  try {
    const jsonData = isSafeStorageAvailable()
      ? safeStorage.decryptString(fileData)
      : fileData.toString('utf8');
    const credentials = JSON.parse(jsonData) as SyncCredentials | null;
    // Keep the existing minimum seed length requirement (32 bytes in base64),
    // but preserve invalid credentials for recovery instead of rotating them.
    if (!credentials || typeof credentials.encryptionKeySeed !== 'string' || credentials.encryptionKeySeed.length < 43) {
      throw new Error('Invalid credential seed');
    }
    return credentials;
  } catch {
    // JSON parse errors can contain credential contents; do not expose them in
    // logs or IPC errors. Failure leaves the file and the cache untouched.
    throw new Error(CREDENTIAL_LOAD_ERROR);
  }
}

/**
 * Get or create sync credentials.
 *
 * On first launch, generates new encryption key seed and saves it securely.
 * On subsequent launches, loads existing credentials from disk.
 */
export function getCredentials(): SyncCredentials {
  // Return cached credentials if available
  if (cachedCredentials) {
    return cachedCredentials;
  }

  // Try to load existing credentials
  let credentials = loadCredentials();

  if (!credentials) {
    // First launch - generate new credentials
    logger.main.info('[CredentialService] First launch - generating new encryption key seed');
    credentials = createCredentials();
    saveCredentials(credentials);
    logger.main.info('[CredentialService] New encryption key seed generated', {
      createdAt: new Date(credentials.createdAt).toISOString(),
    });
  } else {
    logger.main.info('[CredentialService] Loaded existing credentials');
  }

  // Cache for subsequent calls
  cachedCredentials = credentials;
  return credentials;
}

/**
 * Check if credentials exist (without loading them).
 */
export function hasCredentials(): boolean {
  return fs.existsSync(getCredentialsPath());
}

/**
 * Reset encryption key seed - generates a new one.
 *
 * WARNING: This will invalidate any paired mobile devices.
 * They will need to re-scan the QR code.
 */
export function resetCredentials(): SyncCredentials {
  logger.main.info('[CredentialService] Resetting encryption key seed...');

  const credentials = createCredentials();
  saveCredentials(credentials);
  cachedCredentials = credentials;

  logger.main.info('[CredentialService] New encryption key seed generated', {
    createdAt: new Date(credentials.createdAt).toISOString(),
  });

  return credentials;
}

const COMPUTER_PAIRING_PREFIX = 'nimbalyst-computer-pair:1:';

function isValidSeed(seed: unknown): seed is string {
  return typeof seed === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(seed) && Buffer.from(seed, 'base64').length === 32;
}

/**
 * Pairing code that lets another desktop of the same account adopt this
 * desktop's sync key. Desktops cannot scan the mobile QR code.
 */
export function createComputerPairingCode(personalUserId: PersonalMemberId): string {
  if (!personalUserId) throw new Error('Sign in to sync before pairing another computer.');
  const body = JSON.stringify({ u: personalUserId, s: getCredentials().encryptionKeySeed });
  return COMPUTER_PAIRING_PREFIX + Buffer.from(body, 'utf8').toString('base64url');
}

/** Returns the sync key carried by a pairing code, refusing codes from another account. */
export function readComputerPairingCode(code: string, personalUserId: PersonalMemberId): string {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed.startsWith(COMPUTER_PAIRING_PREFIX)) throw new Error('This is not a Nimbalyst computer pairing code.');
  let parsed: { u?: unknown; s?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(COMPUTER_PAIRING_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('This pairing code is incomplete. Copy it again.');
  }
  if (!isValidSeed(parsed?.s)) throw new Error('This pairing code is incomplete. Copy it again.');
  if (!personalUserId || parsed.u !== personalUserId) throw new Error('This code comes from a different Nimbalyst account. Sign in with the same account on both computers.');
  return parsed.s;
}

/**
 * Replace this desktop's sync key with another desktop's. The previous key is
 * kept in a backup file so the change can be undone.
 */
export function adoptEncryptionKeySeed(seed: string): { changed: boolean; backupPath?: string } {
  if (!isValidSeed(seed)) throw new Error('Invalid sync key.');
  const current = getCredentials();
  if (current.encryptionKeySeed === seed) return { changed: false };
  const credentialsPath = getCredentialsPath();
  const backupPath = `${credentialsPath}.before-pairing-${Date.now()}`;
  fs.copyFileSync(credentialsPath, backupPath);
  if (fs.statSync(backupPath).size !== fs.statSync(credentialsPath).size) throw new Error('Could not back up the current sync key. Nothing was changed.');
  const credentials = { encryptionKeySeed: seed, createdAt: Date.now() };
  saveCredentials(credentials);
  cachedCredentials = credentials;
  logger.main.info('[CredentialService] Adopted sync key from another computer; previous key backed up');
  return { changed: true, backupPath };
}

/**
 * Get the encryption key seed (for deriving encryption key).
 */
export function getEncryptionKeySeed(): string {
  return getCredentials().encryptionKeySeed;
}

/**
 * Check if safeStorage encryption is being used.
 */
export function isUsingSecureStorage(): boolean {
  return isSafeStorageAvailable();
}

/**
 * Generate QR pairing payload for mobile device.
 *
 * The QR code contains the encryption key seed, server URL, analytics ID, and sync email.
 * Mobile devices authenticate independently via Stytch OAuth, but must use the same email.
 *
 * @param serverUrl - The sync server URL
 * @param syncEmail - The email address used for sync (mobile must login with same email)
 */
export function generateQRPairingPayload(
  serverUrl: string,
  syncEmail?: string,
  personalOrgId?: string,
  personalUserId?: string,
): {
  version: number;
  serverUrl: string;
  encryptionKeySeed: string;
  expiresAt: number;
  analyticsId: string;
  syncEmail?: string;
  personalOrgId?: string;
  personalUserId?: string;
} {
  const credentials = getCredentials();

  // QR code expires in 15 minutes for security
  const expiresAt = Date.now() + 15 * 60 * 1000;

  // Include analytics ID for identity linking (v3)
  const analyticsId = AnalyticsService.getInstance().getDistinctId();

  return {
    version: 5, // Version 5 = includes personalOrgId/personalUserId for room routing
    serverUrl,
    encryptionKeySeed: credentials.encryptionKeySeed,
    expiresAt,
    analyticsId,
    syncEmail,
    personalOrgId,
    personalUserId,
  };
}
