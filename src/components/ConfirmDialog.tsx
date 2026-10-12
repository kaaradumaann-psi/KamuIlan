import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

/**
 * `window.confirm` yerine geçen erişilebilir doğrulama penceresi.
 * - Odak diyalog açıldığında içeri alınır, kapanınca tetikleyici düğmeye döner.
 * - `aria-modal="true"` ile tutarlı olması için Tab/Shift+Tab diyalog içinde döner.
 * - Esc ve arka plana tıklama iptal eder; diyalog açıkken arka plan kaydırması kilitlenir.
 * - Yıkıcı eylemde düğme kırmızı, metin açık sonuç bildirir (geri alınamaz vb.).
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy = false,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  tone?: 'danger' | 'neutral';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Odağı diyalogdan çıkmadan önce nerede olduğunu hatırla: kapanınca geri ver.
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    // Arka plan kaydırmasını kilitle. Masaüstünde kaydırma çubuğu kaybolurken
    // sayfa kaymasın diye kaydırma çubuğu genişliği kadar iç boşluk bırakılır.
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    const focusables = (): HTMLElement[] => {
      const container = dialogRef.current;
      if (!container) return [];
      const selector = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return [...container.querySelectorAll<HTMLElement>(selector)].filter(element => element.offsetParent !== null);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      // Odak tuzağı: `aria-modal` arka planı gizler, klavye de oraya kaçmamalı.
      const items = focusables();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && !!dialogRef.current?.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={event => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal-container confirm-dialog" ref={dialogRef} role="document">
        <header className="modal-header">
          <div>
            <div className={`badge-chip ${tone === 'danger' ? 'badge-default' : 'badge-primary'}`}>
              <Icon name="alert" size={13} />
              Onay gerekli
            </div>
            <h2 id="confirm-dialog-title">{title}</h2>
            <p className="modal-subtitle">{description}</p>
          </div>
          <button type="button" className="icon-close-btn" onClick={onCancel} disabled={busy} aria-label="Vazgeç">
            <Icon name="close" size={18} />
          </button>
        </header>
        <footer className="modal-footer confirm-footer">
          <button ref={cancelRef} type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'İşleniyor…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
