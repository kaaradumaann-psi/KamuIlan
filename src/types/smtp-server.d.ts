/**
 * `smtp-server` için asgari tip bildirimi.
 *
 * Paket kendi tip dosyasını yayımlamadığı için yalnızca kullandığımız yüzeyi
 * (SMTPServer, onData, close) tanımlıyoruz. Geliştirme posta sunucusu dışında
 * hiçbir yerde kullanılmaz ve üretimde çalıştırılmaz.
 */
declare module 'smtp-server' {
  import type { Server } from 'node:net';

  export interface SMTPServerSession {
    id: string;
    remoteAddress: string;
    envelope: { mailFrom?: string; rcptTo?: { address: string }[] };
  }

  export interface SMTPServerOptions {
    /** Kimlik doğrulama zorunlu mu? Geliştirmede false. */
    authOptional?: boolean;
    disabledCommands?: string[];
    onData(
      stream: NodeJS.ReadableStream,
      session: SMTPServerSession,
      callback: (error?: Error | null) => void,
    ): void;
    onAuth?(auth: unknown, session: SMTPServerSession, callback: (error?: Error | null, response?: unknown) => void): void;
  }

  export class SMTPServer {
    constructor(options: SMTPServerOptions);
    listen(port: number, host: string, callback?: () => void): Server;
    close(callback?: () => void): void;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}
