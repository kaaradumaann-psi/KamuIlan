import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { BrandMark } from './BrandMark';
import { APP_NAME, CONTACT_EMAIL, COPYRIGHT_HOLDER, COPYRIGHT_YEAR, SITE_LABEL, SITE_URL } from '../site';
import { readThemePreference, saveThemePreference, type ThemePreference } from './theme';

/** Alt bilgide ve mobil menüde kullanılan site sayfaları. */
export const INFO_ROUTES = {
  sss: '/sss',
  gizlilik: '/gizlilik',
  kullanim: '/kullanim',
  kaynaklar: '/kaynaklar',
} as const;

type SiteFooterProps = {
  /** Tanıtım sayfasındaki birincil eylem (ör. "İlanları ara"). */
  onPrimaryAction?: (event: MouseEvent<HTMLAnchorElement>) => void;
  primaryActionLabel?: string;
  primaryActionHref?: string;
  /** Mobil/ara sayfa: yalnızca ince şerit. */
  compact?: boolean;
};

/**
 * Site alt bilgisi — psikolog/MMPI ile aynı iskelet (`.site-footer*`).
 *
 * Alt bilgide uzun feragat paragrafı yoktur: "resmî ilanı kontrol edin" notu
 * yalnızca ilan detayında, kapsam notu yalnızca SSS'de bir kez yazılır.
 */
export function SiteFooter({
  onPrimaryAction,
  primaryActionLabel = 'İlanları ara',
  primaryActionHref = '/ilanlar',
  compact,
}: SiteFooterProps) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-left">
          <span className="site-footer-mark" aria-hidden="true">
            <BrandMark size={14} />
          </span>
          <span className="site-footer-copyright">
            © {COPYRIGHT_YEAR} <b>{COPYRIGHT_HOLDER}</b>
          </span>
          {!compact && (
            <>
              <span className="site-footer-sep" aria-hidden="true">
                ·
              </span>
              <span className="site-footer-meta">{APP_NAME} kamu ilanı takip sistemi</span>
            </>
          )}
        </div>

        <nav className="site-footer-nav" aria-label="Site sayfaları">
          <Link className="site-footer-link" to={primaryActionHref} onClick={onPrimaryAction}>
            {primaryActionLabel}
          </Link>
          <Link className="site-footer-link" to={INFO_ROUTES.sss}>
            SSS
          </Link>
          <Link className="site-footer-link" to={INFO_ROUTES.gizlilik}>
            Gizlilik
          </Link>
          <Link className="site-footer-link" to={INFO_ROUTES.kullanim}>
            Kullanım
          </Link>
          <Link className="site-footer-link" to={INFO_ROUTES.kaynaklar}>
            İlan kaynakları
          </Link>
          <span className="site-footer-sep" aria-hidden="true">
            ·
          </span>
          <a
            className="site-footer-link site-footer-link-external"
            href={SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>{SITE_LABEL}</span>
            <Icon name="external" size={10} />
          </a>
          <a className="site-footer-link site-footer-link-muted" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </nav>
      </div>
    </footer>
  );
}

/**
 * Sağ üst köşedeki tema düğmesi: açık ↔ koyu. Karanlık mod isteğe bağlıdır; seçim tarayıcıda saklanır.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const dark = preference === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={dark}
      aria-label={dark ? 'Açık temaya geç' : 'Karanlık moda geç'}
      title={dark ? 'Açık temaya geç' : 'Karanlık moda geç'}
      onClick={() => {
        const next: ThemePreference = dark ? 'light' : 'dark';
        setPreference(next);
        saveThemePreference(next);
      }}
    >
      <Icon name={dark ? 'sun' : 'moon'} size={17} />
    </button>
  );
}
