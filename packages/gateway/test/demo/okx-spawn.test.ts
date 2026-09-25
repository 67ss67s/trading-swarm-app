import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn, spawnSync: vi.fn(() => { throw new Error('real spawn forbidden'); }) }));
import { defaultOkxSpawn } from '../../src/demo/execution-okx.js';
function child() {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  fake.spawn.mockReturnValue(c);
  return c;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('kills the fake child on abort and forwards only supplied environment', async () => {
  const c = child();
  const controller = new AbortController();
  const pending = defaultOkxSpawn('fake', [], 60_000, { signal: controller.signal, env: { PATH: '/fake', HOME: '/fake-home' } });
  expect(fake.spawn.mock.calls[0]![2].env).toEqual({ PATH: '/fake', HOME: '/fake-home' });
  controller.abort();
  expect(await pending).toMatchObject({ code: 1, spawnError: 'aborted' });
  expect(c.kill).toHaveBeenCalledWith('SIGKILL');
});
it('kills and settles within the timeout even if child never emits close', async () => {
  vi.useFakeTimers();
  const c = child();
  const pending = defaultOkxSpawn('fake', [], 60_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await pending).toMatchObject({ code: 124, timedOut: true });
  expect(c.kill).toHaveBeenCalledOnce();
});
it('signal termination is failure, not exit zero', async () => {
  const c = child(); const pending = defaultOkxSpawn('fake', [], 60_000);
  c.emit('close', null);
  expect(await pending).toMatchObject({ code: 1 });
});
