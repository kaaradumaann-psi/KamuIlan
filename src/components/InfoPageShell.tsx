import type { MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { BrandMark } from './BrandMark';
import { SiteFooter } from './SiteFooter';
import { APP_NAME } from '../site';

type InfoPageShellProps = {
  /** Üst şeritteki sayfa etiketi (kicker). */
  kicker: string;
  title: string;
  /** "Geri dön" hedefi. Verilmezse tarayıcı geçmişine döner. */
  backTo?: string;
  children: ReactNode;
};

/**
 * Bilgi sayfası kabuğu (SSS, Gizlilik & KVKK, Kullanım Koşulları, Kaynaklar):
 * üst şerit + tam sayfa içerik + sitenin tam alt bilgisi. Oturumdan bağımsız
 * açılır; giriş ekranı ve portal ile aynı görünür.
 */
export function InfoPageShell({ kicker, title, backTo, children }: InfoPageShellProps) {
  const navigate = useNavigate();

  return (
    <div className="info-shell">
      <a className="skip-link" href="#main">
        Ana içeriğe atla
      </a>
      <header className="info-topbar">
        <div className="info-topbar-inner">
          <a
            className="info-brand"
            href="/"
            aria-label={`${APP_NAME} ana sayfa`}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              navigate('/');
            }}
          >
            <span className="info-brand-mark" aria-hidden="true">
              <BrandMark />
            </span>
            <span className="info-brand-text">
              <strong>{APP_NAME}</strong>
              <small>Kamu ilanı takip sistemi</small>
            </span>
          </a>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              if (backTo) navigate(backTo);
              else navigate(-1);
            }}
          >
            <Icon name="left" size={14} />
            <span>Geri dön</span>
          </button>
        </div>
      </header>

      <main className="info-main" id="main">
        <div className="info-container">
          <header className="info-page-head">
            <span className="info-kicker">{kicker}</span>
            <h1 className="info-title">{title}</h1>
          </header>
          {children}
        </div>
      </main>

      <SiteFooter compact />
    </div>
  );
}
