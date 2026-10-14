/** Safe fields for operational errors: never include the error message or object. */
export interface SafeErrorFields {
  errorType: string;
  code?: string;
}

/**
 * Database and transport error messages can embed record values. Keep only a
 * bounded, syntax-restricted error code and a stable class/type label.
 */
export function safeErrorFields(error: unknown): SafeErrorFields {
  if (!(error instanceof Error)) return { errorType: typeof error };

  const constructorName = error.constructor?.name;
  const errorType =
    typeof constructorName === 'string' && /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(constructorName)
      ? constructorName
      : 'Error';
  const candidateCode = (error as Error & { code?: unknown }).code;
  const code =
    typeof candidateCode === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(candidateCode)
      ? candidateCode
      : undefined;

  return { errorType, ...(code ? { code } : {}) };
}
