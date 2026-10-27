/**
 * Renk teması: açık / koyu / sistem.
 *
 * Seçim `localStorage`'da tutulur (özel pencere vb. durumlarda erişim hata
 * verebilir; o zaman sessizce "sistem" varsayılır). Çözümlenen tema
 * `<html data-theme="light|dark">` olarak yazılır; CSS yalnızca bu özniteliğe
 * bakar (kamuilan.css · 23). CSP satır içi betiğe izin vermediği için ilk
 * uygulama bu modül yüklenirken yapılır.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'kamuilan-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    // Karanlık mod isteğe bağlıdır: kullanıcı açıkça seçmedikçe açık tema (sistem teması izlenmez).
    return value === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  try {
    return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#111113' : '#FFFFFF');
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* Depolama kapalı: seçim yalnızca bu oturumda geçerli olur. */
  }
  applyTheme(preference);
}

/** Sistem teması değişince "sistem" seçiliyse yeniden uygular. */
function watchSystemTheme(): void {
  try {
    window.matchMedia?.(DARK_QUERY).addEventListener?.('change', () => {
      if (readThemePreference() === 'system') applyTheme('system');
    });
  } catch {
    /* matchMedia yoksa açık tema kalır. */
  }
}

if (typeof window !== 'undefined') {
  applyTheme(readThemePreference());
  watchSystemTheme();
}
