/**
 * Cloudflare Workers Function — `/api/*` → API süreci.
 *
 * Kamuİlan arayüzü statik bir SPA'dir ve sunucuya yalnızca GÖRELi yollarla
 * (`/api/jobs`, `/api/health`) konuşur; tarayıcı hiçbir zaman `localhost` ya da
 * başka bir ana makine adına istek atmaz. Cloudflare'de `/api` yolunu API
 * sürecine bağlayan katman budur.
 *
 * Neden gerekli: `dist/` içinde API yoktur. Proxy kurulmazsa tarayıcı
 * `https://kamuilan.halilkaraduman.com.tr/api/health` adresine gider ve statik
 * varlık sunucusu SPA gövdesini (HTML) döndürür; arayüz JSON beklerken HTML
 * alır ve sessizce boş kalır. Bu dosya o hatayı baştan kapatır.
 *
 * Yapılandırma: `wrangler.jsonc` → `vars.API_ORIGIN` ya da
 * `npx wrangler secret put API_ORIGIN`.
 *
 * Not: Bu dosya `tsconfig.json` kapsamı dışındadır (Workers çalışma zamanı
 * tipleri depoya eklenmez); `npm run typecheck` onu denetlemez, `npm run lint`
 * denetler.
 */

/** Workers ortam değişkenleri. */
type ApiProxyEnv = {
  API_ORIGIN?: string;
};

/** Varsayılan API adresi (wrangler.jsonc ile aynı). */
const DEFAULT_API_ORIGIN = 'https://api.kamuilan.halilkaraduman.com.tr';

/**
 * İstemciden API'ye taşınmayan başlıklar (hop-by-hop / ana makineye bağlı).
 *
 * `x-forwarded-for`, `x-real-ip` ve `forwarded` da listede: API `TRUST_PROXY=1`
 * ile çalışırken bu başlıklara güvenir. İstemci kendi uydurduğu IP'yi
 * gönderebilseydi hız sınırı kovasını ve denetim kaydını atlatırdı; bu yüzden
 * değer aşağıda **yalnızca Cloudflare'in güvenilir `cf-connecting-ip`
 * başlığından** yazılır.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
]);

/** Yanıttan istemciye taşınmayan başlıklar. */
const STRIPPED_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection', 'keep-alive']);

/**
 * Tüm HTTP yöntemlerini karşılar (GET, POST, PATCH, PUT, DELETE, OPTIONS).
 *
 * Gövde akış olarak geçirilir; oturum çerezleri ve CSRF başlıkları olduğu gibi
 * iletilir. Yalnızca ana makineye bağlı başlıklar ayıklanır.
 */
export async function onRequestGet(context: { request: Request; env: ApiProxyEnv }): Promise<Response> {
  return proxy(context);
}

/** @see onRequestGet */
export async function onRequestPost(context: { request: Request; env: ApiProxyEnv }): Promise<Response> {
  return proxy(context);
}

/** @see onRequestGet */
export async function onRequestPatch(context: { request: Request; env: ApiProxyEnv }): Promise<Response> {
  return proxy(context);
}

/** @see onRequestGet */
export async function onRequestPut(context: { request: Request; env: ApiProxyEnv }): Promise<Response> {
  return proxy(context);
}

/** @see onRequestGet */
export async function onRequestDelete(context: { request: Request; env: ApiProxyEnv }): Promise<Response> {
  return proxy(context);
}

/**
 * İstemci başlıklarından API'ye gidecek küme.
 *
 * `x-forwarded-for` istemciden ASLA taşınmaz; değer yalnızca Cloudflare'in
 * `cf-connecting-ip` başlığından yazılır. Bu olmadan (`TRUST_PROXY=1` iken)
 * API bütün istekleri vekilin tek IP'sinden görür: hız sınırı tüm kullanıcılar
 * için tek kovaya düşer ve tek bir istemci herkesi kilitleyebilir.
 */
export function buildForwardHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp && clientIp.trim().length > 0) {
    headers.set('x-forwarded-for', clientIp.trim());
  }
  return headers;
}

export async function proxy(context: { request: Request; env: ApiProxyEnv }): Promise<Response> {
  const origin = normalizeOrigin(context.env.API_ORIGIN ?? DEFAULT_API_ORIGIN);
  const incoming = new URL(context.request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, origin);

  const headers = buildForwardHeaders(context.request);
  // API'nin isteği hangi alan adından geldiğini görmesi için (çerez SameSite,
  // APP_BASE_URL denetimleri ve günlükler).
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

  // GET/HEAD gövde taşımaz; diğer yöntemlerde akış doğrudan geçirilir.
  const hasBody = context.request.method !== 'GET' && context.request.method !== 'HEAD';

  // Akış gövdesi yalnızca gövde taşıyan isteklerde geçirilir; GET/HEAD'te
  // `body` verilmez (Workers akışlı gövdeyi yalnızca `duplex: 'half'` ile kabul
  // eder, bu da gövdesiz isteklerde gereksizdir).
  const init: RequestInit = {
    method: context.request.method,
    headers,
    redirect: 'manual',
  };
  if (hasBody && context.request.body) init.body = context.request.body;

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'api_unreachable',
        message: 'API sürecine ulaşılamıyor. wrangler secret: API_ORIGIN değerini denetleyin.',
        detail: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** Sonda eğik çizgi ve şema denetimi: `https://api.example.com` biçimine indirger. */
function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
