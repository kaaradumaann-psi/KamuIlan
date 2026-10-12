/**
 * MIME yardımcıları: ham e-posta metnini başlık + gövdeye ayırır ve RFC 2047
 * kodlanmış başlıkları çözer.
 *
 * Neden ayrı modül: aynı çözümleme hem geliştirme posta kutusunda
 * (`scripts/dev-smtp-server.ts`) hem de e-posta teslim testinde kullanılıyor.
 * İki kopya tutmak, testlerin üretimdeki davranışı ölçmemesine yol açardı.
 */

/**
 * Quoted-printable çözümü. ÖNEMLİ: bayt bazında çözülür, sonra UTF-8'e çevrilir.
 * `String.fromCharCode(=C3)` gibi karakter bazlı çözüm Türkçe harfleri bozar
 * ("Örnek" → "Ãrnek"); eski geliştirme posta kutusu tam olarak bunu yapıyordu.
 */
export function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const char = withoutSoftBreaks[index] as string;
    if (char === '=') {
      const hex = withoutSoftBreaks.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(...Buffer.from(char, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function decodeBodyPart(body: string, encoding: string | null): string {
  const normalized = (encoding ?? '').toLowerCase();
  if (normalized === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/**
 * RFC 2047 kodlanmış başlıkları çözer (=?UTF-8?Q?...?= / B).
 *
 * Not: Yan yana gelen kodlanmış kelimeler arasındaki boşluk yok sayılır (RFC 2047
 * §6.2). Aksi hâlde uzun Türkçe konu satırları "sözleşmeli  personel" gibi çift
 * boşluklu görünür.
 */
export function decodeMimeWords(value: string): string {
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset: string, encoding: string, text: string) => {
    if (encoding.toUpperCase() === 'B') {
      try {
        return Buffer.from(text, 'base64').toString('utf8');
      } catch {
        return text;
      }
    }
    const normalized = text.replace(/_/g, ' ');
    const bytes: number[] = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index] as string;
      const hex = normalized.slice(index + 1, index + 3);
      if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
      bytes.push(...Buffer.from(char, 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
  });
}

/** Basit MIME ayrıştırıcı: başlıklar + tercihen HTML gövde. */
export function parseMessage(raw: string): { headers: Record<string, string>; html: string; text: string } {
  const separatorIndex = raw.search(/\r?\n\r?\n/);
  const headerBlock = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
  const body = separatorIndex >= 0 ? raw.slice(separatorIndex).replace(/^\r?\n\r?\n/, '') : '';

  const headers: Record<string, string> = {};
  let currentKey = '';
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey] ?? ''} ${line.trim()}`;
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    currentKey = match[1].toLowerCase();
    headers[currentKey] = match[2] ?? '';
  }

  const contentType = headers['content-type'] ?? 'text/plain';
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!boundaryMatch?.[1]) {
    const decoded = decodeBodyPart(body, headers['content-transfer-encoding'] ?? null);
    const isHtml = contentType.includes('text/html');
    return { headers, html: isHtml ? decoded : '', text: isHtml ? '' : decoded };
  }

  const parts = body.split(`--${boundaryMatch[1]}`);
  let html = '';
  let text = '';
  for (const part of parts) {
    const partSeparator = part.search(/\r?\n\r?\n/);
    if (partSeparator < 0) continue;
    const partHeaders = part.slice(0, partSeparator).toLowerCase();
    const partBody = part.slice(partSeparator).replace(/^\r?\n\r?\n/, '');
    const encoding = /content-transfer-encoding:\s*([^\r\n;]+)/.exec(partHeaders)?.[1]?.trim() ?? null;
    const decoded = decodeBodyPart(partBody, encoding);
    if (partHeaders.includes('text/html') && html === '') html = decoded;
    else if (partHeaders.includes('text/plain') && text === '') text = decoded;
  }
  return { headers, html, text };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;',
  );
}
