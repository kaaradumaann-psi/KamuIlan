/**
 * Sinyal → çıkış kodu eşlemesi (geliştirme betikleri için ortak yardımcı).
 *
 * Neden var: `process.on('SIGINT', shutdown)` yazıldığında Node, dinleyiciye
 * SİNYAL ADINI ('SIGINT') ilk argüman olarak geçirir. Doğrudan
 * `process.exit(sinyal)` çağrılırsa Node `ERR_INVALID_ARG_TYPE`
 * ("The \"code\" argument must be of type number") fırlatır ve süreç çökerek
 * kapanır — Ctrl+C sonrası ekranda bir yığın izi, kabukta da belirsiz bir
 * çıkış kodu kalır (2026-10-16 Windows koşumunda görüldü).
 *
 * `process.exit` YALNIZCA sayı alır. Bu modül gelen değeri her zaman sayıya
 * indirger; POSIX geleneği (128 + sinyal numarası) korunur.
 */

/** Bilinen sinyallerin numaraları (POSIX/Windows kesişimi). */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
};

/**
 * Sinyal adı için güvenli (sayısal) çıkış kodu.
 * Tanınmayan ya da bozuk bir girdi `fallback` değerine düşer.
 */
export function signalExitCode(signal: unknown, fallback = 0): number {
  if (typeof signal === 'number' && Number.isInteger(signal)) return signal;
  if (typeof signal !== 'string') return fallback;
  const number = SIGNAL_NUMBERS[signal.toUpperCase()];
  return number ? 128 + number : fallback;
}

/**
 * `process.exit`'e verilecek kodu doğrular: sayı değilse `fallback`.
 * Dinleyiciye yanlışlıkla sinyal adı geçse bile süreç çökmez.
 */
export function safeExitCode(code: unknown, fallback = 0): number {
  return typeof code === 'number' && Number.isInteger(code) ? code : fallback;
}
