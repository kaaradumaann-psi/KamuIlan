/**
 * Tasarım sistemi koruma testi.
 *
 * Kamuİlan'ın arayüzü psikolog ve MMPI çalışma alanlarıyla aynı tasarım
 * katmanlarını kullanır. Bu dosya o sözleşmeyi otomatik olarak denetler:
 *
 *  1. **Katman sırası** — `src/main.tsx` içindeki stil içe aktarma sırası
 *     referans uygulamalarla aynıdır (responsive.css her zaman en sonda).
 *  2. **Paylaşılan katmanlar** — `screen.css`, `site.css`, `coherence.css`,
 *     `theme.css`, `workspace.css`, `dashboard.css`, `mobile.css`,
 *     `responsive.css` ve `auth.css` psikolog reposuyla bayt bayt aynıdır.
 *     Karma değerler `tests/fixtures/design-parity.json` içinde tutulur;
 *     dosya değişirse test bilinçli bir güncelleme ister.
 *  3. **Tanımsız sınıf yasak** — arayüzde kullanılan her sınıf
 *     `src/styles/*.css` içinde tanımlı olmalıdır (yazım hatasıyla sessizce
 *     biçimsiz kalan öğe bırakmaz).
 *  4. **Yardımcı (utility) sınıf yasak** — aile dili yardımcı sınıf üretimi
 *     kullanmaz (`flex`, `gap-2`, `text-sm`, `sm:col-span-2`, `dark:*` gibi).
 *     Her sınıf anlam taşır: `.action-row`, `.summary-list`, `.cell-note`.
 *
 * Test ağ erişimi yapmaz; yalnızca depodaki dosyaları okur.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const STYLES_DIR = join(ROOT, 'src/styles');
const SRC_DIR = join(ROOT, 'src');

/** Referans uygulamalarla bayt bayt paylaşılan katmanlar (sıra önemli değil). */
const SHARED_LAYERS = [
  'screen.css',
  'site.css',
  'coherence.css',
  'theme.css',
  'workspace.css',
  'dashboard.css',
  'mobile.css',
  'responsive.css',
  'auth.css',
] as const;

/** `src/main.tsx` içinde beklenen içe aktarma sırası. */
const EXPECTED_IMPORT_ORDER = [
  'screen.css',
  'auth.css',
  'dashboard.css',
  'site.css',
  'mobile.css',
  'theme.css',
  'coherence.css',
  'workspace.css',
  'kamuilan.css',
  'responsive.css',
] as const;

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** CSS dosyalarında tanımlı tüm sınıf adları. */
function definedClasses(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(join(STYLES_DIR, file), 'utf8');
    for (const match of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
      found.add(match[1] ?? '');
    }
  }
  return found;
}

/** Bir ifadenin içindeki dize değişmezlerini döndürür (template dahil). */
function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  const patterns = [/'([^'\n]*)'/g, /"([^"\n]*)"/g, /`([^`]*)`/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) literals.push(match[1] ?? '');
  }
  return literals;
}

/**
 * JSX/TS içindeki `className` değerlerinden sınıf adaylarını çıkarır.
 *
 * `className="a b"`, `className={'a b'}` ve
 * `` className={`a ${flag ? 'b' : 'c'}`} `` biçimlerini destekler.
 */
function usedClasses(): { token: string; file: string }[] {
  const results: { token: string; file: string }[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.(tsx|ts)$/.test(entry.name) ? [full] : [];
    });

  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    // className="..." ve className={...} (içe içe süslü parantezler dahil).
    for (const match of source.matchAll(/className=(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|'[^']*')/g)) {
      // `view === 'preferences'` gibi karşılaştırma işlenenleri sınıf değildir.
      const raw = (match[1] ?? '').replace(/===?\s*(['"`])[^'"`]*\1/g, '==');
      for (const literal of stringLiterals(raw)) {
        for (const token of literal.split(/\s+/)) {
          const cleaned = token.replace(/\$\{[^}]*\}/g, '').trim();
          if (cleaned.length > 0) results.push({ token: cleaned, file });
        }
      }
    }
  }
  return results;
}

/**
 * Yardımcı sınıf kalıpları.
 *
 * Aile dili (psikolog/MMPI) bu kalıpların hiçbirini kullanmaz; Kamuİlan'da da
 * kullanılmamalıdır. Her eşleşme, anlamlı bir bileşen sınıfına çevrilmelidir.
 */
const UTILITY_PATTERNS: { pattern: RegExp; hint: string }[] = [
  { pattern: /^(flex|grid|block|inline|inline-flex|inline-block|hidden)$/, hint: 'görünüm yardımcısı' },
  { pattern: /^(flex-col|flex-row|flex-wrap|flex-1|flex-none)$/, hint: 'esneklik yardımcısı' },
  {
    pattern: /^(items|justify|self|content|place)-(start|end|center|between|around|evenly|stretch|baseline)$/,
    hint: 'hizalama yardımcısı',
  },
  { pattern: /^(gap|gap-x|gap-y)-\d+$/, hint: 'boşluk yardımcısı' },
  { pattern: /^(mt|mb|ml|mr|mx|my|pt|pb|pl|pr|px|py|p|m)(-\d+)?$/, hint: 'kenar boşluğu yardımcısı' },
  { pattern: /^(space-(x|y))-\d+$/, hint: 'yığın yardımcısı' },
  { pattern: /^(w|h|min-w|min-h|max-w|max-h)-/, hint: 'boyut yardımcısı' },
  { pattern: /^text-(xs|sm|base|lg|xl|2xl|3xl)$/, hint: 'tipografi yardımcısı' },
  { pattern: /^font-(medium|semibold|bold|normal|light)$/, hint: 'tipografi yardımcısı' },
  { pattern: /^(rounded|border)(-|$)/, hint: 'kenarlık yardımcısı' },
  { pattern: /^grid-cols-\d+$/, hint: 'ızgara yardımcısı' },
  { pattern: /^col-span-\d+$/, hint: 'ızgara yardımcısı' },
  { pattern: /^bg-(white|slate|red|amber|green|blue)-\d{2,3}$/, hint: 'renk yardımcısı' },
  { pattern: /^text-(slate|red|amber|green|blue|white)-\d{2,3}$/, hint: 'renk yardımcısı' },
  {
    pattern: /^(uppercase|lowercase|capitalize|tracking-wide|truncate|overflow-x-auto|overflow-hidden)$/,
    hint: 'biçim yardımcısı',
  },
  {
    pattern: /^(list-decimal|list-disc|list-none|break-all|whitespace-nowrap|relative|absolute|sticky)$/,
    hint: 'biçim yardımcısı',
  },
];

/** Dinamik ön ekler: `tag-${tone}` gibi birleşimlerde kalan parça. */
function isKnownPrefix(token: string, defined: Set<string>): boolean {
  if (!token.endsWith('-')) return false;
  for (const candidate of defined) if (candidate.startsWith(token)) return true;
  return false;
}

describe('tasarım sistemi sözleşmesi', () => {
  it('stil katmanları referans uygulamalarla aynı sıradadır', () => {
    const main = readFileSync(join(SRC_DIR, 'main.tsx'), 'utf8');
    const imported = [...main.matchAll(/import\s+'.\/styles\/([\w.-]+\.css)';/g)].map(
      (match) => match[1] ?? '',
    );
    expect(imported).toEqual([...EXPECTED_IMPORT_ORDER]);
  });

  it('paylaşılan katmanlar psikolog reposuyla bayt bayt aynıdır', () => {
    const parity = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/design-parity.json'), 'utf8')) as {
      sharedLayers: Record<string, string>;
    };
    for (const layer of SHARED_LAYERS) {
      const expected = parity.sharedLayers[layer];
      expect(expected, `design-parity.json içinde ${layer} için karma değer yok`).toBeTruthy();
      expect(sha256(readFileSync(join(STYLES_DIR, layer), 'utf8')), `${layer} değişmiş`).toBe(expected);
    }
  });

  it('arama ikonu alanı ve spinner sarmalayıcısı ortak CSS katmanını doğru ezer', () => {
    const appCss = readFileSync(join(STYLES_DIR, 'kamuilan.css'), 'utf8');
    const sharedInputSelector = ".form-group input:not([type='checkbox']):not([type='radio'])";
    const iconInputSelector = ".form-group .search-input-wrap > input[type='search']";
    const sharedInputIndex = appCss.indexOf(sharedInputSelector);
    const iconInputIndex = appCss.indexOf(iconInputSelector);
    expect(sharedInputIndex).toBeGreaterThanOrEqual(0);
    expect(iconInputIndex).toBeGreaterThan(sharedInputIndex);
    expect(appCss.slice(iconInputIndex, appCss.indexOf('}', iconInputIndex))).toContain('padding-left: 38px');

    expect(appCss).toMatch(/\.spinner-inline\s*\{[^}]*display:\s*inline-flex;[^}]*border:\s*0;[^}]*animation:\s*none;/s);
    expect(appCss).toMatch(/\.spinner-inline \.spinner\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s);
  });

  it('arayüzde tanımsız sınıf kullanılmaz', () => {
    const defined = definedClasses();
    const unknown = usedClasses().filter(
      ({ token }) => /^[a-zA-Z][\w-]*$/.test(token) && !defined.has(token) && !isKnownPrefix(token, defined),
    );
    expect(unknown.map(({ token, file }) => `${token} (${file.replace(ROOT, '.')})`)).toEqual([]);
  });

  it('yardımcı (utility) sınıf kullanılmaz', () => {
    const offenders = usedClasses()
      .filter(({ token }) => UTILITY_PATTERNS.some(({ pattern }) => pattern.test(token)))
      .map(({ token, file }) => `${token} — ${file.replace(ROOT, '.')}`);
    expect(offenders).toEqual([]);
  });

  it('duyarlı katman her zaman en son içe aktarılır', () => {
    const main = readFileSync(join(SRC_DIR, 'main.tsx'), 'utf8');
    const imported = [...main.matchAll(/import\s+'.\/styles\/([\w.-]+\.css)';/g)].map(
      (match) => match[1] ?? '',
    );
    expect(imported[imported.length - 1]).toBe('responsive.css');
  });
});
