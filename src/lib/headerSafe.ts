/**
 * HTTP başlık değerleri Latin-1 / görünür ASCII aralığıyla sınırlıdır.
 * Türkçe karakter (ör. ı, ş, İ) içeren bir User-Agent, undici tarafından
 * UND_ERR_INVALID_ARG ile reddedilir ve istek ağa hiç çıkmadan düşer.
 * Bu yardımcı, başlığa yazılacak metni güvenli ASCII'ye çevirir.
 */
const TRANSLITERATION: Readonly<Record<string, string>> = {
  ç: 'c',
  Ç: 'C',
  ğ: 'g',
  Ğ: 'G',
  ı: 'i',
  İ: 'I',
  ö: 'o',
  Ö: 'O',
  ş: 's',
  Ş: 'S',
  ü: 'u',
  Ü: 'U',
};

export function toHeaderSafeAscii(value: string): string {
  let out = '';
  for (const ch of value) {
    const mapped = TRANSLITERATION[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
