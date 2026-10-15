/**
 * `env:setup` sihirbazının saf karar mantığı (girdi/çıktı, ekran yok).
 *
 * Neden ayrı: etkileşimli betik (readline, gizli giriş, TTY denetimi) test
 * edilemez; plan üretimi ve cevap işleme burada saf fonksiyonlardır ve
 * `tests/env-setup.test.ts` bunları gerçek değerlerle doğrular.
 *
 * Kural: sihirbaz YALNIZCA kullanıcının verdiği ya da onayladığı değeri yazar.
 * Uydurma sır üretmez (APP_SECRET için yalnızca üretim komutunu ÖNERİR),
 * doğrulamayı gevşetmez ve `no-verify` gibi riskli değerleri onaylamadan yazmaz.
 */
import {
  ENV_FIELDS,
  ENV_FIELD_BY_KEY,
  ENV_GROUP_LABELS,
  ENV_GROUP_ORDER,
  isFieldApplicable,
  isFieldRequired,
  maskValue,
  validateFieldValue,
  type EnvFieldSpec,
  type EnvGroup,
} from './env-spec';

/** Sihirbazın hangi alanları soracağı (`--only`/`--all` süzgeci sonrası). */
export type PromptScope = 'required-first' | 'all' | 'missing';

export interface PromptPlanStep {
  field: EnvFieldSpec;
  group: EnvGroup;
  /** Dosyada/ortamda bulunan mevcut değer (yoksa boş). */
  current: string;
  required: boolean;
  applicable: boolean;
  skipReason?: string;
}

export interface PromptPlan {
  steps: PromptPlanStep[];
  /** Bağımlılığı sağlanmadığı için atlanan alanlar (görünürlük için listelenir). */
  skipped: PromptPlanStep[];
  groups: { group: EnvGroup; label: string; steps: PromptPlanStep[] }[];
}

export interface PlanOptions {
  scope?: PromptScope;
  /** Göreli yol alanları bu köke göre denetlenir (hedef `.env` dosyasının dizini). */
  pathRoot?: string;
  /** Yalnızca bu anahtarlar sorulsun. */
  only?: string[];
  /** Bu gruplar sorulsun. */
  groups?: EnvGroup[];
  /**
   * Kapsamdan BAĞIMSIZ olarak sorulacak anahtarlar.
   *
   * Kullanım: süreç ortamı dosyadaki değeri gölgelediğinde (Windows'ta `setx`,
   * PowerShell `$env:`) kullanıcıya "hangi değer kazanıyor" sorusunu sormak
   * gerekir; aksi halde dosyaya yazılan değer hiç devreye girmez.
   */
  attention?: string[];
}

/**
 * Sorulacak alanları belirler.
 *
 * `required-first` (varsayılan): zorunlu + şu an eksik/geçersiz alanlar sorulur;
 * dolu ve geçerli olanlar atlanır (kullanıcı `--all` ile hepsini görebilir).
 */
export function buildPromptPlan(
  values: Record<string, string>,
  options: PlanOptions = {},
): PromptPlan {
  const scope = options.scope ?? 'required-first';
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const groups = options.groups && options.groups.length > 0 ? new Set(options.groups) : null;
  const attention = options.attention && options.attention.length > 0 ? new Set(options.attention) : null;

  const steps: PromptPlanStep[] = [];
  const skipped: PromptPlanStep[] = [];

  for (const field of ENV_FIELDS) {
    if (only && !only.has(field.key)) continue;
    if (groups && !groups.has(field.group)) continue;
    if (!isFieldApplicable(field, values)) {
      skipped.push({ field, group: field.group, current: values[field.key] ?? '', required: false, applicable: false, skipReason: field.skipReason });
      continue;
    }
    const current = values[field.key] ?? '';
    const required = isFieldRequired(field, values);
    const validation = validateFieldValue(field, current, values, { pathRoot: options.pathRoot });
    // `required-first` (varsayılan) yalnızca DOLDURULMASI GEREKEN alanları sorar:
    // zorunlu ama boş ya da dolu ama geçersiz. İsteğe bağlı boş alanlar sorulmaz;
    // hepsini görmek için `--all` ya da `--check` kullanılır. Aksi halde sihirbaz
    // 40 isteğe bağlı alanı sorar ve asıl eksik (ör. LLM_API_KEY) gürültüde kaybolur.
    const needsQuestion =
      scope === 'all' ||
      (attention?.has(field.key) ?? false) ||
      (scope === 'missing' ? current === '' : (required && current === '') || !validation.ok);
    if (!needsQuestion) continue;
    steps.push({ field, group: field.group, current, required, applicable: true });
  }

  const grouped = ENV_GROUP_ORDER.map((group) => ({
    group,
    label: ENV_GROUP_LABELS[group],
    steps: steps.filter((step) => step.group === group),
  })).filter((entry) => entry.steps.length > 0);

  return { steps, skipped, groups: grouped };
}

/** Bilinmeyen anahtar adlarını ayıklar (yazım hatası erken yakalanır). */
export function unknownKeys(keys: string[]): string[] {
  return keys.filter((key) => !ENV_FIELD_BY_KEY.has(key));
}

export interface AnswerResult {
  /** Yazılacak değer (boş dizgi = anahtar temizlenir/varsayılana döner). */
  value: string;
  ok: boolean;
  message: string | null;
  /** Kullanıcı soruyu atladı: mevcut değer korunur. */
  skipped: boolean;
}

/** Sihirbaz komutları: akışı yöneten özel girdiler. */
export const PROMPT_COMMANDS = {
  skip: ':skip',
  help: ':help',
  clear: ':clear',
  quit: ':quit',
  back: ':back',
} as const;

export type PromptCommand = (typeof PROMPT_COMMANDS)[keyof typeof PROMPT_COMMANDS];

/** Girdi bir sihirbaz komutu mu? */
export function asPromptCommand(input: string): PromptCommand | null {
  const trimmed = input.trim().toLowerCase();
  const found = Object.values(PROMPT_COMMANDS).find((command) => command === trimmed);
  return found ?? null;
}

/**
 * Kullanıcı cevabını işler: komutlar, boş girdi (mevcudu koru), tür denetimi.
 *
 * Boş cevap:
 *  - mevcut değer varsa → korunur (skipped)
 *  - mevcut değer yoksa ve alanın varsayılanı varsa → varsayılan yazılır
 *  - zorunlu alan boş bırakılamaz → hata, yeniden sorulur
 */
export function processAnswer(
  step: PromptPlanStep,
  input: string,
  values: Record<string, string>,
  options: { pathRoot?: string } = {},
): AnswerResult {
  const command = asPromptCommand(input);
  if (command === PROMPT_COMMANDS.skip || command === PROMPT_COMMANDS.quit || command === PROMPT_COMMANDS.back) {
    return { value: step.current, ok: true, message: null, skipped: true };
  }
  if (command === PROMPT_COMMANDS.help) {
    return { value: step.current, ok: false, message: step.field.help, skipped: true };
  }

  const trimmed = input.trim();

  // Zorunluluk BAĞLAMA bağlıdır (ör. POSTGRES_URL yalnızca postgres/Supabase
  // sürücüsünde zorunlu); bu yüzden adımın plan anındaki bayrağı yerine mevcut
  // değerlerle yeniden hesaplanır.
  const requiredNow = step.required || isFieldRequired(step.field, values);

  if (command === PROMPT_COMMANDS.clear) {
    if (requiredNow) {
      return { value: step.current, ok: false, message: `${step.field.key} zorunlu; boş bırakılamaz.`, skipped: false };
    }
    return { value: '', ok: true, message: `${step.field.key} temizlendi.`, skipped: false };
  }

  if (trimmed === '') {
    // Boş Enter: mevcut değer korunur; yoksa varsayılan denenir.
    if (step.current !== '') {
      return { value: step.current, ok: true, message: null, skipped: true };
    }
    if (step.field.defaultValue !== undefined) {
      const validation = validateFieldValue(step.field, step.field.defaultValue, values, options);
      if (!validation.ok) return { value: '', ok: false, message: validation.message, skipped: false };
      return { value: step.field.defaultValue, ok: true, message: null, skipped: false };
    }
    if (requiredNow) {
      return { value: '', ok: false, message: `${step.field.key} zorunlu; bir değer girin.`, skipped: false };
    }
    return { value: '', ok: true, message: null, skipped: true };
  }

  // "!" öneki AÇIK RİSK KABULÜDÜR: doğrulamayı kapatan ya da zayıf kalan
  // değerler sessizce yazılmaz, ikinci kez ve bilinçli olarak onaylanır.
  const forced = trimmed.startsWith('!');
  const candidate = forced ? trimmed.slice(1).trim() : trimmed;

  const validation = validateFieldValue(step.field, candidate, values, options);
  if (!validation.ok) return { value: step.current, ok: false, message: validation.message, skipped: false };

  const risky = riskyDecision(step.field, candidate);
  if (risky && !forced) {
    return { value: step.current, ok: false, message: `${risky} Yine de yazmak için başına "!" koyun: !${candidate}`, skipped: false };
  }

  return {
    value: candidate,
    ok: true,
    message: risky ? 'Risk açıkça kabul edildi ve yazılıyor.' : null,
    skipped: false,
  };
}

/**
 * Kullanıcının ek onayı olmadan YAZILMAYACAK riskli kararlar.
 *
 * Amaç yasaklamak değil, sessiz onayı engellemektir: bu değerler MITM riski
 * ya da zayıf kimlik bilgisi anlamına gelir ve üretimde `env:check` tarafından
 * zaten engellenir.
 */
export function riskyDecision(field: EnvFieldSpec, value: string): string | null {
  if (field.key === 'POSTGRES_SSL_MODE' && (value === 'no-verify' || value === 'disable')) {
    return `POSTGRES_SSL_MODE=${value} veritabanı TLS doğrulamasını/şifrelemesini KAPATIR: ağ üzerindeki biri bağlantı dizesini ve verileri okuyabilir.`;
  }
  if (field.key === 'POSTGRES_SSL' && (value === '0' || value.toLowerCase() === 'false')) {
    return 'POSTGRES_SSL=0 veritabanı trafiğini ŞİFRELEMEZ.';
  }
  if (field.key === 'APP_SECRET' && value.length < 32) {
    return 'APP_SECRET 32 karakterden kısa: oturum imzası kaba kuvvetle tahmin edilebilir.';
  }
  if (field.key === 'ADMIN_PASSWORD' && value.length < 12) {
    return 'ADMIN_PASSWORD 12 karakterden kısa: yönetici hesabı kolayca ele geçirilebilir.';
  }
  if (field.key === 'NODE_ENV' && value === 'test') {
    return 'NODE_ENV=test .env dosyasının yüklenmesini engeller ve uygulamayı test kipine alır.';
  }
  return null;
}

/**
 * Toplanan değerlerden dosyaya yazılacak küme.
 *
 * Yalnızca DEĞİŞEN anahtarlar yazılır; aynı değeri yeniden yazmak dosyayı
 * gereksiz yere değiştirir (ve yedek üretir).
 */
export function buildValuesToWrite(
  collected: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [key, value] of Object.entries(collected)) {
    if ((current[key] ?? '') !== value) changed[key] = value;
  }
  return changed;
}

/** Sihirbazın son özet satırları (maskeli; sır düz metin yazdırılmaz). */
export function buildChangeSummary(
  collected: Record<string, string>,
  current: Record<string, string>,
): { changed: string[]; unchanged: string[]; cleared: string[] } {
  const changed: string[] = [];
  const cleared: string[] = [];
  const unchanged: string[] = [];
  for (const [key, value] of Object.entries(collected)) {
    const field = ENV_FIELD_BY_KEY.get(key);
    const before = current[key] ?? '';
    if (before === value) {
      unchanged.push(key);
      continue;
    }
    if (value === '') cleared.push(key);
    else if (!field) changed.push(`${key}=${value}`);
    else if (before === '') changed.push(`${key}=${maskValue(field, value)}`);
    else changed.push(`${key}: ${maskValue(field, before)} → ${maskValue(field, value)}`);
  }
  return { changed, unchanged, cleared };
}

/** `--check` çıktısı: alan alan mevcut durum (maskeli) + sorunlar. */
export function buildFieldStatus(values: Record<string, string>, options: { pathRoot?: string } = {}): {
  groups: { group: EnvGroup; label: string; rows: string[] }[];
  problems: string[];
} {
  const problems: string[] = [];
  const groups = ENV_GROUP_ORDER.map((group) => {
    const rows: string[] = [];
    for (const field of ENV_FIELDS.filter((entry) => entry.group === group)) {
      if (!isFieldApplicable(field, values)) continue;
      const value = values[field.key] ?? '';
      const required = isFieldRequired(field, values);
      const validation = validateFieldValue(field, value, values, options);
      if (!validation.ok) problems.push(`${field.key}: ${validation.message ?? 'geçersiz değer'}`);
      if (required && !value) problems.push(`${field.key}: zorunlu ama boş.`);
      const state = value === '' ? (required ? 'EKSİK (zorunlu)' : 'boş (isteğe bağlı)') : validation.ok ? 'tamam' : 'GEÇERSİZ';
      rows.push(`${field.key.padEnd(32)} ${maskValue(field, value).padEnd(24)} ${state}`);
    }
    return { group, label: ENV_GROUP_LABELS[group], rows };
  }).filter((entry) => entry.rows.length > 0);
  return { groups, problems };
}
