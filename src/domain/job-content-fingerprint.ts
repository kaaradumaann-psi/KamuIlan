import { sha256Hex } from './ids';

/**
 * Stable fingerprint for the text retained on a job record.
 *
 * Deliberately hashes only the bounded, contact-redacted excerpt used by the
 * application, never the full source response. `contentHash` is a change hint,
 * not a signature or a substitute for source verification.
 */
export function jobContentFingerprint(input: {
  title: string;
  textExcerpt: string;
  applicationEndAt: string | null;
  quota: number | null;
}): string {
  return sha256Hex(
    `${input.title}|${input.textExcerpt}|${input.applicationEndAt ?? ''}|${input.quota ?? ''}`,
  );
}
