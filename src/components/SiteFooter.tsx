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
          <ThemeSwitch />
        </nav>
      </div>
    </footer>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Sistem' },
  { value: 'light', label: 'Açık' },
  { value: 'dark', label: 'Koyu' },
];

/** Tema seçici: sistem tercihi varsayılandır; seçim tarayıcıda saklanır. */
export function ThemeSwitch() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  return (
    <label className="theme-switch">
      <span className="theme-switch-label">Tema</span>
      <select
        className="theme-switch-select"
        value={preference}
        onChange={(event) => {
          const next = event.target.value as ThemePreference;
          setPreference(next);
          saveThemePreference(next);
        }}
      >
        {THEME_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
