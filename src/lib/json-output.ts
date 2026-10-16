/**
 * `--json [dosya]` bayrağının çözümlenmesi ve rapor dosyası yazımı.
 *
 * Neden ayrı bir modül: `eval:classification` ve `llm:doctor` aynı bayrağı farklı
 * yorumluyordu — ikincisinde `--json` bir BAYRAKTI ve yanına yazılan dosya yolu
 * sessizce yok sayılıyordu. Canlı kanıt (16.10.2026, kullanıcının makinesi):
 * `npm run eval:classification -- --llm --json` hiçbir dosya yazmadı ve ekranda
 * uyarı çıkmadı; `npm run llm:doctor -- --json data\llm-doktor.json` ise dosya
 * yazmadı, JSON'u konsola bastı (kullanıcı raporun dosyaya gittiğini sandı).
 * Davranış artık iki komutta da aynı ve hiçbir durumda sessiz kalmıyor.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type JsonOutputArg =
  /** `--json` verilmedi. */
  | { mode: 'yok' }
  /** `--json` verildi ama dosya yolu YOK: çıktı standart çıktıya gider. */
  | { mode: 'stdout' }
  /** `--json <dosya>`: rapor bu dosyaya yazılır. */
  | { mode: 'dosya'; path: string };

/**
 * Bayrağın hemen ardındaki argüman bir bayrak (`-…`) veya boşsa yol sayılmaz;
 * böylece `--json --llm` yanlışlıkla `--llm` adlı bir dosyaya yazmaz.
 */
export function parseJsonOutputArg(argv: readonly string[], flag = '--json'): JsonOutputArg {
  const index = argv.indexOf(flag);
  if (index < 0) return { mode: 'yok' };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) return { mode: 'stdout' };
  return { mode: 'dosya', path: next };
}

export type JsonWriteResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * Raporu insan okunur biçimde (2 boşluk girinti + satır sonu) yazar.
 * Hata durumunda fırlatmaz: çağıran ekrana anlaşılır uyarı basar ve raporun
 * geri kalanı kaybolmaz. Mesaj dosya sistemi kaynaklıdır; anahtar içermez.
 */
export function writeJsonReport(path: string, data: unknown): JsonWriteResult {
  try {
    writeFileSync(resolve(path), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return { ok: true, path };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
