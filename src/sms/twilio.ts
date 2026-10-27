/**
 * Twilio SMS istemcisi (REST, `fetch` ile; SDK bağımlılığı yok).
 *
 * - Varsayılan KAPALI: `SMS_ENABLED=1` ve kimlik bilgileri yoksa yapılandırma `null` döner.
 * - `fetch` enjekte edilebilir: testler gerçek ağa çıkmaz.
 * - Sırlar (Auth Token) hiçbir hata metnine/loga yazılmaz; telefon numarası maskelenir.
 *
 * Uç nokta: POST {base}/2010-04-01/Accounts/{AccountSid}/Messages.json (form-urlencoded,
 * Basic auth). `accepted` = Twilio isteği kabul etti (queued/accepted); TESLİM iddiası değildir.
 */

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  from: string | null;
  messagingServiceSid: string | null;
  apiBaseUrl: string;
}

export interface SmsEnvLike {
  SMS_ENABLED: boolean;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM: string;
  TWILIO_MESSAGING_SERVICE_SID: string;
  TWILIO_API_BASE_URL: string;
}

/** Ortamdan SMS yapılandırması; kapalı ya da eksikse `null` (SMS hiç kuyruğa alınmaz). */
export function readSmsConfig(env: SmsEnvLike): SmsConfig | null {
  if (!env.SMS_ENABLED) return null;
  const accountSid = env.TWILIO_ACCOUNT_SID.trim();
  const authToken = env.TWILIO_AUTH_TOKEN.trim();
  const from = env.TWILIO_FROM.trim() || null;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID.trim() || null;
  if (!accountSid || !authToken || (!from && !messagingServiceSid)) return null;
  return {
    accountSid,
    authToken,
    from,
    messagingServiceSid,
    apiBaseUrl: (env.TWILIO_API_BASE_URL || 'https://api.twilio.com').replace(/\/+$/, ''),
  };
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** E.164 doğrulaması (boşluk/tire temizlenir). Türkiye için 0 ile başlayan yerel biçim +90'a çevrilir. */
export function normalizePhoneE164(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  let candidate = compact;
  if (/^00[1-9]/.test(candidate)) candidate = `+${candidate.slice(2)}`;
  else if (/^05\d{9}$/.test(candidate)) candidate = `+90${candidate.slice(1)}`;
  else if (/^5\d{9}$/.test(candidate)) candidate = `+90${candidate}`;
  return E164.test(candidate) ? candidate : null;
}

/** Loglar için maskeli numara: +90******4567. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}

export type SmsSendResult =
  | { ok: true; sid: string; status: string }
  | { ok: false; status: number; code: number | null; message: string; retryable: boolean };

export interface SmsClient {
  send(input: { to: string; body: string }): Promise<SmsSendResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Kalıcı (yeniden denenmeyecek) Twilio hata kodları — örn. 21211 geçersiz numara,
 * 21608 deneme hesabında doğrulanmamış numara, 21610 alıcı STOP ile çıktı,
 * 21408 bölge izni yok, 21614 mobil değil. Liste kesin değildir; bilinmeyen 4xx de kalıcı sayılır.
 */
const PERMANENT_CODES = new Set([21211, 21408, 21608, 21610, 21612, 21614, 21606, 21660]);

export function createTwilioClient(config: SmsConfig, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): SmsClient {
  const url = `${config.apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  return {
    async send({ to, body }) {
      const form = new URLSearchParams();
      form.set('To', to);
      form.set('Body', body);
      if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
      else if (config.from) form.set('From', config.from);
      let response: { status: number; json(): Promise<unknown> };
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });
      } catch (error) {
        // Ağ hatası: mesajda sır yoktur (URL'de token bulunmaz).
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 0, code: null, message: `ağ hatası: ${message}`.slice(0, 300), retryable: true };
      }
      let data: Record<string, unknown> = {};
      try {
        const parsed = await response.json();
        if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (response.status >= 200 && response.status < 300 && typeof data['sid'] === 'string') {
        return { ok: true, sid: data['sid'], status: typeof data['status'] === 'string' ? data['status'] : 'queued' };
      }
      const code = typeof data['code'] === 'number' ? data['code'] : null;
      const message = typeof data['message'] === 'string' ? data['message'] : `HTTP ${response.status}`;
      const retryable =
        response.status === 429 || response.status >= 500 || (response.status === 0 && code === null);
      return {
        ok: false,
        status: response.status,
        code,
        message: message.slice(0, 300),
        retryable: retryable && !(code !== null && PERMANENT_CODES.has(code)),
      };
    },
  };
}
