/**
 * `.env.example` üreteci. Tek doğru kaynak `env-spec.ts` (etiket, açıklama, seçenekler, koşul) +
 * gerçek Zod şeması (varsayılanlar). Dosya elle düzenlenmez: `npm run env:example`.
 *
 * Neden: elle bakılan 290 satırlık dosya şemadan ayrışıyor, varsayılanları yinelediği için
 * bayatlıyor ve yeni gelen biri için "neyi doldurmalıyım?" sorusunu yanıtlamıyordu.
 *
 * Kurallar:
 *  - Satır değeri boşsa şema varsayılanı uygulanır (`withoutBlankValues`); varsayılan yorumda yazar.
 *  - `cp .env.example .env` yerelde OLDUĞU GİBİ çalışır: yalnız yerel geliştirmeye özgü birkaç
 *    değer (DEV_VALUES) ve güvenli varsayılanı açıkça görünmesi gereken anahtarlar yazılır.
 *  - Sır alanlarına asla örnek değer yazılmaz.
 */
import { envSchemaDefaults } from './env';
import { ENV_FIELDS, ENV_GROUP_LABELS, ENV_GROUP_ORDER, type EnvFieldSpec } from './env-spec';

/** Yerel geliştirmede şema varsayılanından farklı olması gereken değerler. */
export const DEV_VALUES: Readonly<Record<string, string>> = {
  NODE_ENV: 'development',
  APP_BASE_URL: 'http://localhost:5173',
  DATABASE_DRIVER: 'file',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
};

/** Varsayılanı zaten güvenli olsa da kopyalayan kişinin GÖRMESİ gereken kapalı anahtarlar. */
export const EXPLICIT_SAFE_VALUES: Readonly<Record<string, string>> = {
  SCHEDULER_ENABLED: '0',
  SOURCE_LIVE_FETCH: '0',
  SOURCE_BROWSER_FALLBACK: '0',
  AI_ASSISTANT_ENABLED: '0',
  LLM_CLASSIFIER_ENABLED: '0',
};

/** Örnek satırı bile önerilmemesi gereken anahtarlar (yalnız açıklama yazılır). */
const NEVER_WRITE = new Set(['NODE_TLS_REJECT_UNAUTHORIZED']);

const WIDTH = 96;
const RULE = `# ${'═'.repeat(WIDTH - 2)}`;

function wrap(text: string, prefix: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (current && prefix.length + current.length + 1 + word.length > WIDTH) {
      lines.push(prefix + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(prefix + current);
  return lines;
}

function formatDefault(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function box(title: string): string[] {
  const inner = WIDTH - 4;
  return [`# ┌${'─'.repeat(inner)}┐`, `# │ ${title.padEnd(inner - 1)}│`, `# └${'─'.repeat(inner)}┘`];
}

function fieldBlock(field: EnvFieldSpec, defaults: Record<string, unknown>): string[] {
  const isSecret = field.secret === true || field.type === 'secret';
  const marks = [field.requiredInProduction || field.required ? '★ ÜRETİMDE ZORUNLU' : '', isSecret ? '◆ GİZLİ' : '']
    .filter(Boolean)
    .join(' · ');
  const lines = [`# ▸ ${field.label}${marks ? `   [${marks}]` : ''}`];
  lines.push(...wrap(field.help, '#     '));
  const facts: string[] = [];
  if (field.options?.length && !NEVER_WRITE.has(field.key)) facts.push(`Seçenekler: ${field.options.map((o) => (o === '' ? '(boş)' : o)).join(' | ')}`);
  if (!field.outsideSchema) {
    const fallback = formatDefault(defaults[field.key]);
    if (fallback.length > 70) facts.push('Varsayılan: kaynak tanımlarından (boş bırakın)');
    else if (fallback) facts.push(`Varsayılan: ${fallback}`);
  }
  if (field.example && !isSecret) facts.push(`Örnek: ${field.example}`);
  if (facts.length) lines.push(...wrap(facts.join(' · '), '#     '));
  if (field.skipReason) lines.push(...wrap(`Şu durumda gerekmez: ${field.skipReason}`, '#     '));
  if (field.docs) lines.push(`#     Ayrıntı: ${field.docs}`);
  if (NEVER_WRITE.has(field.key)) {
    lines.push('#     Bu anahtar için atama satırı bilerek YOK: yazmayın.');
  } else if (field.outsideSchema) {
    // Node'un kendi anahtarları: varsayılan olarak YAZILMAZ (yorum satırı).
    lines.push(`# ${field.key}=`);
  } else {
    const value = DEV_VALUES[field.key] ?? EXPLICIT_SAFE_VALUES[field.key] ?? '';
    lines.push(`${field.key}=${value}`);
  }
  return lines;
}

/** Üretimde mutlaka doldurulacaklar (şemadaki üretim denetimiyle aynı; test eşitliği denetler). */
export const PRODUCTION_MINIMUM: readonly (readonly [string, string])[] = [
  ['NODE_ENV', 'production'],
  ['APP_SECRET', 'en az 32 karakter rastgele (npm run env:setup üretir)'],
  ['APP_BASE_URL', 'sitenin tam adresi, ör. https://kamuilan.ornek.com.tr'],
  ['DATABASE_DRIVER', 'supabase  +  POSTGRES_URL (Supabase bağlantı dizesi)'],
  ['EMAIL_PROVIDER', 'resend + RESEND_API_KEY   ya da   smtp + SMTP_HOST'],
  ['EMAIL_FROM', 'doğrulanmış alan adından gönderici'],
  ['EMAIL_VERIFICATION_SECRET', 'en az 32 karakter rastgele'],
];

export function renderEnvExample(): string {
  const defaults = envSchemaDefaults() as unknown as Record<string, unknown>;
  const out: string[] = [
    RULE,
    '#  Kamuİlan — ortam ayarları',
    RULE,
    '#',
    '#  NASIL KULLANILIR',
    '#    1. Kopyalayın:      cp .env.example .env        (Windows PowerShell: Copy-Item .env.example .env)',
    '#    2. Yerel geliştirme için HİÇBİR ŞEYİ değiştirmeniz gerekmez:   npm run dev',
    '#    3. Üretim / sağlayıcı ayarları için soru-cevap sihirbazı:      npm run env:setup',
    '#    4. Denetleyin (eksik ya da hatalı ayarı Türkçe açıklar):       npm run env:check',
    '#',
    '#  OKUMA KILAVUZU',
    '#    ★ ÜRETİMDE ZORUNLU   canlıya çıkarken doldurulmalı (yerelde boş kalabilir)',
    '#    ◆ GİZLİ             parola/anahtar: yalnız .env\'e yazın, kimseyle paylaşmayın',
    '#    Boş bırakılan satır "Varsayılan" değerini kullanır.',
    '#',
    '#  ÜRETİM İÇİN EN AZ BUNLAR  (ayrıntı: docs/deployment.md)',
    ...PRODUCTION_MINIMUM.map(([key, hint]) => `#    ${key.padEnd(27)} ${hint}`),
    '#',
    '#  Bu dosya src/config/env-spec.ts\'ten üretilir; elle düzenlemeyin:  npm run env:example',
    RULE,
  ];
  ENV_GROUP_ORDER.forEach((group, index) => {
    const fields = ENV_FIELDS.filter((field) => field.group === group);
    if (fields.length === 0) return;
    out.push('', '', ...box(`${index + 1}. ${ENV_GROUP_LABELS[group].toLocaleUpperCase('tr')}`));
    for (const field of fields) out.push('', ...fieldBlock(field, defaults));
  });
  return `${out.join('\n')}\n`;
}
