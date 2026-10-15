/**
 * LLM kapısı tanısı: `npm run llm:doctor`
 *
 * Neden var: inceleme kuyruğundaki kayıtlarda "LLM doğrulaması yapılamadı
 * (sağlayıcı hatası)" ve panelde "%100 hata oranı · 0 token" göründüğünde,
 * sorunun ANAHTAR mı, UÇ NOKTA mı, MODEL ADI mı yoksa KOTA mı olduğu
 * panelden anlaşılamıyordu (2026-10-16: `gemini-2.5-flash` + Google yerel kökü
 * → her çağrı HTTP 404). Bu betik aynı yapılandırmayla TEK bir gerçek çağrı
 * yapar ve sonucu insan okunur adımlarla raporlar.
 *
 * Kullanım:
 *   npm run llm:doctor                → yapılandırma + tek canlı çağrı
 *   npm run llm:doctor -- --offline   → yalnızca yapılandırma denetimi (ağ yok)
 *   npm run llm:doctor -- --json      → makine okunur çıktı
 *
 * Güvenlik: API anahtarı hiçbir biçimde yazdırılmaz (yalnızca uzunluğu).
 * Ham istem/yanıt gövdesi loglanmaz. Veritabanına yazmaz.
 */
import { getEnv, inspectEnvironment } from '../src/config/env';
import {
  callChatCompletion,
  describeLlmEndpointRisk,
  describeTransport,
  resolveLlmEndpoint,
  type LlmTransport,
} from '../src/ai/llm';
import { llmClassifierConfig } from '../src/ai/classifier';
import type { LlmConfig } from '../src/ai/llm';

const HELP = `LLM kapısı tanısı

Kullanım:
  npm run llm:doctor                yapılandırma + tek canlı çağrı (taşıyıcı otomatik seçilir)
  npm run llm:doctor -- --offline   yalnızca yapılandırma (ağ çağrısı yok)
  npm run llm:doctor -- --compat    Google kökünde OpenAI uyumlu ucu DENE (karşılaştırma için)
  npm run llm:doctor -- --native    taşıyıcıyı Gemini yerel API'sine zorla
  npm run llm:doctor -- --json      makine okunur çıktı
  npm run llm:doctor -- --help      bu yardım

Taşıyıcılar:
  gemini-native  POST {kök}/models/{model}:generateContent  (Google AI birincil API'si)
  openai-compat  POST {kök}/chat/completions                (OpenAI, OpenRouter, Groq, Ollama …)`;

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** Anahtarın kendisini değil yalnızca varlığını/uzunluğunu raporlar. */
function describeSecret(value: string): string {
  return value ? `tanımlı (uzunluk ${value.length})` : 'BOŞ';
}

interface DoctorReport {
  classifierEnabled: boolean;
  assistantEnabled: boolean;
  model: string | null;
  baseUrl: string | null;
  transport: LlmTransport | null;
  endpoint: string | null;
  endpointRisk: string | null;
  timeoutMs: number;
  maxCallsPerRun: number;
  dailyCallLimit: number;
  costConfigured: boolean;
  warnings: string[];
  call: { attempted: boolean; ok: boolean; status: number | null; elapsedMs: number; detail: string } | null;
  /** Yalnızca çağrı başarısızken doldurulur: model mi uç mu sorunlu ayırt etmek için. */
  modelList: { ok: boolean; status: number | null; count: number; configuredModelListed: boolean; detail: string } | null;
}

/**
 * Sağlayıcının MODEL LİSTESİ ucunu dener.
 *
 * Neden: "model listede var ama sohbet ucu 404" ile "model adı yanlış" aynı
 * HTTP 404'ü üretir; ayırt etmenin tek yolu liste ucunu ayrıca denemektir.
 * Liste ucu çalışıp sohbet ucu çalışmıyorsa sorun modelde değil, UCUN
 * biçimindedir (taşıyıcı değiştirilir). Anahtar yalnızca başlıkta gider.
 */
async function probeModelList(config: LlmConfig, transport: LlmTransport): Promise<{
  ok: boolean;
  status: number | null;
  models: string[];
  detail: string;
}> {
  // Liste ucu, sohbet ucuyla AYNI yol mantığından türetilir (sürüm öneki,
  // /openai kabuğu): böylece iki uç aynı kökü paylaşır ve karşılaştırma anlamlı olur.
  const endpoint = resolveLlmEndpoint(config, { transport });
  const url =
    transport === 'gemini-native'
      ? `${endpoint.url.slice(0, Math.max(0, endpoint.url.indexOf('/models/')))}/models?pageSize=200`
      : endpoint.url.replace(/\/chat\/completions$/, '/models');
  const headers: Record<string, string> =
    transport === 'gemini-native'
      ? { 'x-goog-api-key': config.apiKey }
      : { authorization: `Bearer ${config.apiKey}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 15_000));
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const raw = (await response.text()).slice(0, 200_000);
    if (!response.ok) {
      return { ok: false, status: response.status, models: [], detail: raw.slice(0, 200).replace(/\s+/g, ' ') };
    }
    const parsed = JSON.parse(raw) as { models?: unknown[]; data?: unknown[] };
    const entries = (parsed.models ?? parsed.data ?? []) as { name?: unknown; id?: unknown }[];
    const models = entries
      .map((entry) => String(entry?.name ?? entry?.id ?? '').replace(/^models\//, ''))
      .filter((name) => name.length > 0);
    return { ok: true, status: response.status, models, detail: `${models.length} model listelendi` };
  } catch (error) {
    return {
      ok: false,
      status: null,
      models: [],
      detail: controller.signal.aborted ? 'zaman aşımı' : String(error instanceof Error ? error.message : error).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP);
    return;
  }
  const offline = hasFlag('--offline');
  const asJson = hasFlag('--json');
  // --compat / --native: aynı anahtar ve modelle iki taşıyıcıyı karşılaştırmak için.
  // Google'ın OpenAI uyumluluk kabuğu her anahtar/bölge/model için chat/completions
  // sunmuyor (2026-10-16: /openai/models 200, /openai/chat/completions 404).
  const forcedTransport: LlmTransport | undefined = hasFlag('--compat')
    ? 'openai-compat'
    : hasFlag('--native')
      ? 'gemini-native'
      : undefined;

  const env = getEnv();
  const inspection = inspectEnvironment(env);
  const classifierConfig = llmClassifierConfig(env);
  const assistantConfig: LlmConfig | null =
    env.AI_ASSISTANT_ENABLED && env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL.trim()
      ? {
          baseUrl: env.LLM_BASE_URL,
          apiKey: env.LLM_API_KEY,
          model: env.LLM_MODEL.trim(),
          timeoutMs: env.LLM_TIMEOUT_MS,
        }
      : null;
  const config = classifierConfig ?? assistantConfig;
  const model = config?.model ?? null;
  const baseUrl = config?.baseUrl ?? env.LLM_BASE_URL ?? null;
  const endpointRisk = baseUrl && model ? describeLlmEndpointRisk(baseUrl, model) : null;
  // `endpointRisk` ayrıca yazdırılır; env denetiminden gelen aynı metin tekrarlanmaz.
  const llmWarnings = inspection.warnings.filter(
    (warning) =>
      (warning.includes('LLM_') || warning.includes('AI_ASSISTANT')) &&
      !(endpointRisk !== null && warning.startsWith(endpointRisk)),
  );

  const endpoint = baseUrl ? resolveLlmEndpoint({ baseUrl, model: model ?? '' }, forcedTransport ? { transport: forcedTransport } : {}) : null;
  const report: DoctorReport = {
    classifierEnabled: env.LLM_CLASSIFIER_ENABLED,
    assistantEnabled: env.AI_ASSISTANT_ENABLED,
    model,
    baseUrl,
    transport: endpoint?.transport ?? null,
    endpoint: endpoint?.url ?? null,
    endpointRisk,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxCallsPerRun: env.LLM_MAX_CALLS_PER_RUN,
    dailyCallLimit: env.LLM_DAILY_CALL_LIMIT,
    costConfigured: Boolean(env.LLM_COST_USD_PER_MTOK_INPUT || env.LLM_COST_USD_PER_MTOK_OUTPUT),
    warnings: llmWarnings,
    call: null,
    modelList: null,
  };

  if (config && !offline) {
    const started = Date.now();
    const result = await callChatCompletion(
      config,
      [
        { role: 'system', content: 'Bağlantı denetimi. Yanıt olarak yalnızca tek bir Türkçe sözcük yaz.' },
        { role: 'user', content: 'hazır' },
      ],
      { maxTokens: 8, temperature: 0, ...(forcedTransport ? { transport: forcedTransport } : {}) },
    );
    const elapsedMs = Date.now() - started;
    report.call = result.ok
      ? {
          attempted: true,
          ok: true,
          status: result.status,
          elapsedMs,
          detail: `yanıt alındı (${result.usage.promptTokens ?? '?'} girdi / ${result.usage.completionTokens ?? '?'} çıktı token)`,
        }
      : { attempted: true, ok: false, status: result.status, elapsedMs, detail: result.reason };
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('LLM kapısı tanısı (llm:doctor)');
    console.log(`  Sınıflandırma kapısı : ${env.LLM_CLASSIFIER_ENABLED ? 'açık' : 'kapalı'} (LLM_CLASSIFIER_ENABLED)`);
    console.log(`  Panel öneri asistanı : ${env.AI_ASSISTANT_ENABLED ? 'açık' : 'kapalı'} (AI_ASSISTANT_ENABLED)`);
    console.log(`  Model                : ${model ?? '(tanımsız)'}${env.LLM_CLASSIFIER_MODEL.trim() ? ' — LLM_CLASSIFIER_MODEL' : ' — LLM_MODEL'}`);
    console.log(`  Sağlayıcı kökü       : ${baseUrl ?? '(tanımsız)'} (LLM_BASE_URL)`);
    console.log(`  Taşıyıcı             : ${report.transport ? describeTransport(report.transport) : '(hesaplanamadı)'}${forcedTransport ? ' — bayrakla zorlandı' : ' — kök adrese göre otomatik seçildi'}`);
    console.log(`  İstek ucu            : ${report.endpoint ?? '(hesaplanamadı)'}`);
    console.log(`  İstek modeli         : ${endpoint?.model || '(boş)'} · anahtar başlığı: ${endpoint?.authHeader === 'x-goog-api-key' ? 'x-goog-api-key' : 'Authorization: Bearer'}`);
    console.log(`  API anahtarı         : ${describeSecret(env.LLM_API_KEY)}`);
    console.log(`  Zaman aşımı          : ${env.LLM_TIMEOUT_MS} ms · koşu başına ${env.LLM_MAX_CALLS_PER_RUN} çağrı · günlük ${env.LLM_DAILY_CALL_LIMIT} çağrı`);
    console.log(`  Maliyet ayarı        : ${report.costConfigured ? 'tanımlı' : 'BOŞ (panelde maliyet "raporlanmadı" görünür)'}`);
    if (endpointRisk) console.log(`\n  ⚠ ${endpointRisk}`);
    for (const warning of llmWarnings) console.log(`  ⚠ ${warning}`);

    if (!config) {
      console.log('\n✖ Kapı yapılandırılmamış: LLM_BASE_URL + LLM_API_KEY + model (LLM_MODEL ya da LLM_CLASSIFIER_MODEL) gerekli.');
      console.log('  Adım adım doldurmak için: npm run env:setup');
      process.exitCode = 1;
    } else if (offline) {
      console.log('\n• --offline: canlı çağrı yapılmadı (yapılandırma denetlendi).');
      console.log(endpointRisk ? '✖ Uç nokta/model uyuşmazlığı giderilmeden canlı çağrı başarısız olur.' : '✓ Yapılandırma tutarlı görünüyor; canlı deneme için --offline bayrağını kaldırın.');
      if (endpointRisk) process.exitCode = 1;
    } else if (report.call?.ok) {
      console.log(`\n✓ Canlı çağrı başarılı: HTTP ${report.call.status}, ${report.call.elapsedMs} ms — ${report.call.detail}`);
      console.log('  Kapı çalışıyor: inceleme kuyruğundaki kayıtlar bir sonraki taramada model denetiminden geçer.');
      if (!report.costConfigured) {
        console.log('  Not: LLM_COST_USD_PER_MTOK_INPUT/OUTPUT boş olduğu için panelde maliyet raporlanmaz.');
      }
    } else {
      console.log(`\n✖ Canlı çağrı başarısız${report.call?.status ? ` (HTTP ${report.call.status})` : ''}: ${report.call?.detail ?? 'çağrı yapılmadı'}`);

      // Kök nedeni ayır: model mi yoksa uç/biçim mi? Liste ucu çalışıyorsa anahtar
      // ve model geçerlidir; sorun sohbet ucunun kendisindedir.
      const activeTransport: LlmTransport = report.transport ?? 'openai-compat';
      const list = await probeModelList(config, activeTransport);
      const normalizedModel = (model ?? '').trim().replace(/^models\//, '');
      const listed = list.models.some((name) => name.toLowerCase() === normalizedModel.toLowerCase());
      report.modelList = { ok: list.ok, status: list.status, count: list.models.length, configuredModelListed: listed, detail: list.detail };
      console.log(`\n  Model listesi denetimi (${activeTransport === 'gemini-native' ? 'ListModels' : 'GET /models'}): ` +
        (list.ok ? `HTTP ${list.status} — ${list.detail}` : `BAŞARISIZ${list.status ? ` (HTTP ${list.status})` : ''} — ${list.detail}`));
      if (list.ok) {
        console.log(`  Yapılandırılan model "${normalizedModel}" listede: ${listed ? 'VAR' : 'YOK'}`);
        if (!listed) {
          const suggestions = list.models.filter((name) => name.toLowerCase().includes('gemini') || name.toLowerCase().includes(normalizedModel.split('-')[0] ?? '')).slice(0, 8);
          if (suggestions.length > 0) console.log(`  Kullanılabilir benzer modeller: ${suggestions.join(', ')}`);
        }
        if (listed) {
          console.log('  ⇒ Anahtar ve model GEÇERLİ; hata sohbet UCUNDAN kaynaklanıyor (model listesi çalışıyor, sohbet çalışmıyor).');
          console.log(`    Karşılaştırmak için diğer taşıyıcıyı deneyin: npm run llm:doctor -- ${activeTransport === 'gemini-native' ? '--compat' : '--native'}`);
        }
      }

      console.log('\n  Kontrol sırası:');
      console.log('   1) Model adı sağlayıcının listesinde birebir var mı? (yukarıdaki Liste denetimi)');
      console.log('   2) LLM_BASE_URL kök mü? Google için https://generativelanguage.googleapis.com/v1beta');
      console.log('      (istemci yerel generateContent API\'sini kullanır; OpenAI için https://api.openai.com/v1,');
      console.log('       OpenRouter için https://openrouter.ai/api/v1)');
      console.log('   3) Anahtar doğru mu ve bu model için yetkili mi? (401/403 → anahtar; 429 → kota)');
      console.log('   4) Ağ/güvenlik duvarı: bu makineden uca çıkılabiliyor mu? (NODE_TLS_REJECT_UNAUTHORIZED=0 KULLANMAYIN)');
      console.log(`   5) Diğer taşıyıcıyla karşılaştırın: npm run llm:doctor -- ${activeTransport === 'gemini-native' ? '--compat' : '--native'}`);
      console.log('  Anahtarları tek tek doldurmak için: npm run env:setup');
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(`✖ llm:doctor çalışamadı: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
