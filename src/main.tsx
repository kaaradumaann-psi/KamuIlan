/**
 * Arayüz girişi.
 *
 * Yönlendirme react-router ile, sunucu durumu @tanstack/react-query ile yönetilir;
 * sunucu verisi bileşenlerde kopyalanmaz. Oturum bilgisi tek yerde
 * (`SessionProvider`) tutulur ve sunucudaki `/api/auth/session` ucuyla doğrulanır.
 *
 * Stil sırası psikolog/MMPI çalışma alanlarıyla BİREBİR aynıdır. İki referans
 * deponun da `main.tsx` dosyası aynı göreli sırayı kullanır:
 *
 *   screen → auth → (dashboard) → site → mobile → theme → coherence →
 *   workspace → …uygulama katmanı… → responsive
 *
 * `responsive.css` her zaman EN SONDA gelir; böylece her katmanı yeniden
 * yorumlayabilir. Bu sıra `tests/design-system.test.ts` ile denetlenir;
 * değiştirmek tasarım sapmasıdır. `index.css` yoktur.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './lib/session';

import './styles/screen.css';
import './styles/auth.css';
import './styles/dashboard.css';
import './styles/site.css';
import './styles/mobile.css';
import './styles/theme.css';
import './styles/coherence.css';
import './styles/workspace.css';
// Kamuİlan'a özgü tek katman; yukarıdaki paylaşılan katmanların üzerine yazar.
import './styles/kamuilan.css';
// Duyarlı temel her zaman en son: yukarıdaki tüm katmanları yeniden yorumlar.
import './styles/responsive.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Arayüz kökü (#root) bulunamadı: index.html beklenen yapıda değil.');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
