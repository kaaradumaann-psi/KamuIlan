/**
 * Kamuİlan kabuğu.
 *
 * Tasarım dili psikolog ve MMPI çalışma alanlarıyla birebir aynıdır: solda kalıcı
 * gezinme (`.workspace-sidebar`), üstte başlık (`.app-header`), içerik
 * (`.app-main`) ve altta site alt bilgisi. Dar ekranda aynı hedefler erişilebilir
 * bir menü paneline taşınır (`.mobile-nav-*`).
 *
 * Site GİRİŞ KAPILIDIR (psikolog/MMPI ile aynı model): oturum yoksa uygulama
 * kabuğu hiç açılmaz, kullanıcı doğrudan giriş ekranına alınır ve girişten
 * sonra istediği sayfaya devam eder. Yalnızca kimlik sayfaları (giriş, parola
 * sıfırlama, e-posta doğrulama, abonelikten çıkma) ve bilgi sayfaları (SSS,
 * gizlilik, kullanım) oturumsuz açıktır — e-posta bağlantıları çalışmalıdır.
 * Dışarıdan kayıt YOKTUR — hesap yalnızca yönetici davetiyle açılır.
 */
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorNotice } from './components/ui';
import { StatusBanner } from './components/StatusBanner';
import { MobileNav, type MobileNavItem } from './components/MobileNav';
import { BrandMark } from './components/BrandMark';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { SiteFooter, INFO_ROUTES } from './components/SiteFooter';
import { APP_VERSION } from './config/app';
import { errorMessage } from './lib/api';
import { useAuth } from './lib/session';
import { APP_NAME, HONESTY_NOTE, SITE_LABEL, SITE_URL } from './site';
import { AdminPage } from './pages/Admin';
import { HomePage } from './pages/Home';
import { JobDetailPage } from './pages/JobDetail';
import { JobsPage } from './pages/Jobs';
import { PanelPage } from './pages/Panel';
import { SavedJobsPage } from './pages/Saved';
import { SourcesPage } from './pages/Sources';
import {
  FaqPage,
  ForgotPasswordPage,
  LoginPage,
  NotFoundPage,
  PrivacyPage,
  ResetPasswordPage,
  TermsPage,
  UnsubscribePage,
  VerifyEmailPage,
} from './pages/auth';

type NavEntry = { id: string; label: string; icon: IconName; path: string; adminOnly?: boolean };

const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: 'Kamu ilanları',
    items: [
      { id: 'ozet', label: 'Genel bakış', icon: 'layers', path: '/' },
      { id: 'ilanlar', label: 'İlan ara', icon: 'search', path: '/ilanlar' },
      { id: 'kaynaklar', label: 'İlan kaynakları', icon: 'list', path: '/kaynaklar' },
    ],
  },
  {
    label: 'Bildirimler',
    items: [
      { id: 'panel', label: 'Tercihlerim', icon: 'bell', path: '/panel' },
      { id: 'kaydedilenler', label: 'Kaydettiklerim', icon: 'save', path: '/panel/kaydedilenler' },
      { id: 'gecmis', label: 'Bildirim geçmişi', icon: 'mail', path: '/panel/gecmis' },
    ],
  },
  {
    label: 'Yönetim',
    items: [{ id: 'yonetim', label: 'Yönetim paneli', icon: 'shield', path: '/yonetim', adminOnly: true }],
  },
];

/** Rota → gezinme kimliği (aktif bağlantı ve başlık etiketi için). */
function activeEntry(pathname: string): NavEntry | null {
  const flat = NAV_GROUPS.flatMap((group) => group.items);
  if (pathname === '/') return flat[0] ?? null;
  if (pathname.startsWith('/panel/kaydedilenler'))
    return flat.find((item) => item.id === 'kaydedilenler') ?? null;
  if (pathname.startsWith('/panel/gecmis')) return flat.find((item) => item.id === 'gecmis') ?? null;
  if (pathname.startsWith('/panel')) return flat.find((item) => item.id === 'panel') ?? null;
  if (pathname.startsWith('/yonetim')) return flat.find((item) => item.id === 'yonetim') ?? null;
  if (pathname.startsWith('/ilanlar')) return flat.find((item) => item.id === 'ilanlar') ?? null;
  if (pathname.startsWith('/kaynaklar')) return flat.find((item) => item.id === 'kaynaklar') ?? null;
  return null;
}

/** Kullanıcı avatarı için baş harfler. */
function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

/** Bilgi sayfaları kendi kabuğunu kullanır (üst şerit + geniş içerik). */
const INFO_PATHS = new Set<string>([INFO_ROUTES.sss, INFO_ROUTES.gizlilik, INFO_ROUTES.kullanim]);

function AppShell({ children }: { children: ReactNode }) {
  const { user, isAdmin, roleLabel, displayName, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const current = activeEntry(location.pathname);
  const infoPage = INFO_PATHS.has(location.pathname);

  const items: MobileNavItem[] = NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) => !item.adminOnly || isAdmin)
    .map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      active: current?.id === item.id,
      onSelect: () => navigate(item.path),
    }));

  // Rota değişiminde ana içeriğe odaklan (ekran okuyucu bağlamı).
  useEffect(() => {
    document.getElementById('main')?.focus();
  }, [location.pathname]);

  if (infoPage) return <>{children}</>;

  return (
    <div className="portal-layout">
      <a className="skip-link" href="#main">
        Ana içeriğe atla
      </a>

      <aside className="workspace-sidebar" aria-label="Kamuİlan gezinmesi">
        <Link className="brand sidebar-brand" to="/" aria-label={`${APP_NAME} ana sayfa`}>
          <span className="brand-mark" aria-hidden="true">
            <BrandMark />
          </span>
          <span className="brand-text">
            <strong className="brand-title">{APP_NAME}</strong>
            <span className="brand-subtitle">Kamu ilanı takip sistemi</span>
          </span>
        </Link>

        <div className="sidebar-nav-wrap">
          {NAV_GROUPS.filter((group) => group.items.some((item) => !item.adminOnly || isAdmin)).map(
            (group) => (
              <nav className="sidebar-nav" aria-label={group.label} key={group.label}>
                <span className="sidebar-label">{group.label}</span>
                {group.items
                  .filter((item) => !item.adminOnly || isAdmin)
                  .map((item) => (
                    <NavLink
                      key={item.id}
                      to={item.path}
                      className={`sidebar-link${current?.id === item.id ? ' is-current' : ''}`}
                      aria-current={current?.id === item.id ? 'page' : undefined}
                    >
                      <Icon name={item.icon} size={19} />
                      <span>{item.label}</span>
                      {current?.id === item.id && <span className="sidebar-current-dot" aria-hidden="true" />}
                    </NavLink>
                  ))}
              </nav>
            ),
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-privacy">
            <span className="sidebar-privacy-icon" aria-hidden="true">
              <Icon name="info" size={18} />
            </span>
            <strong>Bilmeniz gereken</strong>
            <p>{HONESTY_NOTE}</p>
            <Link to={INFO_ROUTES.kaynaklar}>
              Hangi kaynaklara bakıyoruz? <Icon name="arrowRight" size={14} />
            </Link>
          </div>
          <span className="sidebar-version">{`${APP_NAME} · v${APP_VERSION}`}</span>
        </div>
      </aside>

      <div className="workspace-content">
        <header className="app-header">
          <div className="header-inner">
            <Link className="brand header-brand" to="/" aria-label={`${APP_NAME} ana sayfa`}>
              <span className="brand-mark" aria-hidden="true">
                <BrandMark />
              </span>
              <span className="brand-text">
                <strong className="brand-title">{APP_NAME}</strong>
                <span className="brand-subtitle">Kamu personel alım ilanları</span>
              </span>
            </Link>

            <div className="header-current">
              <span>
                Bölüm <Icon name="right" size={13} />
              </span>
              <strong>{current?.label ?? 'Kamuİlan'}</strong>
            </div>

            <div className="header-user">
              <a
                href={SITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="home-site-link"
                title={`${SITE_LABEL} ana sayfasına git`}
              >
                <Icon name="external" size={13} />
                <span>{SITE_LABEL}</span>
              </a>
              {user ? (
                <>
                  <div className="user-profile-summary">
                    <div className="user-avatar-circle" aria-hidden="true">
                      {initials(displayName)}
                    </div>
                    <div className="user-info-text">
                      <strong className="user-full-name">{displayName}</strong>
                      <span className={`user-role-badge ${isAdmin ? 'badge-admin' : 'badge-psy'}`}>
                        {roleLabel}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-logout"
                    onClick={() => {
                      void logout().then(() => navigate('/giris'));
                    }}
                  >
                    Çıkış
                  </button>
                </>
              ) : (
                <div className="header-actions">
                  <button type="button" className="btn-secondary btn-sm" onClick={() => navigate('/giris')}>
                    <Icon name="key" size={15} />
                    <span>Giriş yap</span>
                  </button>
                  <button type="button" className="btn-primary btn-sm" onClick={() => navigate('/panel')}>
                    <Icon name="bell" size={15} />
                    <span>Bildirim kur</span>
                  </button>
                </div>
              )}
            </div>

            <MobileNav
              items={items}
              user={user ? { displayName, roleLabel } : null}
              onLogin={() => navigate('/giris')}
              {...(user
                ? {
                    onLogout: () => {
                      void logout().then(() => navigate('/giris'));
                    },
                  }
                : {})}
            />
          </div>
        </header>

        <StatusBanner />

        <main className="app-main" id="main" tabIndex={-1}>
          {children}
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}

/**
 * Uygulama kapısı: oturum doğrulanmadan kabuk (gezinme + içerik) hiç
 * render edilmez. Oturum yoksa kullanıcı, girişten sonra kaldığı yere
 * dönecek şekilde giriş ekranına yönlendirilir.
 */
function RequireAuthGate({ children }: { children: ReactNode }) {
  const { user, loading, sessionFetching, sessionError, retrySession, publicListings } = useAuth();
  const location = useLocation();
  // Oturum yenilenirken (giriş sonrası tazeleme gibi) kapı karar vermez:
  // eski "oturum yok" bilgisiyle girişe geri atmak kullanıcıyı giriş
  // ekranında takılı bırakırdı. Yenileme bitmeden bekle.
  if (loading || (!user && sessionFetching)) {
    // Bekleme kartı da giriş ekranıyla AYNI ortalanmış yerleşimi kullanır
    // (auth-shell dikey ortalar); aksi halde ekranın sol üst köşesinde belirir.
    return (
      <div className="auth-page">
        <div className="auth-shell">
          <div className="auth-card-wrapper">
            <div className="auth-card loading-state-card" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <h4>Oturum doğrulanıyor…</h4>
              <p>Hesabınız kontrol ediliyor.</p>
            </div>
          </div>
        </div>
        <SiteFooter compact />
      </div>
    );
  }
  if (!user && sessionError) {
    return (
      <div className="auth-page">
        <div className="auth-shell">
          <div className="auth-card-wrapper">
            <div className="auth-card">
              <div className="auth-heading">
                <p className="auth-eyebrow">Oturum</p>
                <h1>Oturum doğrulanamadı</h1>
                <p>Sunucudan yanıt alınamadı; yeniden deneyebilir veya bağlantınızı kontrol edebilirsiniz.</p>
              </div>
              <ErrorNotice
                title="Oturum bilgisi alınamadı"
                message={errorMessage(sessionError)}
                onRetry={() => void retrySession()}
                retryLabel="Yeniden dene"
              />
            </div>
          </div>
        </div>
        <SiteFooter compact />
      </div>
    );
  }
  // Herkese açık vitrin: ilan sayfaları oturumsuz açılır. Panel, kayıtlı ilanlar,
  // geçmiş ve yönetim rotaları kendi `RequiresSession` kapısıyla korunmaya devam eder.
  if (!user && publicListings) return <>{children}</>;
  if (!user) {
    const from = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to="/giris"
        state={{
          from,
          reason:
            'Kamuİlan kapalı bir sistemdir: ilanları görmek için giriş yapın. Hesap, yönetici davetiyle açılır.',
        }}
        replace
      />
    );
  }
  return <>{children}</>;
}

/** Oturum gerektiren sayfalar için giriş kartı (psikologdaki auth kapısı). */
function RequiresSession({ children, reason }: { children: ReactNode; reason: string }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="loading-state-card" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <h4>Oturum doğrulanıyor…</h4>
        <p>Bildirim tercihleriniz hesabınıza bağlıdır.</p>
      </div>
    );
  }
  if (!user) return <LoginPage reason={reason} />;
  return <>{children}</>;
}

export function LoginPageWithReason() {
  const location = useLocation();
  const state = location.state as { reason?: string } | null;
  return <LoginPage reason={state?.reason} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/giris" element={<LoginPageWithReason />} />
      <Route path="/sifremi-unuttum" element={<ForgotPasswordPage />} />
      <Route path="/sifre-sifirla" element={<ResetPasswordPage />} />
      <Route path="/eposta-dogrula" element={<VerifyEmailPage />} />
      {/* Eski doğrulama bağlantıları (/dogrulama) 404'e düşmez. */}
      <Route path="/dogrulama" element={<VerifyEmailPage />} />
      <Route path="/abonelikten-cik" element={<UnsubscribePage />} />
      <Route path={INFO_ROUTES.sss} element={<FaqPage />} />
      <Route path={INFO_ROUTES.gizlilik} element={<PrivacyPage />} />
      <Route path={INFO_ROUTES.kullanim} element={<TermsPage />} />
      <Route
        path="*"
        element={
          <RequireAuthGate>
            <AppShell>
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/ilanlar" element={<JobsPage />} />
                  <Route path="/ilanlar/:id" element={<JobDetailPage />} />
                  <Route path="/kaynaklar" element={<SourcesPage />} />
                  <Route
                    path="/panel"
                    element={
                      <RequiresSession reason="Bildirim tercihleri hesabınıza bağlıdır. Giriş yapın; hesap açmak için yöneticiden davet isteyin.">
                        <PanelPage view="preferences" />
                      </RequiresSession>
                    }
                  />
                  <Route
                    path="/panel/kaydedilenler"
                    element={
                      <RequiresSession reason="Kaydettiğiniz ilanlar hesabınıza bağlıdır. Giriş yapın; hesap açmak için yöneticiden davet isteyin.">
                        <SavedJobsPage />
                      </RequiresSession>
                    }
                  />
                  {/* Eski e-posta bağlantıları: tercih bağlantısı artık /panel. */}
                  <Route path="/panel/bildirimler" element={<Navigate to="/panel" replace />} />
                  <Route
                    path="/panel/gecmis"
                    element={
                      <RequiresSession reason="Bildirim geçmişi hesabınıza bağlıdır. Giriş yapın; hesap açmak için yöneticiden davet isteyin.">
                        <PanelPage view="history" />
                      </RequiresSession>
                    }
                  />
                  <Route
                    path="/yonetim"
                    element={
                      <RequiresSession reason="Yönetim paneli yalnızca yönetici hesaplarına açıktır.">
                        <AdminPage />
                      </RequiresSession>
                    }
                  />
                  <Route path="/404" element={<NotFoundPage />} />
                  <Route path="*" element={<Navigate to="/404" replace />} />
                </Routes>
              </ErrorBoundary>
            </AppShell>
          </RequireAuthGate>
        }
      />
    </Routes>
  );
}
