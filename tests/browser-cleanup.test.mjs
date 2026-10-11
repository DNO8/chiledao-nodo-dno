import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { cleanupOwnedBrowser } from './helpers/browser-cleanup.mjs';

function owners(mode = '') {
  const browser = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, kills: 0 });
  browser.kill = () => {
    browser.kills++;
    if (mode === 'kill failure') throw new Error('kill failed');
    if (mode !== 'never exits') { browser.signalCode = 'SIGTERM'; browser.emit('exit', null, 'SIGTERM'); }
    return true;
  };
  const cdp = { closed: false, async send() { throw new Error('close rejected'); }, close() { this.closed = true; } };
  const server = { closed: false, sockets: false, closeAllConnections() { this.sockets = true; }, close(done) {
    this.closed = true; done(mode === 'server failure' ? new Error('server failed') : undefined);
  } };
  return { browser, cdp, server };
}

for (const mode of ['absent CDP', 'close rejection', 'never exits', 'kill failure', 'diagnostic failure', 'server failure']) {
  test(`owned cleanup bounds ${mode} and retires every other resource`, async () => {
    const owned = owners(mode);
    if (mode === 'absent CDP') owned.cdp = undefined;
    const primaryError = new Error('original assertion');
    const timers = new Set();
    const clock = {
      setTimeout(callback, ms) { const id = setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; },
      clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    };
    let deadline;
    const task = cleanupOwnedBrowser({ ...owned, primaryError, graceMs: 10, exitMs: 10, clock,
      diagnostics: mode === 'diagnostic failure' ? () => { throw new Error('diagnostic failed'); } : undefined });
    const result = await Promise.race([
      task.then(() => ({ returned: true }), error => ({ error })),
      new Promise(done => { deadline = setTimeout(() => done({ hung: true }), 150); }),
    ]);
    // Retire the baseline fake owner even when its unbounded exit promise hangs.
    clearTimeout(deadline);
    owned.browser.exitCode = 0; owned.browser.emit('exit', 0);
    await task.catch(() => {});
    assert.equal(result.hung, undefined, 'cleanup must finish before the failure probe deadline');
    assert.equal(result.error, primaryError, 'cleanup cannot replace the original failure');
    assert.equal(owned.server.closed, true); assert.equal(owned.server.sockets, true);
    if (owned.cdp) assert.equal(owned.cdp.closed, true);
    assert.equal(owned.browser.listenerCount('exit'), 0); assert.equal(timers.size, 0);
    if (mode !== 'absent CDP') assert.ok(primaryError.cleanupErrors?.length, 'actual cleanup failures remain observable');
  });
}

test('already signal-exited and never-spawned children need no exit wait or kill', async () => {
  for (const state of [{ signalCode: 'SIGTERM' }, { pid: undefined }]) {
    const owned = owners(); Object.assign(owned.browser, state); owned.cdp = undefined;
    let deadline;
    const task = cleanupOwnedBrowser({ ...owned, graceMs: 10, exitMs: 10 });
    const result = await Promise.race([task.then(() => true), new Promise(done => { deadline = setTimeout(() => done(false), 150); })]);
    clearTimeout(deadline); owned.browser.exitCode = 0; owned.browser.emit('exit', 0); await task;
    assert.equal(result, true); assert.equal(owned.browser.kills, 0); assert.equal(owned.server.sockets, true);
  }
});

test('cleanup failure without a primary failure rejects rather than passing silently', async () => {
  const owned = owners(); owned.browser.exitCode = 0;
  await assert.rejects(cleanupOwnedBrowser({ ...owned, graceMs: 10, exitMs: 10 }), AggregateError);
});

test('listener is armed before synchronous close/kill exit and removed after success', async () => {
  for (const graceful of [true, false]) {
    const owned = owners();
    owned.cdp.send = async () => {
      assert.equal(owned.browser.listenerCount('exit'), 1);
      if (graceful) { owned.browser.exitCode = 0; owned.browser.emit('exit', 0); }
    };
    const result = await cleanupOwnedBrowser({ ...owned, graceMs: 10, exitMs: 10 });
    assert.equal(result.exited, true); assert.deepEqual(result.errors, []);
    assert.equal(owned.browser.kills, graceful ? 0 : 1); assert.equal(owned.browser.listenerCount('exit'), 0);
    assert.equal(owned.server.closed, true); assert.equal(owned.cdp.closed, true);
  }
});

for (const operation of ['diagnostics', 'Browser.close', 'server.close', 'socket.close', 'report']) {
  test(`bounded ${operation} rejection or stall cannot prevent remaining cleanup`, async () => {
    const owned = owners(); owned.cdp.send = async () => {};
    const never = () => new Promise(() => {});
    if (operation === 'Browser.close') owned.cdp.send = never;
    if (operation === 'server.close') owned.server.close = () => { owned.server.closed = true; };
    if (operation === 'socket.close') owned.cdp.close = () => { owned.cdp.closed = true; throw new Error('socket failed'); };
    const primaryError = new Error('primary survives');
    await assert.rejects(cleanupOwnedBrowser({ ...owned, primaryError, graceMs: 10, exitMs: 10,
      diagnostics: operation === 'diagnostics' ? never : undefined,
      report: operation === 'report' ? () => { throw new Error('report failed'); } : undefined }), error => error === primaryError);
    assert.ok(primaryError.cleanupErrors.length > 0);
    assert.equal(owned.server.closed, true); assert.equal(owned.server.sockets, true); assert.equal(owned.cdp.closed, true);
    assert.equal(owned.browser.listenerCount('exit'), 0);
  });
}
