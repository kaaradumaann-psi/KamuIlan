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
import { callChatCompletion, chatCompletionsEndpoint, describeLlmEndpointRisk } from '../src/ai/llm';
import { llmClassifierConfig } from '../src/ai/classifier';
import type { LlmConfig } from '../src/ai/llm';

const HELP = `LLM kapısı tanısı

Kullanım:
  npm run llm:doctor                yapılandırma + tek canlı çağrı
  npm run llm:doctor -- --offline   yalnızca yapılandırma (ağ çağrısı yok)
  npm run llm:doctor -- --json      makine okunur çıktı
  npm run llm:doctor -- --help      bu yardım`;

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
  endpoint: string | null;
  endpointRisk: string | null;
  timeoutMs: number;
  maxCallsPerRun: number;
  dailyCallLimit: number;
  costConfigured: boolean;
  warnings: string[];
  call: { attempted: boolean; ok: boolean; status: number | null; elapsedMs: number; detail: string } | null;
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP);
    return;
  }
  const offline = hasFlag('--offline');
  const asJson = hasFlag('--json');

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

  const report: DoctorReport = {
    classifierEnabled: env.LLM_CLASSIFIER_ENABLED,
    assistantEnabled: env.AI_ASSISTANT_ENABLED,
    model,
    baseUrl,
    endpoint: baseUrl ? chatCompletionsEndpoint(baseUrl) : null,
    endpointRisk,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxCallsPerRun: env.LLM_MAX_CALLS_PER_RUN,
    dailyCallLimit: env.LLM_DAILY_CALL_LIMIT,
    costConfigured: Boolean(env.LLM_COST_USD_PER_MTOK_INPUT || env.LLM_COST_USD_PER_MTOK_OUTPUT),
    warnings: llmWarnings,
    call: null,
  };

  if (config && !offline) {
    const started = Date.now();
    const result = await callChatCompletion(
      config,
      [
        { role: 'system', content: 'Bağlantı denetimi. Yanıt olarak yalnızca tek bir Türkçe sözcük yaz.' },
        { role: 'user', content: 'hazır' },
      ],
      { maxTokens: 8, temperature: 0 },
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
    console.log(`  İstek ucu            : ${report.endpoint ?? '(hesaplanamadı)'}`);
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
      console.log('  Kontrol sırası:');
      console.log('   1) LLM_BASE_URL OpenAI uyumlu KÖK mü? (ör. https://api.openai.com/v1, https://openrouter.ai/api/v1,');
      console.log('      https://generativelanguage.googleapis.com/v1beta — Google kökü otomatik /openai ucuna çevrilir)');
      console.log('   2) Model adı bu sağlayıcıda geçerli mi? (sağlayıcının model listesinden birebir kopyalayın)');
      console.log('   3) Anahtar doğru mu ve bu model için yetkili mi? (401/403 → anahtar; 429 → kota)');
      console.log('   4) Ağ/güvenlik duvarı: bu makineden uca çıkılabiliyor mu? (NODE_TLS_REJECT_UNAUTHORIZED=0 KULLANMAYIN)');
      console.log('  Anahtarları tek tek doldurmak için: npm run env:setup');
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(`✖ llm:doctor çalışamadı: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
