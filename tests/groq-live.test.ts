/**
 * `npm run llm:groq` (scripts/groq-live.ts) — tamamen offline: sahte stdin, sahte fetch.
 *
 * Kanıtlanan sözleşmeler:
 *  - TTY yokken / boş girişte / Ctrl+C'de hiçbir sağlayıcı çağrısı yapılmaz (çıkış 2).
 *  - Gizli giriş ekrana anahtar karakteri basmaz; Backspace son karakteri siler.
 *  - Anahtar hiçbir çıktıda ve raporda görünmez (sağlayıcı hata metninde yankılansa bile).
 *  - 401'de model denemesine geçilmez (çıkış 3); listede olmayan model "ERİŞİLEMEZ" ve kullanılmaz.
 *  - Tarama entegrasyonu gerçek kapıyla çalışır; ilk model 429 (RPD) verirse yedek model karar verir.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { LlmFetch } from '../src/ai/llm';
import {
  GROQ_MODELS,
  SCRAPE_ITEMS,
  promptHidden,
  runGroqLive,
  runScrapeIntegration,
  type EvalRunResult,
  type GroqLiveDeps,
  type ScrapeIntegrationReport,
} from '../scripts/groq-live';

const KEY = 'gsk_SahteAnahtar1234567890abcdef';

class FakeStdin extends EventEmitter {
  isTTY: boolean | undefined;
  rawModes: boolean[] = [];
  constructor(
    private readonly chunks: string[],
    tty = true,
  ) {
    super();
    this.isTTY = tty;
  }
  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    setImmediate(() => {
      for (const chunk of this.chunks) this.emit('data', chunk);
    });
    return this;
  }
  pause(): this {
    return this;
  }
}

function captureOut(): { write(text: string): void; text(): string } {
  let buffer = '';
  return { write: (text: string) => void (buffer += text), text: () => buffer };
}

const RATE_HEADERS = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '999',
  'x-ratelimit-reset-requests': '1m26.4s',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-tokens': '7900',
  'x-ratelimit-reset-tokens': '750ms',
};

const CLASSIFIER_REPLIES: Record<string, unknown> = {
  'Önemli Duyuru': {
    karar: 'ilan',
    icerikTuru: 'personnel_recruitment',
    istihdamTuru: 'sozlesmeli',
    guven: 0.92,
    ozet: 'Sözleşmeli personel alımı başvuru tarihleri ve şartlarıyla duyuruluyor.',
    kanitlar: {
      alimIfadesi: 'sözleşmeli personel alımı yapılacaktır',
      basvuruTarihi: '01.11.2026 - 15.11.2026 tarihleri arasında',
      kontenjan: '5 (beş)',
    },
  },
  'Akademik birimlerde toplantı yapıldı': {
    karar: 'ilan-degil',
    icerikTuru: 'news',
    istihdamTuru: 'belirsiz',
    guven: 0.9,
    ozet: 'Rektörün birim ziyareti haberi; yeni bir personel alımı duyurusu değil.',
    kanitlar: { olumsuzKanit: 'ziyaret ederek kadro planlaması hakkında görüş alışverişinde bulunmuştur' },
  },
};

interface FakeGroqOptions {
  modelsStatus?: number;
  listed?: string[];
  /** Bu modele gelen sohbet çağrıları 429 (günlük kota) döner. */
  dailyQuotaModel?: string;
}

function fakeGroq(options: FakeGroqOptions = {}): { fetchImpl: LlmFetch; chatModels: string[]; urls: string[] } {
  const chatModels: string[] = [];
  const urls: string[] = [];
  const fetchImpl: LlmFetch = async (url, init) => {
    urls.push(url);
    expect(init.headers?.authorization ?? init.headers?.Authorization).toBe(`Bearer ${KEY}`);
    if (url.endsWith('/models')) {
      const status = options.modelsStatus ?? 200;
      if (status !== 200) {
        // Sağlayıcı anahtarı yankılasa bile çıktıda görünmemeli.
        return { status, headers: {}, text: async () => JSON.stringify({ error: { message: `Invalid API Key ${KEY}` } }) };
      }
      const ids = options.listed ?? [...GROQ_MODELS, 'llama-3.1-8b-instant'];
      return { status: 200, headers: {}, text: async () => JSON.stringify({ data: ids.map((id) => ({ id })) }) };
    }
    const body = JSON.parse(init.body) as { model: string; messages: { role: string; content: string }[] };
    chatModels.push(body.model);
    if (body.model === options.dailyQuotaModel) {
      return {
        status: 429,
        headers: { 'retry-after': '3600', 'x-ratelimit-remaining-requests': '0' },
        text: async () =>
          JSON.stringify({
            error: { message: 'Rate limit reached for model on requests per day (RPD): Limit 1000, Used 1000', code: 'rate_limit_exceeded' },
          }),
      };
    }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const title = Object.keys(CLASSIFIER_REPLIES).find((t) => user.includes(t));
    const payload = system.startsWith('Bağlantı denetimi')
      ? { durum: 'hazir' }
      : (title ? CLASSIFIER_REPLIES[title] : null) ?? { karar: 'belirsiz', icerikTuru: 'uncertain', guven: 0.3, ozet: 'Karar verilemedi.', kanitlar: {} };
    return {
      status: 200,
      headers: RATE_HEADERS,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 25 } },
        }),
    };
  };
  return { fetchImpl, chatModels, urls };
}

function deps(overrides: Partial<GroqLiveDeps> & { stdin?: GroqLiveDeps['stdin'] }) {
  const out = captureOut();
  const reports: string[] = [];
  const runEval = vi.fn(async (): Promise<EvalRunResult> => ({ exitCode: 0, elapsedMs: 5, output: 'eval tamam\n' }));
  const runScrape = vi.fn(
    async (): Promise<ScrapeIntegrationReport> => ({
      status: 'success',
      jobsCreated: 1,
      itemsReview: 0,
      itemsRejected: 0,
      llm: {},
      jobs: [],
      decisions: [],
      analyses: [],
    }),
  );
  const full: GroqLiveDeps = {
    env: {},
    stdin: new FakeStdin([], false),
    out,
    fetchImpl: fakeGroq().fetchImpl,
    runEval,
    runScrape,
    writeReport: (json) => {
      reports.push(json);
      return null;
    },
    ...overrides,
  };
  return { full, out, reports, runEval, runScrape };
}

describe('promptHidden', () => {
  it('karakterleri ekrana basmaz, Backspace siler, ham modu açıp kapatır', async () => {
    const stdin = new FakeStdin(['abX', '\u007f', 'c\r']);
    const out = captureOut();
    await expect(promptHidden(stdin, out, 'Anahtar: ')).resolves.toBe('abc');
    expect(out.text()).toBe('Anahtar: \n');
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it('Ctrl+C iptal eder (null)', async () => {
    await expect(promptHidden(new FakeStdin(['ab\u0003']), captureOut(), '')).resolves.toBeNull();
  });
});

describe('runGroqLive — güvenli çıkışlar (hiç çağrı yok)', () => {
  it('TTY yok ve GROQ_API_KEY yok → çıkış 2, kendi terminalinde çalıştır uyarısı', async () => {
    const fetchImpl = vi.fn<LlmFetch>();
    const { full, out, runEval } = deps({ fetchImpl });
    await expect(runGroqLive(full)).resolves.toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runEval).not.toHaveBeenCalled();
    expect(out.text()).toContain('npm run llm:groq');
    expect(out.text()).toContain('Hiçbir sağlayıcı çağrısı yapılmadı');
  });

  it('boş giriş → çıkış 2', async () => {
    const fetchImpl = vi.fn<LlmFetch>();
    const { full, out } = deps({ fetchImpl, stdin: new FakeStdin(['   \r']) });
    await expect(runGroqLive(full)).resolves.toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.text()).toContain('Boş anahtar');
  });

  it('Ctrl+C → çıkış 2', async () => {
    const fetchImpl = vi.fn<LlmFetch>();
    const { full } = deps({ fetchImpl, stdin: new FakeStdin(['gsk_ab\u0003']) });
    await expect(runGroqLive(full)).resolves.toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runGroqLive — sahte Groq ile akış', () => {
  it('GROQ_API_KEY yolu: üç model denenir, hız sınırı raporlanır, anahtar çıktıda/raporda yok', async () => {
    const groq = fakeGroq();
    const { full, out, reports, runEval, runScrape } = deps({ env: { GROQ_API_KEY: KEY }, fetchImpl: groq.fetchImpl });
    await expect(runGroqLive(full)).resolves.toBe(0);
    expect(groq.chatModels).toEqual([...GROQ_MODELS]);
    expect(runEval).toHaveBeenCalledWith(KEY, [...GROQ_MODELS], expect.anything());
    expect(runScrape).toHaveBeenCalledOnce();
    const text = out.text();
    expect(text).toContain('istek(gün) 999/1000');
    expect(text).toContain('finish_reason stop');
    expect(text).toContain('akıl yürütme 25');
    expect(text).not.toContain(KEY);
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toContain(KEY);
    expect(JSON.parse(reports[0] ?? '{}').exitCode).toBe(0);
  });

  it('gizli giriş yolu: girilen anahtar kullanılır ve hiçbir yere basılmaz', async () => {
    const groq = fakeGroq();
    const { full, out } = deps({ stdin: new FakeStdin([`${KEY}\r`]), fetchImpl: groq.fetchImpl });
    await expect(runGroqLive(full)).resolves.toBe(0);
    expect(out.text()).toContain('gizli giriş');
    expect(out.text()).not.toContain(KEY);
  });

  it('401 → çıkış 3; model çağrısı, eval ve tarama yapılmaz; yankılanan anahtar maskelenir', async () => {
    const groq = fakeGroq({ modelsStatus: 401 });
    const { full, out, reports, runEval, runScrape } = deps({ env: { GROQ_API_KEY: KEY }, fetchImpl: groq.fetchImpl });
    await expect(runGroqLive(full)).resolves.toBe(3);
    expect(groq.chatModels).toEqual([]);
    expect(runEval).not.toHaveBeenCalled();
    expect(runScrape).not.toHaveBeenCalled();
    expect(out.text()).toContain('Anahtar reddedildi');
    expect(out.text()).not.toContain(KEY);
    expect(reports[0]).not.toContain(KEY);
  });

  it('listede olmayan model ERİŞİLEMEZ yazılır ve zincirde kullanılmaz', async () => {
    const groq = fakeGroq({ listed: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] });
    const { full, out, runEval } = deps({ env: { GROQ_API_KEY: KEY }, fetchImpl: groq.fetchImpl });
    await expect(runGroqLive(full)).resolves.toBe(0);
    expect(out.text()).toContain('qwen/qwen3.8-27b: ERİŞİLEMEZ');
    expect(groq.chatModels).not.toContain('qwen/qwen3.8-27b');
    expect(runEval).toHaveBeenCalledWith(KEY, ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], expect.anything());
  });
});

describe('runScrapeIntegration — gerçek kapı, sahte sağlayıcı', () => {
  it('ana model günlük kotada → yedek model karar verir; kanıtlı alım ilan olur, haber reddedilir', async () => {
    const groq = fakeGroq({ dailyQuotaModel: 'openai/gpt-oss-20b' });
    const report = await runScrapeIntegration(KEY, GROQ_MODELS, groq.fetchImpl);
    expect(report.status).toBe('success');
    expect(groq.chatModels[0]).toBe('openai/gpt-oss-20b');
    // Kotası biten modele yeniden gidilmez: yalnız ilk istek ona gider.
    expect(groq.chatModels.filter((model) => model === 'openai/gpt-oss-20b')).toHaveLength(1);
    const alim = report.jobs.find((job) => job.title === 'Önemli Duyuru');
    expect(alim?.kind).toBe('job');
    expect(alim?.model).toBe('qwen/qwen3.8-27b');
    expect(alim?.evidenceVerified).toBe(true);
    expect(report.decisions.find((entry) => entry.sourceItemId === 'haber')?.decision).toBe('rejected');
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(SCRAPE_ITEMS.every((item) => (item.bodyText ?? '').length >= 200)).toBe(true);
  });
});
