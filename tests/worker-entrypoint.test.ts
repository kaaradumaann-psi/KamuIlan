/** Windows ve POSIX yollarında worker'ın doğrudan giriş noktası tanınır. */
import { describe, expect, it } from 'vitest';
import { isDirectWorkerExecution } from '../src/worker/main';

describe('worker giriş noktası', () => {
  it('tsx/Node girişini Windows ters eğik çizgili yolda da tanır', () => {
    const windowsEntry = ['C:', 'Users', 'aday', 'kamuradar', 'src', 'worker', 'main.ts'].join('\\');
    const windowsTsxEntry = ['C:', 'Users', 'aday', 'kamuradar', 'src', 'worker', 'main.tsx'].join('\\');
    expect(isDirectWorkerExecution(windowsEntry)).toBe(true);
    expect(isDirectWorkerExecution(windowsTsxEntry)).toBe(true);
  });

  it('POSIX ve göreli giriş yollarını tanır', () => {
    expect(isDirectWorkerExecution('/home/aday/kamuradar/src/worker/main.ts')).toBe(true);
    expect(isDirectWorkerExecution('src/worker/main.ts')).toBe(true);
  });

  it('worker modülünün içe aktarılmasını veya benzer adlı testleri giriş saymaz', () => {
    expect(isDirectWorkerExecution(undefined)).toBe(false);
    expect(isDirectWorkerExecution('/home/aday/kamuradar/tests/worker/main.test.ts')).toBe(false);
    expect(isDirectWorkerExecution('/home/aday/kamuradar/src/worker/runtime.ts')).toBe(false);
  });
});
