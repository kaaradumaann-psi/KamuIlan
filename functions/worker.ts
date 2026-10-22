/**
 * Cloudflare Workers giriş noktası (`wrangler.jsonc` → `main`).
 *
 * Neden: `functions/api/[[path]].ts` Cloudflare **Pages** klasör kuralıdır; **Workers** + statik varlık
 * dağıtımında bu klasör hiç çalışmaz. `main` tanımsızken `/api/*` istekleri SPA geri dönüşüne düşüp
 * JSON yerine `index.html` dönüyordu (giriş dahil hiçbir API çağrısı çalışmazdı; 22.10.2026'da bulundu).
 *
 * Yönlendirme: `assets.run_worker_first: ["/api/*"]` yalnız API yollarını bu betiğe getirir; diğer
 * tüm istekler doğrudan statik varlıklardan (SPA) sunulur ve Worker çağrısı sayılmaz.
 */
import { proxy } from './api/[[path]]';

type WorkerEnv = {
  API_ORIGIN?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return proxy({ request, env });
    return env.ASSETS.fetch(request);
  },
};
