/**
 * Arayüz girişi.
 *
 * Yönlendirme: react-router (tarayıcı geçmişi) + @tanstack/react-query (sunucu
 * durumu). Sunucu durumu bileşenlerde kopyalanmaz; tek kaynak API'dir.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AdminPage } from './pages/Admin';
import { HomePage } from './pages/Home';
import { JobDetailPage } from './pages/JobDetail';
import { JobsPage } from './pages/Jobs';
import { PanelPage } from './pages/Panel';
import { SourcesPage } from './pages/Sources';
import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResendVerificationPage,
  ResetPasswordPage,
  UnsubscribePage,
  VerifyEmailPage,
} from './pages/auth';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function NotFoundPage(): ReactNode {
  return (
    <div className="card">
      <h1 className="text-lg font-semibold">Sayfa bulunamadı</h1>
      <p className="mt-1 text-sm">
        Aradığınız sayfa yok. <Link to="/">Ana sayfaya dönün</Link> veya <Link to="/ilanlar">ilanlara göz atın</Link>.
      </p>
    </div>
  );
}

function App(): ReactNode {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/ilanlar" element={<JobsPage />} />
        <Route path="/ilanlar/:id" element={<JobDetailPage />} />
        <Route path="/kaynaklar" element={<SourcesPage />} />
        <Route path="/giris" element={<LoginPage />} />
        <Route path="/kayit" element={<RegisterPage />} />
        <Route path="/dogrulama" element={<VerifyEmailPage />} />
        <Route path="/dogrulama-gonder" element={<ResendVerificationPage />} />
        <Route path="/sifremi-unuttum" element={<ForgotPasswordPage />} />
        <Route path="/sifre-sifirla" element={<ResetPasswordPage />} />
        <Route path="/abonelikten-cik" element={<UnsubscribePage />} />
        <Route path="/panel" element={<PanelPage />} />
        <Route path="/yonetim" element={<AdminPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Arayüz kökü (#root) bulunamadı: index.html beklenen yapıda değil.');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
