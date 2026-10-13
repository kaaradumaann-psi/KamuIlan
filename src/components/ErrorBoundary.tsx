/**
 * Render hata sınırı.
 *
 * Tek bir sayfadaki beklenmeyen render hatası tüm uygulamayı beyaz ekrana
 * düşürmemelidir: hata burada yakalanır, kullanıcıya kurtarılabilir bir kart
 * gösterilir ve kabuk (gezinme, başlık) ayakta kalır. Hata ayrıntısı yalnızca
 * konsola yazılır; kullanıcıya teknik iz gösterilmez.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Değiştiğinde hata durumu sıfırlanır (rota anahtarı). */
  resetKey: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Tanı için konsol kaydı; arayüzde teknik ayrıntı gösterilmez.
    console.error('[kamuilan] sayfa render hatası:', error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="loading-state-card" role="alert">
          <h4>Bu sayfa görüntülenirken bir hata oluştu.</h4>
          <p>
            Diğer bölümler çalışmaya devam ediyor. Sayfayı yenilemeyi deneyin; sorun sürerse yöneticiye
            bildirin.
          </p>
          <button type="button" className="btn-primary btn-sm" onClick={() => window.location.reload()}>
            Sayfayı yenile
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Rota değişiminde kendini sıfırlayan hata sınırı. */
export function ErrorBoundary({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation();
  return <ErrorBoundaryInner resetKey={location.pathname}>{children}</ErrorBoundaryInner>;
}
