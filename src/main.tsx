/**
 * Arayüz girişi.
 *
 * Yönlendirme react-router ile, sunucu durumu @tanstack/react-query ile yönetilir;
 * sunucu verisi bileşenlerde kopyalanmaz. Oturum bilgisi tek yerde
 * (`SessionProvider`) tutulur ve sunucudaki `/api/auth/session` ucuyla doğrulanır.
 *
 * Stil sırası psikolog/MMPI çalışma alanlarıyla aynıdır: önce temel katmanlar
 * (tokens → site → bileşen derisi), sonra Kamuİlan katmanları, en sonda
 * responsive. `index.css` yoktur; katmanlar burada açıkça sıralanır.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './lib/session';

import './styles/screen.css';
import './styles/site.css';
import './styles/coherence.css';
import './styles/theme.css';
import './styles/workspace.css';
import './styles/dashboard.css';
import './styles/kamuilan.css';
import './styles/auth.css';
import './styles/mobile.css';
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
