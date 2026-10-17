/**
 * Conservatively removes common PII/credential patterns before an optional
 * public-source snapshot is written. This is not a complete PII detector;
 * every captured page still needs human review before it can be committed.
 */
export function scrubSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  // Query values can contain searches or personal data even when their names do
  // not look sensitive. Keep the stable origin/path as provenance only.
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}

export function scrubSnapshot(input: string): { text: string; notes: string[] } {
  let text = input;
  const notes: string[] = [];
  const sensitiveField = /(?:e-?mail|e-?posta|phone|mobile|telephone|telno|telefon|tckn|identity|kimlik|tcno|birth|address|personal|applicant|candidate|individual|personname|fullname|firstname|lastname|adsoyad|soyad|isim|token|api[_-]?key|session|csrf|nonce|auth|password|secret)/i;
  try {
    const parsed = JSON.parse(input) as unknown;
    let redactedFields = 0;
    const scrubValue = (value: unknown, key = ''): unknown => {
      if (key && sensitiveField.test(key)) {
        redactedFields += 1;
        return '[REDACTED]';
      }
      if (Array.isArray(value)) return value.map((entry) => scrubValue(entry));
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, scrubValue(child, childKey)]),
        );
      }
      return value;
    };
    text = JSON.stringify(scrubValue(parsed), null, 2);
    if (redactedFields > 0) notes.push(`${redactedFields} JSON alanı hassas alan adı nedeniyle maskelendi.`);
  } catch {
    // HTML/plain text below is scrubbed conservatively with pattern matching.
  }
  const replace = (pattern: RegExp, replacement: string, note: string): void => {
    const updated = text.replace(pattern, replacement);
    if (updated !== text) notes.push(note);
    text = updated;
  };

  replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    '[EMAIL REDACTED]',
    'E-posta adresleri metin ve HTML gövdesinden maskelendi.',
  );
  replace(
    /\b[1-9]\d{10}\b/g,
    '[TCKN-LIKE REDACTED]',
    '11 basamaklı T.C. kimlik numarası benzeri diziler maskelendi.',
  );
  replace(
    /\b(?:\+90|0090|0)?[\s().-]*\(?5\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/g,
    '[PHONE REDACTED]',
    'Türkiye cep telefonu biçimindeki diziler maskelendi.',
  );
  replace(
    /([?&](?:token|access_token|api[_-]?key|apikey|session(?:id)?|sid|csrf|nonce|auth|password|secret)=)[^&"'<>\s#]+/gi,
    '$1[REDACTED]',
    'URL query içindeki token/session/auth/CSRF benzeri değerler maskelendi.',
  );
  replace(
    /(<input\b[^>]*(?:name|id)\s*=\s*["'][^"']*(?:token|session|csrf|nonce|auth|password|secret|email|e-?posta|phone|mobile|tckn|identity|personal|applicant|candidate|fullname|firstname|lastname|adsoyad|soyad)[^"']*["'][^>]*\bvalue\s*=\s*)["'][^"']*["']/gi,
    '$1"[REDACTED]"',
    'Hassas token/session/auth/iletişim/kimlik/aday input değerleri maskelendi.',
  );
  notes.push('Response header/cookie ve request credentialları dosyaya alınmadı; sadece body saklandı.');
  notes.push('Otomatik scrub kişisel veriyi kusursuz tespit etmez; commit öncesi manuel PII/lisans/ToS incelemesi gerekir.');
  return { text, notes: [...new Set(notes)] };
}
