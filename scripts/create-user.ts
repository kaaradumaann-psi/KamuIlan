/**
 * Kullanıcı oluştur / davet et / parola belirle — `npm run user:create`
 *
 * Neden bu betik var: Kamuİlan dışarıdan kendi kendine kayda kapalıdır, bu
 * yüzden hesap açmanın iki yolu vardır — yönetim panelindeki davet formu
 * (önce bir yönetici gerekir) ve bu betik. Betik, AYNI veritabanı sürücüsünü
 * kullanır: `POSTGRES_URL` tanımlıysa Supabase, değilse geliştirme dosya
 * deposu. Böylece "hesabı Supabase panosuna ekledim ama giriş olmuyor"
 * durumu ortadan kalkar: hesap, uygulamanın okuduğu yere yazılır.
 *
 * Supabase Auth (GoTrue) kullanılmaz; kullanıcı kayıtları `kamuilan_users`
 * tablosunda ve parolalar scrypt özetiyle tutulur. Supabase panosundan elle
 * satır eklemek giriş YAPMAZ (özet biçimi uyuşmaz) — bu betiği kullanın.
 *
 * Kullanım:
 *   npm run user:create -- --email kisi@ornek.com
 *   npm run user:create -- --email kisi@ornek.com --name "Ad Soyad" --admin
 *   npm run user:create -- --email kisi@ornek.com --password "Güçlü-Parola1" --force
 *   npm run user:create -- --email kisi@ornek.com --no-email
 *
 * Seçenekler:
 *   --email <adres>     Zorunlu. Hesabın adresi.
 *   --name <ad>         Görünen ad (öntanımlı: e-posta kökü).
 *   --admin             Hesabı yönetici yapar (rol: admin).
 *   --password <p>      Parolayı hemen belirler (davet bağlantısı yerine).
 *   --force             Var olan hesabın parolasını --password ile DEĞİŞTİRİR.
 *   --invite            Var olan hesap için yeni davet bağlantısı üretir.
 *   --verified          E-postayı doğrulanmış işaretler (bildirim gönderilebilir).
 *   --no-email          Davet e-postasını kuyruğa eklemez; bağlantıyı yazdırır.
 *
 * Parola hiçbir zaman ekrana yazılmaz ve loglanmaz; üretilen rastgele parola
 * yalnızca özet olarak saklanır (kullanıcı hesabı davet bağlantısıyla açar).
 */
import { initStore, closeStore, describeDriver } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { getEnv } from '../src/config/env';
import { BRANDING } from '../src/config/app';
import { randomToken } from '../src/domain/ids';
import { hashPassword, validatePasswordStrength } from '../src/server/passwords';

interface Options {
  email: string;
  name?: string;
  admin: boolean;
  password?: string;
  force: boolean;
  invite: boolean;
  verified: boolean;
  noEmail: boolean;
}

/** `--anahtar değer` / `--bayrak` biçimini ayrıştırır. */
function parseArgs(argv: string[]): Options | { error: string } {
  const options: Options = {
    email: '',
    admin: false,
    force: false,
    invite: false,
    verified: false,
    noEmail: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = argv[index + 1];
    switch (arg) {
      case '--email':
      case '-e':
        if (!next) return { error: '--email için bir değer verin.' };
        options.email = next;
        index += 1;
        break;
      case '--name':
        if (!next) return { error: '--name için bir değer verin.' };
        options.name = next;
        index += 1;
        break;
      case '--password':
        if (!next) return { error: '--password için bir değer verin.' };
        options.password = next;
        index += 1;
        break;
      case '--admin':
        options.admin = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--invite':
        options.invite = true;
        break;
      case '--verified':
        options.verified = true;
        break;
      case '--no-email':
        options.noEmail = true;
        break;
      default:
        if (arg.startsWith('--')) return { error: `Bilinmeyen seçenek: ${arg}` };
    }
  }

  if (!options.email) return { error: '--email zorunludur.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)) {
    return { error: `Geçerli bir e-posta adresi verin (verilen: ${options.email}).` };
  }
  return options;
}

const USAGE = [
  'Kullanım:',
  '  npm run user:create -- --email kisi@ornek.com [--name "Ad Soyad"] [--admin]',
  '  npm run user:create -- --email kisi@ornek.com --password "Güçlü-Parola1" --force',
  '',
  'Seçenekler: --name, --admin, --password, --force, --invite, --verified, --no-email',
].join('\n');

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const options = parsed;
  const env = getEnv();

  if (options.password) {
    const strength = validatePasswordStrength(options.password, { email: options.email });
    if (!strength.valid) {
      console.error(`Parola zayıf: ${strength.problems.join(' ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const store = await initStore();
  const repos = createRepos(store);
  const driverLabel = describeDriver(store.driver);

  try {
    const email = options.email.trim();
    const existing = await repos.users.findByEmail(email);
    const baseUrl = env.APP_BASE_URL.replace(/\/$/, '');

    /**
     * Tek kullanımlık parola belirleme bağlantısı üretir ve (istenirse)
     * e-postayı kuyruğa ekler.
     *
     * `mode` şablonu belirler: yeni hesap için `account-invite` ("hesabınız
     * açıldı"), mevcut hesap için `password-reset`. Yönetim panelindeki davet
     * akışıyla aynı şablonlar kullanılır ki metinler tutarlı kalsın.
     */
    const issueInvite = async (
      user: { id: string; email: string; displayName: string | null; role: string },
      mode: 'invite' | 'reset',
    ): Promise<string> => {
      const token = randomToken(32);
      const ttlMinutes = 60 * 24 * 3; // 72 saat
      await repos.users.createToken({ userId: user.id, type: 'password-reset', token, ttlMinutes });
      const link = `${baseUrl}/sifre-sifirla?token=${token}`;

      if (!options.noEmail) {
        await repos.outbox.enqueue(
          mode === 'invite'
            ? {
                eventId: null,
                jobId: null,
                userId: user.id,
                toEmail: user.email,
                kind: 'account-invite',
                subject: `${BRANDING.name} hesabınız açıldı — şifre belirleyin`,
                template: 'account-invite',
                payload: {
                  displayName: user.displayName ?? '',
                  roleLabel: user.role === 'admin' ? 'yönetici' : 'kullanıcı',
                  inviteUrl: link,
                  expiresInHours: Math.round(ttlMinutes / 60),
                },
                idempotencyKey: `invite:${user.id}:${token}`,
              }
            : {
                eventId: null,
                jobId: null,
                userId: user.id,
                toEmail: user.email,
                kind: 'password-reset',
                subject: `${BRANDING.name} şifre belirleme bağlantınız`,
                template: 'password-reset',
                payload: {
                  displayName: user.displayName ?? '',
                  resetUrl: link,
                  expiresInMinutes: ttlMinutes,
                },
                idempotencyKey: `invite:${user.id}:${token}`,
              },
        );
      }
      return link;
    };

    if (!existing) {
      const { hash, salt } = await hashPassword(options.password ?? randomToken(24));
      const created = await repos.users.create({
        email,
        passwordHash: hash,
        passwordSalt: salt,
        displayName: options.name ?? email.split('@')[0] ?? null,
        ...(options.admin ? { role: 'admin' as const } : {}),
        emailVerified: options.verified,
      });

      if (!created.created) {
        console.error('Hesap oluşturulamadı: aynı e-posta ile kayıt zaten var (eşzamanlı çalışma olabilir).');
        process.exitCode = 1;
        return;
      }

      console.log(`• Hesap oluşturuldu: ${created.user.email} (depo: ${driverLabel})`);
      console.log(`  Rol: ${created.user.role} · durum: ${created.user.status}`);

      if (options.password) {
        console.log('  Parola ayarlandı. Giriş yapabilirsiniz.');
        if (!options.verified) {
          console.log('  Not: e-posta doğrulanmadı; bildirim gönderimi için /eposta-dogrula adımı gerekir.');
        }
      } else {
        const inviteUrl = await issueInvite(created.user, 'invite');
        console.log('  Parola belirlenmedi (rastgele bir sır saklandı; düz metin üretilmedi).');
        console.log(`  Davet bağlantısı (72 saat, tek kullanımlık):\n    ${inviteUrl}`);
        if (!options.noEmail) {
          console.log(
            env.EMAIL_PROVIDER === 'file'
              ? '  E-posta data/mail klasörüne yazıldı; bağlantıyı yukarıdan da açabilirsiniz.'
              : '  Davet e-postası kuyruğa alındı (gönderim geçmişi: yönetim paneli → e-posta kuyruğu).',
          );
        }
      }
      console.log('  Giriş: /giris');
      return;
    }

    // ---- Var olan hesap -----------------------------------------------------
    console.log(`• Hesap zaten var: ${existing.email} (depo: ${driverLabel})`);
    console.log(
      `  Rol: ${existing.role} · durum: ${existing.status} · e-posta doğrulandı: ${existing.emailVerified ? 'evet' : 'hayır'}`,
    );

    if (options.password) {
      if (!options.force) {
        console.log(
          '  Parola DEĞİŞTİRİLMEDİ: mevcut parolayı ezmemek için --force gerekir.\n' +
            '  (Supabase panosundan elle eklenen ya da unutulan parolayı yenilemek için --force kullanın.)',
        );
      } else {
        const { hash, salt } = await hashPassword(options.password);
        await repos.users.update(existing.id, { passwordHash: hash, passwordSalt: salt });
        const revoked = await repos.users.revokeAllSessions(existing.id);
        console.log(`  Parola güncellendi; ${revoked} oturum kapatıldı. Artık bu parolayla giriş yapabilirsiniz.`);
      }
    }

    if (options.admin && existing.role !== 'admin') {
      await repos.users.update(existing.id, { role: 'admin' });
      console.log('  Rol yöneticiye yükseltildi.');
    }

    if (options.verified && !existing.emailVerified) {
      await repos.users.markEmailVerified(existing.id);
      console.log('  E-posta doğrulanmış olarak işaretlendi.');
    }

    // Parola verilmediyse ve hesap hâlâ doğrulanmamışsa yeni bir davet
    // bağlantısı üretilir; --invite ile parola olsa bile zorlanabilir.
    const needsInvite = options.invite || (!options.password && !existing.emailVerified);
    if (needsInvite) {
      const inviteUrl = await issueInvite(existing, 'reset');
      console.log(`  Yeni parola belirleme bağlantısı (72 saat, tek kullanımlık):\n    ${inviteUrl}`);
    }
  } finally {
    await closeStore();
  }
}

main().catch(async (error: unknown) => {
  console.error('İşlem tamamlanamadı:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
