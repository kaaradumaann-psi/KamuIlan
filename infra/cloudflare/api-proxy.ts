/**
 * Cloudflare Worker — statik arayüz + /api vekili.
 *
 * Neden: Kamuİlan arayüzü statiktir (Vite çıktısı), API ve worker ise Node
 * süreçleridir (tarayıcıdan erişilemez). Cloudflare üzerinde yalnızca
 * `kamuilan.halilkaraduman.com.tr` yayınlanır; `/api/*` istekleri burada API
 * sürecine aktarılır. Böylece tarayıcı açısından her şey TEK kaynak (same
 * origin) olur: oturum çerezi HttpOnly + SameSite=Lax kalır, CORS gerekmez ve
 * API adresi istemciye sızmaz.
 *
 * Ayrıntı: docs/deployment.md, wrangler.jsonc
 */

interface Env {
  /** wrangler.jsonc → assets.binding */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** wrangler.jsonc → vars.API_ORIGIN (veya `wrangler secret put API_ORIGIN`) */
  API_ORIGIN?: string;
}

const API_PREFIX = '/api';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'api_origin_missing', message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isApiCall = url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`);
    if (!isApiCall) {
      // Arayüz: SPA yönlendirmesi assets yapılandırmasında tanımlıdır.
      return env.ASSETS.fetch(request);
    }

    const origin = env.API_ORIGIN?.trim().replace(/\/+$/, '');
    if (!origin) {
      return jsonError(
        503,
        'API adresi tanımlı değil: wrangler.jsonc → vars.API_ORIGIN ya da `wrangler secret put API_ORIGIN`.',
      );
    }

    let target: URL;
    try {
      target = new URL(`${url.pathname}${url.search}`, `${origin}/`);
    } catch {
      return jsonError(503, 'API adresi geçersiz (API_ORIGIN).');
    }

    // Gövde, başlıklar ve çerezler olduğu gibi aktarılır; yanıt da değiştirilmez.
    return fetch(new Request(target, request));
  },
};
