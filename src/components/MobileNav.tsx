import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { INFO_ROUTES } from './SiteFooter';
import { SITE_LABEL, SITE_URL } from '../site';

export type MobileNavItem = {
  id: string;
  label: string;
  icon: IconName;
  active: boolean;
  onSelect: () => void;
};

type MobileNavProps = {
  items: MobileNavItem[];
  /** Oturum açıkken gösterilen kullanıcı şeridi. */
  user?: { displayName: string; roleLabel: string } | null;
  onLogin?: () => void;
  onLogout?: () => void;
};

/** Baş harfler: ad/soyad yoksa e-posta kökünden türetilir. */
function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(parts[0] ?? '').charAt(0)}${(parts[parts.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

/**
 * Başlığın altında açılan kompakt gezinme paneli (dar ekran).
 *
 * Geniş ekranda kalıcı çalışma alanı gezinmesi vardır. Dar ekranda sağ üstteki
 * düğme menüyü açar; panel ekranı kaplamaz, başlığın altına yaslanır ve yüksekliği
 * ekranı aşmaz (uzun liste panel içinde kayar, alt şerit yapışık kalır).
 *
 * Erişilebilirlik: `role="dialog"` + `aria-modal`, Escape ve arka plana tıklama
 * ile kapanma, açılışta odak kapatma düğmesine gider, Tab panel içinde döngüde
 * kalır, kapanışta odak tetikleyiciye döner; menü açıkken arka plan kaydırması
 * kilitlenir. Rota değişiminde kendiliğinden kapanır.
 */
export function MobileNav({ items, user, onLogin, onLogout }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Rota değiştiğinde menüyü kapat (SPA gezinmesi dahil).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>('button, a[href]');
      if (!focusables || focusables.length < 2) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panelRef.current?.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      toggleRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        ref={toggleRef}
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label="Menüyü aç"
        onClick={() => setOpen(true)}
      >
        <Icon name="menu" size={22} />
      </button>

      {open &&
        createPortal(
          <>
            <div className="mobile-nav-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
            <div
              ref={panelRef}
              className="mobile-nav-panel"
              id="mobile-nav-panel"
              role="dialog"
              aria-modal="true"
              aria-label="Gezinme menüsü"
            >
              <div className="mobile-nav-head">
                <span className="mobile-nav-title">Menü</span>
                <button
                  type="button"
                  ref={closeRef}
                  className="nav-close"
                  aria-label="Menüyü kapat"
                  onClick={() => setOpen(false)}
                >
                  <Icon name="close" size={20} />
                </button>
              </div>

              <nav className="mobile-nav-body" aria-label="Site ve hesap menüsü">
                <span className="mobile-nav-kicker" id="mobile-nav-group-site">
                  Kamuİlan
                </span>
                <div className="mobile-nav-group" role="group" aria-labelledby="mobile-nav-group-site">
                  {items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`mobile-nav-link ${item.active ? 'active' : ''}`}
                      aria-current={item.active ? 'page' : undefined}
                      onClick={() => {
                        setOpen(false);
                        item.onSelect();
                      }}
                    >
                      <Icon name={item.icon} size={18} />
                      <span>{item.label}</span>
                      {item.active && <span className="mobile-nav-current">Açık</span>}
                    </button>
                  ))}
                </div>

                <span className="mobile-nav-kicker" id="mobile-nav-group-info">
                  Bilgi
                </span>
                <div className="mobile-nav-group" role="group" aria-labelledby="mobile-nav-group-info">
                  <a className="mobile-nav-link" href={INFO_ROUTES.kaynaklar} onClick={() => setOpen(false)}>
                    <Icon name="list" size={18} />
                    <span>İlan kaynakları</span>
                  </a>
                  <a className="mobile-nav-link" href={INFO_ROUTES.sss} onClick={() => setOpen(false)}>
                    <Icon name="info" size={18} />
                    <span>Sıkça sorulan sorular</span>
                  </a>
                  <a className="mobile-nav-link" href={INFO_ROUTES.gizlilik} onClick={() => setOpen(false)}>
                    <Icon name="shield" size={18} />
                    <span>Gizlilik</span>
                  </a>
                  <a className="mobile-nav-link" href={INFO_ROUTES.kullanim} onClick={() => setOpen(false)}>
                    <Icon name="file" size={18} />
                    <span>Kullanım koşulları</span>
                  </a>
                  <a
                    className="mobile-nav-link mobile-nav-link-wide"
                    href={SITE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpen(false)}
                  >
                    <Icon name="external" size={18} />
                    <span>{SITE_LABEL}</span>
                  </a>
                </div>
              </nav>

              <div className="mobile-nav-foot">
                {user ? (
                  <>
                    <div className="user-profile-summary">
                      <div className="user-avatar-circle" aria-hidden="true">
                        {initials(user.displayName)}
                      </div>
                      <div className="user-info-text">
                        <strong className="user-full-name">{user.displayName}</strong>
                        <span className="user-role-badge badge-default">{user.roleLabel}</span>
                      </div>
                    </div>
                    {onLogout && (
                      <button
                        type="button"
                        className="btn-logout"
                        onClick={() => {
                          setOpen(false);
                          onLogout();
                        }}
                      >
                        <span>Çıkış</span>
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div className="user-profile-summary">
                      <div className="user-avatar-circle" aria-hidden="true">
                        <Icon name="user" size={16} />
                      </div>
                      <div className="user-info-text">
                        <strong className="user-full-name">Oturum kapalı</strong>
                        <span className="user-role-badge badge-default">Ziyaretçi</span>
                      </div>
                    </div>
                    {onLogin && (
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        onClick={() => {
                          setOpen(false);
                          onLogin();
                        }}
                      >
                        <Icon name="key" size={15} />
                        <span>Giriş yap</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        setOpen(false);
                        navigate('/panel');
                      }}
                    >
                      <Icon name="bell" size={15} />
                      <span>Bildirimler</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
