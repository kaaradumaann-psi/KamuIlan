/**
 * Kimlik sayfaları: kayıt, giriş, e-posta doğrulama, şifre sıfırlama.
 *
 * Erişilebilirlik: her alan etiketlidir, hatalar `role="alert"` ile duyurulur,
 * formlar Enter ile gönderilebilir. Parola kuralları gönderimden önce gösterilir.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { Card, ErrorNotice, Field, InfoNote } from '../components/ui';

function useAfterAuth(): () => void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['session'] });
    navigate('/panel');
  };
}

export function LoginPage(): ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const afterAuth = useAfterAuth();

  const mutation = useMutation({
    mutationFn: () => api.post<{ needsEmailVerification: boolean }>('/api/auth/login', { email, password }),
    onSuccess: (data) => {
      setError(null);
      if (data.needsEmailVerification) {
        setNeedsVerification(true);
        return;
      }
      afterAuth();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Card title="Giriş yap" description="Bildirim tercihlerinizi yönetmek için oturum açın.">
        <form
          className="space-y-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="E-posta" htmlFor="login-email" required>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Parola" htmlFor="login-password" required>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error && <ErrorNotice message={error} />}
          {needsVerification && (
            <InfoNote tone="warning">
              E-posta adresiniz doğrulanmamış. Doğrulama bağlantısını tekrar göndermek için{' '}
              <Link to={`/dogrulama-gonder?email=${encodeURIComponent(email)}`}>buraya tıklayın</Link>.
            </InfoNote>
          )}
          <button type="submit" className="btn-primary w-full" disabled={mutation.isPending}>
            {mutation.isPending ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>
        <p className="mt-3 text-sm">
          Hesabınız yok mu? <Link to="/kayit">Kayıt olun</Link> · <Link to="/sifremi-unuttum">Parolamı unuttum</Link>
        </p>
      </Card>
    </div>
  );
}

export function RegisterPage(): ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ verificationEmailMasked: string; message: string }>('/api/auth/register', {
        email,
        password,
        ...(displayName ? { displayName } : {}),
        consent,
      }),
    onSuccess: () => {
      setError(null);
      setDone(true);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (done) {
    return (
      <div className="mx-auto max-w-md">
        <Card title="Kayıt alındı">
          <InfoNote>
            Doğrulama bağlantısı e-posta adresinize gönderildi. Bildirimler yalnızca adres doğrulandıktan sonra gönderilir.
            Geliştirme ortamında postalar yerel posta kutusunda görünür (varsayılan: http://localhost:1080).
          </InfoNote>
          <p className="mt-3 text-sm">
            <Link to="/giris">Giriş sayfasına dön</Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <Card title="Kayıt ol" description="Yalnızca e-posta ve parola; başka kişisel veri istenmez (KVKK veri minimizasyonu).">
        <form
          className="space-y-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="Görünen ad (isteğe bağlı)" htmlFor="register-name">
            <input id="register-name" className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="E-posta" htmlFor="register-email" required>
            <input
              id="register-email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field
            label="Parola"
            htmlFor="register-password"
            required
            hint="En az 10 karakter, bir büyük ve bir küçük harf ile bir rakam içermeli."
          >
            <input
              id="register-password"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>
              Kişisel verilerimin yalnızca ilan bildirimi amacıyla işlenmesine ilişkin aydınlatma metnini okudum ve onaylıyorum.
            </span>
          </label>
          {error && <ErrorNotice message={error} />}
          <button type="submit" className="btn-primary w-full" disabled={mutation.isPending || !consent}>
            {mutation.isPending ? 'Kayıt yapılıyor…' : 'Kayıt ol'}
          </button>
        </form>
        <p className="mt-3 text-sm">
          Zaten hesabınız var mı? <Link to="/giris">Giriş yapın</Link>
        </p>
      </Card>
    </div>
  );
}

export function VerifyEmailPage(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/verify-email', { token }),
    onSuccess: (data) => {
      setStatus('done');
      setMessage(data.message);
    },
    onError: (caught) => {
      setStatus('error');
      setMessage(errorMessage(caught));
    },
  });

  return (
    <div className="mx-auto max-w-md">
      <Card title="E-posta doğrulama">
        {!token && <InfoNote tone="warning">Bağlantıda doğrulama jetonu bulunamadı. E-postadaki bağlantıyı kullanın.</InfoNote>}
        {token && status === 'idle' && (
          <>
            <p className="text-sm">Adresinizi doğrulamak için aşağıdaki düğmeye basın.</p>
            <button type="button" className="btn-primary mt-3" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending ? 'Doğrulanıyor…' : 'E-postamı doğrula'}
            </button>
          </>
        )}
        {status === 'done' && (
          <InfoNote>
            {message} <Link to="/panel">Panelime git</Link>
          </InfoNote>
        )}
        {status === 'error' && <ErrorNotice message={message} />}
      </Card>
    </div>
  );
}

export function ResendVerificationPage(): ReactNode {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [sent, setSent] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/resend-verification', { email }),
    onSuccess: () => setSent(true),
  });

  return (
    <div className="mx-auto max-w-md">
      <Card title="Doğrulama e-postasını yeniden gönder">
        <form
          className="space-y-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="E-posta" htmlFor="resend-email" required>
            <input id="resend-email" className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <button type="submit" className="btn-primary w-full" disabled={mutation.isPending}>
            Gönder
          </button>
        </form>
        {sent && <InfoNote>Adres kayıtlıysa doğrulama bağlantısı gönderildi.</InfoNote>}
      </Card>
    </div>
  );
}

export function ForgotPasswordPage(): ReactNode {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/forgot-password', { email }),
    onSuccess: () => setSent(true),
  });

  return (
    <div className="mx-auto max-w-md">
      <Card title="Parolamı unuttum">
        <form
          className="space-y-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="E-posta" htmlFor="forgot-email" required>
            <input id="forgot-email" className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <button type="submit" className="btn-primary w-full" disabled={mutation.isPending}>
            Sıfırlama bağlantısı gönder
          </button>
        </form>
        {sent && <InfoNote>Adres kayıtlıysa sıfırlama bağlantısı gönderildi. Bağlantı 60 dakika geçerlidir.</InfoNote>}
      </Card>
    </div>
  );
}

export function ResetPasswordPage(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/reset-password', { token, password }),
    onSuccess: (data) => {
      setMessage(data.message);
      setTimeout(() => navigate('/giris'), 2_500);
    },
    onError: (caught) => setMessage(errorMessage(caught)),
  });

  return (
    <div className="mx-auto max-w-md">
      <Card title="Yeni parola belirle">
        {!token && <InfoNote tone="warning">Bağlantıda jeton bulunamadı.</InfoNote>}
        <form
          className="space-y-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="Yeni parola" htmlFor="reset-password" required hint="En az 10 karakter; büyük/küçük harf ve rakam.">
            <input
              id="reset-password"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <button type="submit" className="btn-primary w-full" disabled={mutation.isPending || token === ''}>
            Parolayı güncelle
          </button>
        </form>
        {message && <InfoNote>{message}</InfoNote>}
      </Card>
    </div>
  );
}

export function UnsubscribePage(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/unsubscribe', { token }),
    onSuccess: (data) => {
      setStatus('done');
      setMessage(data.message);
    },
    onError: (caught) => {
      setStatus('error');
      setMessage(errorMessage(caught));
    },
  });

  return (
    <div className="mx-auto max-w-md">
      <Card title="Bildirimlerden çık">
        {status === 'idle' && (
          <>
            <p className="text-sm">Bildirim e-postalarını almayı durdurmak için onaylayın. Hesabınız silinmez.</p>
            <button type="button" className="btn-primary mt-3" onClick={() => mutation.mutate()} disabled={mutation.isPending || token === ''}>
              Bildirimleri durdur
            </button>
          </>
        )}
        {status === 'done' && <InfoNote>{message}</InfoNote>}
        {status === 'error' && <ErrorNotice message={message} />}
      </Card>
    </div>
  );
}
