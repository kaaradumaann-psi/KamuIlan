/**
 * Resend taşıyıcısı testleri — ağa çıkmadan.
 *
 * Neden gerekli: Kamuİlan'ın üretimde e-posta gönderdiği yol Resend HTTPS
 * API'sidir. Bu test, gerçek bir istek üretilip üretilmediğini, sağlayıcı
 * yanıtının nasıl yorumlandığını ve hata durumunda ne olduğunu ölçer:
 *  - 2xx → yalnızca "sağlayıcı kabul etti" (asla "teslim edildi" değil),
 *  - 4xx/5xx → kabul edilmedi, hata mesajı sağlayıcıdan aynen taşınır,
 *  - ağ hatası → maskeli alıcı adresi (düz metin e-posta loglanmaz),
 *  - yanıt gelmezse istek zaman aşımına uğrar (sonsuza kadar asılı kalmaz).
 *
 * Ağ çağrısı enjekte edilir (`fetchImpl`); hiçbir test gerçek Resend'e bağlanmaz.
 */
import { describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import {
  MemoryEmailTransport,
  ResendEmailTransport,
  createEmailTransport,
  parseResendId,
  type EmailMessage,
  type FetchLike,
} from '../src/email/transport';
import { renderEmail } from '../src/email/templates';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: 'aday@ornek.test',
    subject: 'Sözleşmeli Personel Alım İlanı — Test Kurumu',
    html: '<p>Yeni ilan</p>',
    text: 'Yeni ilan',
    template: 'new-job',
    ...overrides,
  };
}

/** Sahte Resend: gönderilen isteği yakalar ve verilen yanıtı döner. */
function fakeFetch(
  captured: Captured[],
  response: { ok: boolean; status: number; body: string },
): FetchLike {
  return async (input, init) => {
    captured.push({
      url: input,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return { ok: response.ok, status: response.status, text: async () => response.body };
  };
}

describe('Resend taşıyıcısı', () => {
  it('gönderim isteğini doğru biçimde kurar ve sağlayıcı kimliğini döner', async () => {
    const captured: Captured[] = [];
    const transport = new ResendEmailTransport({
      apiKey: 're_test_anahtari',
      from: 'Kamuİlan <bildirim@kamuilan.halilkaraduman.test>',
      fetchImpl: fakeFetch(captured, { ok: true, status: 200, body: JSON.stringify({ id: 'msg_123' }) }),
    });

    const result = await transport.send(message());

    expect(transport.key).toBe('resend');
    expect(result.accepted).toBe(true);
    expect(result.providerMessageId).toBe('msg_123');
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.headers['authorization']).toBe('Bearer re_test_anahtari');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body['from']).toBe('Kamuİlan <bildirim@kamuilan.halilkaraduman.test>');
    expect(request.body['to']).toEqual(['aday@ornek.test']);
    expect(request.body['subject']).toContain('Sözleşmeli Personel');
    expect(String(request.body['html'])).toContain('Yeni ilan');
    expect(String(request.body['text'])).toContain('Yeni ilan');
  });

  it('özel API tabanı (test/geliştirme) kullanılabilir', async () => {
    const captured: Captured[] = [];
    const transport = new ResendEmailTransport({
      apiKey: 're_x',
      from: 'bildirim@ornek.test',
      baseUrl: 'http://127.0.0.1:9999/',
      fetchImpl: fakeFetch(captured, { ok: true, status: 201, body: '{"id":"local"}' }),
    });
    await transport.send(message());
    expect(captured[0]?.url).toBe('http://127.0.0.1:9999/emails');
  });

  it('sağlayıcı hata dönerse kabul edilmedi olarak raporlanır, durum saklanır', async () => {
    const captured: Captured[] = [];
    const transport = new ResendEmailTransport({
      apiKey: 're_x',
      from: 'bildirim@ornek.test',
      fetchImpl: fakeFetch(captured, {
        ok: false,
        status: 422,
        body: '{"statusCode":422,"name":"validation_error","message":"Invalid `from` field"}',
      }),
    });

    const result = await transport.send(message());
    expect(result.accepted).toBe(false);
    expect(result.providerMessageId).toBeNull();
    expect(result.error).toContain('422');
    // "Teslim edildi" iddiası asla üretilmez; provider yanıtı kanıt olarak saklanır.
    expect(result.providerResponse).toContain('validation_error');
  });

  it('ağ hatasında alıcı adresi maskelenir (düz metin e-posta loglanmaz)', async () => {
    const transport = new ResendEmailTransport({
      apiKey: 're_x',
      from: 'bildirim@ornek.test',
      fetchImpl: async () => {
        throw new Error('ENOTFOUND api.resend.com');
      },
    });

    const result = await transport.send(message({ to: 'gizli.adres@ornek.test' }));
    expect(result.accepted).toBe(false);
    // Maskeleme: yerel kısmın ilk karakteri kalır, gerisi gizlenir.
    expect(result.error).toContain('g***@ornek.test');
    expect(result.error).not.toContain('gizli.adres@ornek.test');
  });

  it('yanıt gelmezse istek zaman aşımıyla biter (sonsuza kadar asılı kalmaz)', async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const transport = new ResendEmailTransport({
      apiKey: 're_x',
      from: 'bildirim@ornek.test',
      timeoutMs: 20,
      fetchImpl: hanging,
    });

    const started = Date.now();
    const result = await transport.send(message());
    expect(result.accepted).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('taşıyıcı seçimi: Resend > SMTP > dosya; üretimde sağlayıcı yoksa başlatılmaz', () => {
    const base = getEnv();

    const withResend = createEmailTransport({ ...base, RESEND_API_KEY: 're_live', SMTP_HOST: '' });
    expect(withResend.mode).toBe('resend');
    expect(withResend.transport.key).toBe('resend');

    const withSmtp = createEmailTransport({ ...base, RESEND_API_KEY: '', SMTP_HOST: 'smtp.ornek.test' });
    expect(withSmtp.mode).toBe('smtp');

    const dev = createEmailTransport({ ...base, RESEND_API_KEY: '', SMTP_HOST: '', NODE_ENV: 'test' });
    expect(dev.mode).toBe('file');

    expect(() =>
      createEmailTransport({ ...base, RESEND_API_KEY: '', SMTP_HOST: '', NODE_ENV: 'production' }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it('bozuk sağlayıcı yanıtı mesaj kimliğini uydurmaz', () => {
    expect(parseResendId('{"id":"gercek"}')).toBe('gercek');
    expect(parseResendId('{"id":42}')).toBeNull();
    expect(parseResendId('beklenmeyen gövde')).toBeNull();
    expect(parseResendId('')).toBeNull();
  });

  it('bellek taşıyıcısı geçici hataları sonra başarıya çevirir (yeniden deneme testleri için)', async () => {
    const transport = new MemoryEmailTransport({ failuresBeforeSuccess: 1 });
    const first = await transport.send(message());
    expect(first.accepted).toBe(false);
    const second = await transport.send(message());
    expect(second.accepted).toBe(true);
    expect(transport.sent).toHaveLength(1);
  });

  it('davet e-postası düz metin parola içermez, tek kullanımlık bağlantı taşır', () => {
    const rendered = renderEmail(
      'account-invite',
      {
        inviteUrl: 'https://kamuilan.halilkaraduman.com.tr/sifre-sifirla?token=TEK-KULLANIMLIK-JETON',
        roleLabel: 'yönetici',
      },
      {
        senderName: 'Kamuİlan',
        baseUrl: 'https://kamuilan.halilkaraduman.com.tr',
      },
    );
    expect(rendered.subject).toContain('Kamuİlan');
    expect(rendered.html).toContain('TEK-KULLANIMLIK-JETON');
    expect(rendered.text).toContain('TEK-KULLANIMLIK-JETON');
    expect(rendered.html.toLowerCase()).not.toContain('parola:');
    expect(rendered.text).toContain('dışarıdan kayıt yoktur');
  });
});
