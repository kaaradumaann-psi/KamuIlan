/** Adaptör kaynaklı hatalar — tarama kayıtlarında uyarıya dönüşür. */

export class AdapterStructureError extends Error {
  readonly sourceKey: string;
  readonly detail: string;

  constructor(sourceKey: string, message: string, detail = '') {
    super(message);
    this.name = 'AdapterStructureError';
    this.sourceKey = sourceKey;
    this.detail = detail;
  }
}

export class AdapterUnavailableError extends Error {
  readonly sourceKey: string;
  readonly requirement: string;

  constructor(sourceKey: string, message: string, requirement: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
    this.sourceKey = sourceKey;
    this.requirement = requirement;
  }
}
