/**
 * Kimlik ve bilgi sayfaları.
 *
 * ÖNEMLİ: Kamuİlan'da DIŞARIDAN KAYIT YOKTUR. Hesap yalnızca yönetici davetiyle
 * açılır; bu yüzden giriş ekranında "kayıt ol" bağlantısı bulunmaz ve kayıt ucu
 * sunucuda varsayılan olarak kapalıdır (ALLOW_PUBLIC_REGISTRATION=0).
 *
 * Erişilebilirlik: her alan etiketlidir, hatalar `role="alert"` ile duyurulur,
 * formlar Enter ile gönderilebilir; parola kuralları gönderimden önce yazılır.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { Card, ErrorNotice, Field, InfoNote } from '../components/ui';
import { Icon } from '../components/Icon';
import { InfoPageShell } from '../components/InfoPageShell';
import { PolicyDoc, PolicyList } from '../components/PolicyDoc';
import { APP_DOMAIN, APP_NAME, CONTACT_EMAIL, HONESTY_NOTE, POLICY_EFFECTIVE_DATE, SITE_URL } from '../site';

function useAfterAuth(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  return async () => {
    // ÖNCE oturum bilgisini tazele, SONRA yönlendir. Aksi halde giriş kapısı
    // eski "oturum yok" bilgisiyle kullanıcıyı geri giriş ekranına atar
    // (giriş başarılı olduğu halde sayfada kalma hatası).
    await queryClient.refetchQueries({ queryKey: ['session'] });
    const state = location.state as { from?: string } | null;
    navigate(state?.from && state.from.startsWith('/') ? state.from : '/', { replace: true });
  };
}

export function LoginPage({ reason }: { reason?: string } = {}): ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const afterAuth = useAfterAuth();

  const mutation = useMutation({
    mutationFn: () => api.post<{ needsEmailVerification: boolean }>('/api/auth/login', { email, password }),
    onSuccess: (data) => {
      setError(null);
      if (data.needsEmailVerification) {
        setNeedsVerification(true);
        return;
      }
      void afterAuth();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const resend = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/resend-verification', { email }),
    onSuccess: (data) => setNotice(data.message),
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-intro">
          <span className="auth-eyebrow">Oturum</span>
          <h1 className="auth-heading">Giriş yap</h1>
          <p className="text-muted-sm">
            Kamuİlan kapalı bir takip sistemidir: ilanları, kaynakları ve bildirimlerinizi görmek için oturum
            açın.
          </p>
        </div>

        {reason && (
          <InfoNote tone="info" title="Neden giriş gerekiyor?">
            {reason}
          </InfoNote>
        )}

        <form
          className="auth-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="E-posta" htmlFor="login-email" required>
            <input
              id="login-email"
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
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error && <ErrorNotice message={error} />}
          {notice && <InfoNote tone="success">{notice}</InfoNote>}
          {needsVerification && (
            <InfoNote tone="warning" title="E-posta doğrulanmamış">
              Bildirim gönderebilmek için önce e-posta adresinizi doğrulamanız gerekir.{' '}
              <button
                type="button"
                className="board-text-link"
                onClick={() => resend.mutate()}
                disabled={resend.isPending}
              >
                {resend.isPending ? 'Gönderiliyor…' : 'Doğrulama bağlantısını yeniden gönder'}
              </button>
            </InfoNote>
          )}

          <button type="submit" className="btn-primary auth-submit-btn" disabled={mutation.isPending}>
            <Icon name="key" size={16} />
            <span>{mutation.isPending ? 'Giriş yapılıyor…' : 'Giriş yap'}</span>
          </button>
        </form>

        <div className="auth-footer-help">
          <Link to="/sifremi-unuttum">Parolamı unuttum</Link>
        </div>

        <InfoNote tone="info" title="Halka açık kayıt yoktur">
          Hesabınız yönetici tarafından açılır. Davet e-postası size ulaştığında parolanızı belirleyip giriş
          yapabilirsiniz. Kendi kendine kayıt kapalıdır.
        </InfoNote>

        <div className="auth-site-return">
          <a href={`https://${APP_DOMAIN}`}>{APP_DOMAIN}</a>
          <span className="site-footer-sep" />
          <a href={SITE_URL}>{SITE_URL.replace('https://', '')}</a>
        </div>
      </div>
    </div>
  );
}

export function ForgotPasswordPage(): ReactNode {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/forgot-password', { email }),
    onSuccess: (data) => {
      setError(null);
      setSent(data.message);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <InfoPageShell kicker="Şifre işlemleri" title="Parolamı unuttum" backTo="/giris">
      <Card description="Kayıtlı e-posta adresinize tek kullanımlık sıfırlama bağlantısı gönderilir.">
        <form
          className="auth-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="E-posta" htmlFor="forgot-email" required hint="Hesabın açıldığı adres.">
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          {error && <ErrorNotice message={error} />}
          {sent && <InfoNote tone="success">{sent}</InfoNote>}
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            <Icon name="mail" size={15} />
            <span>{mutation.isPending ? 'Gönderiliyor…' : 'Sıfırlama bağlantısı gönder'}</span>
          </button>
        </form>
        <InfoNote title="Güvenlik">
          Adresin kayıtlı olup olmadığını dışarıya sızdırmamak için yanıt her durumda aynıdır: bağlantı
          yalnızca adres kayıtlıysa gönderilir.
        </InfoNote>
      </Card>
    </InfoPageShell>
  );
}

export function ResetPasswordPage(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/reset-password', { token, password }),
    onSuccess: (data) => {
      setError(null);
      setDone(data.message);
      window.setTimeout(() => navigate('/giris'), 2500);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (!token) {
    return (
      <InfoPageShell kicker="Şifre işlemleri" title="Bağlantı eksik" backTo="/giris">
        <InfoNote tone="warning" title="Bağlantı geçersiz">
          Bu bağlantı eksik açılmış görünüyor. E-postadaki bağlantının tamamını açtığınızdan emin olun;
          gerekirse "parolamı unuttum" adımını yeniden kullanın.
        </InfoNote>
      </InfoPageShell>
    );
  }

  return (
    <InfoPageShell kicker="Şifre işlemleri" title="Yeni parola belirle" backTo="/giris">
      <Card description="Parola en az 10 karakter olmalı; kısa ya da bilinen parolalar reddedilir.">
        <form
          className="auth-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (password !== passwordRepeat) {
              setError('Parolalar eşleşmiyor.');
              return;
            }
            if (password.length < 10) {
              setError('Parola en az 10 karakter olmalı.');
              return;
            }
            mutation.mutate();
          }}
        >
          <Field label="Yeni parola" htmlFor="reset-password" required>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label="Yeni parola (tekrar)" htmlFor="reset-password-2" required>
            <input
              id="reset-password-2"
              type="password"
              autoComplete="new-password"
              required
              value={passwordRepeat}
              onChange={(event) => setPasswordRepeat(event.target.value)}
            />
          </Field>
          {error && <ErrorNotice message={error} />}
          {done && <InfoNote tone="success">{`${done} Giriş ekranına yönlendiriliyorsunuz…`}</InfoNote>}
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            <Icon name="check" size={15} />
            <span>{mutation.isPending ? 'Kaydediliyor…' : 'Parolayı değiştir'}</span>
          </button>
        </form>
      </Card>
    </InfoPageShell>
  );
}

export function VerifyEmailPage(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'idle' | 'done'>('idle');

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/verify-email', { token }),
    onSuccess: () => setState('done'),
  });

  return (
    <InfoPageShell kicker="E-posta" title="E-posta doğrulama" backTo="/giris">
      <Card>
        {!token && (
          <InfoNote tone="warning" title="Bağlantı eksik">
            Bu bağlantı eksik açılmış görünüyor. Giriş ekranından yeni doğrulama bağlantısı isteyebilirsiniz.
          </InfoNote>
        )}
        {token && state === 'idle' && (
          <div className="page-stack">
            <p>
              Doğrulama bağlantısı hazır. Onaylamak için düğmeye basın; bildirimler yalnızca doğrulanmış
              adreslere gönderilir.
            </p>
            <div className="filter-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                <Icon name="check" size={15} />
                <span>{mutation.isPending ? 'Doğrulanıyor…' : 'E-postamı doğrula'}</span>
              </button>
              <Link className="btn-secondary" to="/giris">
                Giriş ekranına dön
              </Link>
            </div>
            {mutation.isError && <ErrorNotice message={errorMessage(mutation.error)} />}
          </div>
        )}
        {state === 'done' && (
          <InfoNote tone="success" title="Adres doğrulandı">
            Artık kriterlerinize uyan ilanları e-posta ile alabilirsiniz.{' '}
            <Link to="/panel">Bildirim tercihlerine gidin.</Link>
          </InfoNote>
        )}
      </Card>
    </InfoPageShell>
  );
}

export function UnsubscribePage(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'idle' | 'done'>('idle');

  const mutation = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/auth/unsubscribe', { token }),
    onSuccess: () => setState('done'),
  });

  return (
    <InfoPageShell kicker="Bildirimler" title="Bildirimden çıkma" backTo="/">
      <Card>
        {!token && (
          <InfoNote tone="warning" title="Bağlantı eksik">
            E-postadaki "Bildirimlerden çık" bağlantısının tamamını açın. Çıkma işlemi jetonludur; jeton yoksa
            işlem yapılmaz.
          </InfoNote>
        )}
        {token && state === 'idle' && (
          <div className="page-stack">
            <p>
              Bu bağlantı, ilan bildirimlerini durdurur. Hesabınız ve bildirim geçmişiniz silinmez;
              tercihlerinizi sonra yeniden açabilirsiniz.
            </p>
            <div className="filter-actions">
              <button
                type="button"
                className="btn-danger"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                <Icon name="bell" size={15} />
                <span>{mutation.isPending ? 'İşleniyor…' : 'Bildirimleri durdur'}</span>
              </button>
              <Link className="btn-secondary" to="/">
                Vazgeç
              </Link>
            </div>
            {mutation.isError && <ErrorNotice message={errorMessage(mutation.error)} />}
          </div>
        )}
        {state === 'done' && (
          <InfoNote tone="success" title="Bildirimler durduruldu">
            Artık ilan bildirimi gönderilmeyecek. Bildirim tercihleri panelinden yeniden açabilirsiniz.
          </InfoNote>
        )}
      </Card>
    </InfoPageShell>
  );
}

export function NotFoundPage(): ReactNode {
  return (
    <InfoPageShell kicker="404" title="Sayfa bulunamadı" backTo="/">
      <Card>
        <p>
          Aradığınız sayfa yok ya da taşınmış olabilir. İlanlara göz atabilir veya kaynak kapsamını
          inceleyebilirsiniz.
        </p>
        <div className="filter-actions">
          <Link className="btn-primary" to="/ilanlar">
            <Icon name="search" size={15} />
            <span>İlanlarda ara</span>
          </Link>
          <Link className="btn-secondary" to="/kaynaklar">
            <Icon name="list" size={15} />
            <span>Kaynaklar ve kapsam</span>
          </Link>
        </div>
      </Card>
    </InfoPageShell>
  );
}

const FAQ: { question: string; answer: ReactNode }[] = [
  {
    question: 'Kamuİlan tüm kamu ilanlarını topluyor mu?',
    answer: (
      <>
        Hayır ve bunu iddia etmiyoruz. Bazı kurumlar ilanlarını yalnızca kendi sayfalarında yayımlar; bir
        kısmı da yalnızca haftalık yayımlanan resmî bültenlerde çıkar. Kaynaklar sayfasında hangi kaynağın
        canlı doğrulandığı, hangisinin planlandığı ve son başarılı taramanın ne zaman olduğu yazılıdır.{' '}
        {HONESTY_NOTE}
      </>
    ),
  },
  {
    question: 'İlan bilgileri nereden geliyor?',
    answer: (
      <>
        Yalnızca resmî kaynaklardan: Resmî Gazete, ilan.gov.tr, ÖSYM, İŞKUR ve kurumların kendi ilan
        sayfaları. Her kaydın altında kaynak bağlantıları ve son doğrulama zamanı gösterilir. Uydurma veya
        elle üretilmiş ilan yayımlanmaz; örnek/demo verisi varsa arayüzde açıkça "örnek veri" olarak
        işaretlenir.
      </>
    ),
  },
  {
    question: 'Bilgiler ne sıklıkla güncelleniyor?',
    answer: (
      <>
        Kurum sayfalarını düzenli aralıklarla yoklarız; siz sayfayı kapatsanız bile kontroller sürer. Her
        kaynağa ne sıklıkla baktığımız, "İlan kaynakları" sayfasında kaynağın yanında yazar.
      </>
    ),
  },
  {
    question: 'Bir ilan birden fazla kaynakta çıkarsa ne olur?',
    answer: (
      <>
        Aynı ilanı tek kez gösteririz ama yayımlandığı bütün adresleri ilanda sıralarız. Benzer başlıklı
        farklı ilanları birleştirmeyiz; aynı ilan olup olmadığından emin olamadıklarımızı bir insan
        gözden geçirir.
      </>
    ),
  },
  {
    question: 'Başvuru bağlantısı neden boş olabiliyor?',
    answer: (
      <>
        Çünkü ilan metninde başvuru adresi yazmıyorsa sistem bağlantı üretmez. Başvuru linki hiçbir zaman
        tahmin edilmez; yalnızca kaynakta açıkça verilen adres gösterilir. Böyle durumlarda resmî ilan
        bağlantısını açıp ayrıntıları kaynaktan okumanız gerekir.
      </>
    ),
  },
  {
    question: 'Hesap nasıl açılır?',
    answer: (
      <>
        Halka açık kayıt yoktur. Hesap yalnızca yönetici tarafından açılır: size bir davet e-postası gelir,
        parolanızı kendiniz belirlersiniz. İlan aramak ve ilan detaylarını okumak için hesap gerekmez.
      </>
    ),
  },
  {
    question: 'Bildirimler nasıl çalışıyor?',
    answer: (
      <>
        Kaydettiğiniz kriterlere (unvan, kurum, il, istihdam türü, eğitim, KPSS puanı, son başvuruya kalan
        gün, anahtar kelimeler) uyan yeni ilanlar ve değişiklikler e-posta ile gönderilir. Aynı ilan için
        tekrar tekrar bildirim gitmez; her e-posta ilgili ilan sürümü ve eşleşme gerekçesiyle birlikte kayda
        geçer.
      </>
    ),
  },
  {
    question: 'Bildirim e-postası gelmezse ne olur?',
    answer: (
      <>
        E-postayı gönderdiğimiz anda gönderim geçmişinizde görürsünüz. Yine de e-postanın gelen
        kutunuza ulaşması sağlayıcınıza bağlıdır; bulamazsanız spam/önemsiz klasörünü de kontrol edin.
        Ulaşmayan e-postayı birkaç kez yeniden deneriz.
      </>
    ),
  },
  {
    question: 'Verilerim nasıl korunuyor?',
    answer: (
      <>
        Parolanız okunamayacak biçimde saklanır; sizin dışınızda kimse göremez. E-posta adresiniz yalnızca
        size haber vermek için kullanılır, kimseyle paylaşılmaz. Ayrıntılar Gizlilik sayfasındadır.
      </>
    ),
  },
  {
    question: 'Bir ilan hatalı görünüyorsa ne yapmalıyım?',
    answer: (
      <>
        Önce resmî kaynağı kontrol edin: bağlayıcı olan kaynaktır. Kayıt gerçekten hatalıysa ilan detayındaki
        resmî bağlantı ve ilan numarasıyla birlikte {CONTACT_EMAIL} adresine yazabilirsiniz; düzeltme inceleme
        kuyruğuna alınır.
      </>
    ),
  },
];

export function FaqPage(): ReactNode {
  return (
    <InfoPageShell kicker="Yardım" title="Sıkça sorulan sorular" backTo="/">
      <div className="faq-page">
        {FAQ.map((item, index) => (
          <section className="faq-item" key={item.question} id={`soru-${index + 1}`}>
            <h2 className="faq-question">{item.question}</h2>
            <div className="faq-answer">{item.answer}</div>
          </section>
        ))}
      </div>
      <InfoNote tone="info" title="Kapsam">
        {HONESTY_NOTE} Sorunuz listede yoksa {CONTACT_EMAIL} adresine yazabilirsiniz.
      </InfoNote>
    </InfoPageShell>
  );
}

export function PrivacyPage(): ReactNode {
  return (
    <InfoPageShell kicker="Gizlilik" title="Gizlilik ve KVKK Politikası" backTo="/">
      <PolicyDoc
        lede={`${APP_NAME}, ${APP_DOMAIN} adresinde yayımlanan açık bir kamu ilanı takip sistemidir. Bu politika, hangi verilerin işlendiğini, neden işlendiğini, ne kadar saklandığını ve haklarınızı açıklar. Yürürlük: ${POLICY_EFFECTIVE_DATE}.`}
        sections={[
          {
            id: 'veri-sorumlusu',
            title: 'Veri sorumlusu ve kapsam',
            body: (
              <>
                <p>
                  Sistem, kamu personel alım ilanlarını resmî kaynaklardan toplar ve yayımlar. Bu ilanların
                  içeriğinde kişisel veri bulunmaz; ilanlar kurumların kamuya açık duyurularıdır.
                </p>
                <p>
                  Kişisel veri, yalnızca bildirim hizmetini kullanan hesaplarda işlenir: e-posta adresi,
                  görünen ad (isteğe bağlı), parola özeti, oturum kayıtları, bildirim tercihleri ve gönderim
                  geçmişi.
                </p>
              </>
            ),
          },
          {
            id: 'islenen-veriler',
            title: 'İşlenen veriler ve amaçları',
            body: (
              <PolicyList
                items={[
                  <>
                    <strong>Hesap verileri:</strong> e-posta adresi, isteğe bağlı görünen ad, parola özeti ve
                    tuzu. Amaç: oturum açma ve bildirim gönderimi.
                  </>,
                  <>
                    <strong>Tercih verileri:</strong> unvan, kurum, il, istihdam türü, eğitim düzeyi, bölüm,
                    KPSS türü ve taban puanı, son başvuruya kalan gün, anahtar kelimeler. Amaç: yalnızca size
                    uygun ilanları bildirmek.
                  </>,
                  <>
                    <strong>Kayıt/denetim verileri:</strong> oturum açma zamanı, bildirim gönderim kayıtları,
                    yönetici işlem kayıtları. Amaç: güvenlik ve hesap verebilirlik.
                  </>,
                  <>
                    <strong>Teknik veriler:</strong> istek zamanı ve yol bilgisi gibi sınırlı kayıtlar. IP
                    adresi günlüklerde kişiyle ilişkilendirilmez; hız sınırı için kısa süreli tutulur.
                  </>,
                ]}
              />
            ),
          },
          {
            id: 'hukuki-dayanak',
            title: 'Hukuki dayanak',
            body: (
              <p>
                Bildirim hizmeti için işleme, açık rızanıza ve hizmetin ifasına dayanır; hesap oluşturan kişi
                parola belirleyerek bu koşulları kabul etmiş sayılır. Güvenlik kayıtları, KVKK m.5/2-f
                kapsamında meşru menfaatle tutulur.
              </p>
            ),
          },
          {
            id: 'aktarim',
            title: 'Aktarım ve hizmet sağlayıcılar',
            body: (
              <>
                <p>Veriler reklam amaçlı satılmaz ve pazarlama için üçüncü taraflarla paylaşılmaz.</p>
                <PolicyList
                  items={[
                    <>
                      <strong>Supabase:</strong> bilgileri sakladığımız veritabanı hizmeti. Veriler Avrupa ya
                      da ABD'deki sunucularda tutulabilir; verilere yalnızca biz erişiriz.
                    </>,
                    <>
                      <strong>Cloudflare:</strong> sitenin barındırılması ve korunması.
                    </>,
                    <>
                      <strong>Resend:</strong> e-posta gönderimi (doğrulama, davet, bildirim). E-postanızın
                      size ulaşması için adresiniz bu hizmetle paylaşılır.
                    </>,
                  ]}
                />
              </>
            ),
          },
          {
            id: 'saklama',
            title: 'Saklama süreleri',
            body: (
              <PolicyList
                items={[
                  'Hesap verileri: hesap silinene kadar.',
                  'Bildirim tercihleri: hesap silinene kadar.',
                  'Bildirim gönderim kayıtları: en fazla 12 ay.',
                  'Oturum kayıtları: oturum geçerlilik süresi ve en fazla 90 gün.',
                  'Denetim kayıtları (yönetici işlemleri): en fazla 24 ay.',
                ]}
              />
            ),
          },
          {
            id: 'haklar',
            title: 'Haklarınız',
            body: (
              <>
                <PolicyList
                  items={[
                    'Hangi verilerinizin işlendiğini öğrenme ve kopyasını isteme.',
                    'Hatalı verinin düzeltilmesini isteme.',
                    'Bildirimleri duraklatma veya tümüyle kapatma (panelden ya da e-postadaki bağlantıyla).',
                    'Hesabınızı ve kişisel verilerinizi silme (panelden "Hesabımı sil" adımı).',
                    'İşlemeye itiraz etme.',
                  ]}
                />
                <p>
                  Silme işlemi hesap verilerini, tercihleri ve oturumları kaldırır; gönderim kayıtları anonim
                  biçimde tutulur. Talepleriniz için: {CONTACT_EMAIL}.
                </p>
              </>
            ),
          },
          {
            id: 'guvenlik',
            title: 'Güvenlik önlemleri',
            body: (
              <PolicyList
                items={[
                  'Parolalar okunamayacak biçimde saklanır; sizden başka kimse göremez.',
                  'Oturumunuz, başkalarının sizin adınıza işlem yapmasını engelleyecek biçimde korunur.',
                  'E-posta adresiniz kayıtlarımızda kısmen gizlenir.',
                  'Arka arkaya çok sayıda yanlış parola denemesi engellenir.',
                  'İlan kontrolleri yalnızca kurumların herkese açık sayfalarına yapılır.',
                ]}
              />
            ),
          },
          {
            id: 'cerezler',
            title: 'Çerezler',
            body: (
              <p>
                Yalnızca oturumunuzu açık tutmak için gerekli çerezler kullanılır. Reklam ya da takip çerezi
                yoktur; ne yaptığınızı izleyen başka bir araç çalıştırmıyoruz.
              </p>
            ),
          },
        ]}
      />
    </InfoPageShell>
  );
}

export function TermsPage(): ReactNode {
  return (
    <InfoPageShell kicker="Kullanım" title="Kullanım Koşulları" backTo="/">
      <PolicyDoc
        lede={`${APP_NAME} kamu personel alım ilanlarını toplayan bir bilgilendirme hizmetidir. Bu koşullar hizmetin kapsamını, sınırlarını ve sorumluluk dağılımını açıklar. Yürürlük: ${POLICY_EFFECTIVE_DATE}.`}
        sections={[
          {
            id: 'hizmet-kapsami',
            title: 'Hizmetin kapsamı',
            body: (
              <>
                <p>
                  Kamuİlan, resmî kaynaklarda yayımlanmış ilanları toplar, sınıflandırır ve aranabilir hâle
                  getirir. Kaynak sayfasında hangi kaynağın canlı doğrulandığı listelenir.
                </p>
                <p>{HONESTY_NOTE}</p>
              </>
            ),
          },
          {
            id: 'baglayici-kaynak',
            title: 'Bağlayıcı kaynak ilanın kendisidir',
            body: (
              <p>
                Sistemdeki bilgiler özet ve yardımcı niteliktedir. Başvuru koşulları, tarihler ve kontenjanlar
                için yalnızca ilanın resmî kaynağı bağlayıcıdır. Başvuru öncesi ilanın kaynağını açıp
                doğrulamanız gerekir.
              </p>
            ),
          },
          {
            id: 'kabul-edilen-kullanim',
            title: 'Kabul edilen kullanım',
            body: (
              <PolicyList
                items={[
                  'Hizmeti kişisel bilgi edinme amacıyla kullanmak.',
                  'İlan listesini otomatik araçlarla aşırı sıklıkta çekmemek (hız sınırları uygulanır).',
                  'Kaynak sitelerin kullanım koşullarına ve erişim kısıtlarına uymak.',
                ]}
              />
            ),
          },
          {
            id: 'yasak-davranislar',
            title: 'Yasak davranışlar',
            body: (
              <PolicyList
                items={[
                  'Sisteme kendi kendine hesap açmaya çalışmak (kayıt kapalıdır; hesaplar yönetici tarafından açılır).',
                  'Diğer kullanıcıların verilerine erişmeye çalışmak, oturum/CSRF kontrollerini aşmaya teşebbüs etmek.',
                  'Kaynak sitelerdeki CAPTCHA, giriş duvarı, robots kuralları veya hız sınırlarını aşmaya çalışmak.',
                  'Toplanan içeriği kaynağı ve bağlantısı olmadan yeniden yayımlamak.',
                ]}
              />
            ),
          },
          {
            id: 'bildirimler',
            title: 'Bildirimler ve çıkma',
            body: (
              <p>
                Bildirim göndermek için e-posta adresinin doğrulanmış olması gerekir. Bildirimleri panelden
                duraklatabilir, her e-postanın altındaki bağlantıyla tümüyle durdurabilirsiniz. Gönderim
                kaydı, bir e-postanın sağlayıcı tarafından kabul edildiğini gösterir; teslim garantisi vermez.
              </p>
            ),
          },
          {
            id: 'sorumluluk',
            title: 'Sorumluluk sınırı',
            body: (
              <p>
                Hizmet "olduğu gibi" sunulur. İlanların eksiksiz veya güncel olması garanti edilmez; kaynak
                erişilemez olduğunda mevcut kayıtlar korunur ve kaynak "bayat" olarak işaretlenir. Verilen
                bilgilere dayanarak alınan kararlardan doğan sonuçlardan kullanıcı sorumludur.
              </p>
            ),
          },
          {
            id: 'fikri-mulkiyet',
            title: 'İçerik ve telif',
            body: (
              <p>
                İlanların telifi ilanı yayımlayan kuruma aittir; Kamuİlan yalnızca kaynağa bağlantı verir ve
                özet gösterir. Arayüz kodu ve tasarımı {APP_NAME} hizmetine aittir.
              </p>
            ),
          },
          {
            id: 'degisiklik',
            title: 'Değişiklikler',
            body: (
              <p>
                Koşullar güncellenebilir; güncel sürüm bu sayfada yayımlanır ve yürürlük tarihi başlıkta
                yazılır. Sorularınız için: {CONTACT_EMAIL}.
              </p>
            ),
          },
        ]}
      />
    </InfoPageShell>
  );
}
