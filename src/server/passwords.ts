/**
 * Parola özetleme (scrypt).
 *
 * Kurallar (§14):
 *  - Parola asla düz metin olarak saklanmaz ve loglanmaz.
 *  - Her kullanıcı için rastgele tuz üretilir (aynı parola aynı özeti vermez).
 *  - Kıyaslama zamanlama saldırısına dayanıklıdır (timingSafeEqual).
 *  - Algoritma adı kayıtla birlikte saklanır; ileride yükseltme mümkündür.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

export const PASSWORD_ALGO = 'scrypt';
const KEY_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 10;
/** Kaba kuvvet denemelerini yavaşlatmak için asgari parola karmaşıklığı. */
const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'kamuradar',
  'parola123',
  'sifre1234',
  'admin1234',
]);

export interface PasswordHash {
  hash: string;
  salt: string;
  algo: typeof PASSWORD_ALGO;
}

export async function hashPassword(plain: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH);
  return { hash: derived.toString('hex'), salt, algo: PASSWORD_ALGO };
}

export async function verifyPassword(plain: string, storedHash: string, salt: string): Promise<boolean> {
  if (!storedHash || !salt) return false;
  try {
    const derived = await scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH);
    const expected = Buffer.from(storedHash, 'hex');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(expected, derived);
  } catch {
    // Bozuk kayıt: "doğrulandı" dönmez.
    return false;
  }
}

export interface PasswordValidationResult {
  valid: boolean;
  problems: string[];
}

/** Parola politikası: uzunluk, çeşitlilik ve yaygın zayıf parola kontrolü. */
export function validatePasswordStrength(plain: string, context: { email?: string } = {}): PasswordValidationResult {
  const problems: string[] = [];
  if (plain.length < PASSWORD_MIN_LENGTH) problems.push(`En az ${PASSWORD_MIN_LENGTH} karakter olmalı.`);
  if (plain.length > 200) problems.push('En fazla 200 karakter olabilir.');
  if (!/[a-zçğıöşü]/u.test(plain) || !/[A-ZÇĞİÖŞÜ]/u.test(plain)) problems.push('En az bir küçük ve bir büyük harf içermeli.');
  if (!/\d/.test(plain)) problems.push('En az bir rakam içermeli.');
  if (COMMON_WEAK_PASSWORDS.has(plain.toLowerCase())) problems.push('Çok yaygın bir parola seçildi; farklı bir parola kullanın.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && plain.toLowerCase().includes(local)) {
    problems.push('Parola e-posta adresinizi içermemeli.');
  }
  return { valid: problems.length === 0, problems };
}
