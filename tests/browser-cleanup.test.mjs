import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as cleanup from './helpers/browser-cleanup.mjs';
const { cleanupOwnedBrowser } = cleanup;

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

// Execute the actual harness acquisition/teardown with pure injected owners,
// not a second implementation or a mock claim about native Chrome.
for (const failure of ['profile', 'spawn', 'CDP startup', 'body and socket']) {
  test(`actual harness retires first acquisition after ${failure} failure`, async () => {
    const source = await readFile(new URL('./homepage.browser.test.mjs', import.meta.url), 'utf8');
    const group = source.split("test('works wheel zoom and archive keyboard navigation'")[1].split('\ntest(')[0];
    const start = group.search(/  const (?:hosted|\{ hosted)/);
    const prefix = group.slice(start, group.indexOf('    const port ='));
    const tail = group.slice(group.lastIndexOf('  } catch (error)'), group.lastIndexOf('\n});'));
    const legacyTail = group.slice(group.lastIndexOf('  } finally {'), group.lastIndexOf('\n});'));
    const owned = owners(); owned.cdp.send = async () => {};
    owned.cdp.close = () => { owned.cdp.closed = true; throw new Error('socket close failed'); };
    const primary = new Error(`${failure} original failure`);
    const run = new (Object.getPrototypeOf(async () => {}).constructor)(
      'staticServer', 'mkdtemp', 'spawn', 'join', 'temporary', 'browserPath',
      'acquireOwnedBrowser', 'cleanupOwnedBrowser', 'owned', 'primary', 't',
      `${prefix} cdp = ${failure === 'CDP startup' ? 'undefined' : 'owned.cdp'}; throw primary;\n${tail || legacyTail}`);
    await assert.rejects(run(async () => ({ server: owned.server }),
      async () => { if (failure === 'profile') throw primary; return 'owned-profile'; },
      () => { if (failure === 'spawn') throw primary; queueMicrotask(() => owned.browser.emit('spawn')); return owned.browser; },
      (...parts) => parts.join('/'), 'owned-temp', 'owned-chrome',
      options => cleanup.acquireOwnedBrowser({ ...options, graceMs: 10, exitMs: 10 }),
      options => cleanupOwnedBrowser({ ...options, graceMs: 10, exitMs: 10 }),
      owned, primary, { diagnostic() {} }), error => error === primary);
    assert.equal(owned.server.closed, true, 'first acquired server must close');
    assert.equal(owned.server.sockets, true);
    if (failure === 'body and socket') {
      assert.equal(owned.browser.kills, 1, 'socket failure cannot skip owned child termination');
      assert.equal(owned.browser.signalCode, 'SIGTERM');
      assert.ok(primary.cleanupErrors.some(error => /socket close failed/.test(error.message)));
    }
  });
}

test('asynchronous child spawn failure retires the server and startup listeners', async () => {
  const owned = owners(); owned.browser.pid = undefined;
  const primaryError = new Error('owned spawn rejected');
  await assert.rejects(cleanup.acquireOwnedBrowser({
    startServer: async () => ({ server: owned.server }), createProfile: async () => 'owned-profile',
    startBrowser: () => { queueMicrotask(() => owned.browser.emit('error', primaryError)); return owned.browser; },
    graceMs: 10, exitMs: 10, startupMs: 10,
  }), error => error === primaryError);
  assert.equal(owned.server.closed, true); assert.equal(owned.server.sockets, true);
  assert.equal(owned.browser.kills, 0);
  assert.equal(owned.browser.listenerCount('spawn'), 0); assert.equal(owned.browser.listenerCount('error'), 0);
});

test('spawn timeout is bounded and does not confuse a kill request with exit', async () => {
  const owned = owners('never exits');
  await assert.rejects(cleanup.acquireOwnedBrowser({
    startServer: async () => ({ server: owned.server }), createProfile: async () => 'owned-profile',
    startBrowser: () => owned.browser, startupMs: 10, graceMs: 10, exitMs: 10,
  }), error => /spawn timed out/.test(error.message) && error.cleanupErrors.some(e => /exit after kill/.test(e.message)));
  assert.equal(owned.browser.kills, 1); assert.equal(owned.server.closed, true);
  for (const event of ['spawn', 'error', 'exit']) assert.equal(owned.browser.listenerCount(event), 0);
});

test('all independently owned CDP sockets retire even when the first close throws', async () => {
  const owned = owners(); owned.cdp.send = async () => {};
  let first = 0, second = 0;
  owned.cdp.close = () => { first++; throw new Error('first socket failed'); };
  const connection = { close() { second++; } };
  const primaryError = new Error('original setup failure');
  await assert.rejects(cleanupOwnedBrowser({ ...owned, connections: [owned.cdp, connection],
    primaryError, graceMs: 10, exitMs: 10 }), error => error === primaryError);
  assert.equal(first, 1, 'shared handle is closed once'); assert.equal(second, 1);
  assert.equal(owned.server.closed, true); assert.equal(owned.browser.signalCode, 'SIGTERM');
});

test('every browser group establishes protected acquisition and shared teardown', async () => {
  const source = await readFile(new URL('./homepage.browser.test.mjs', import.meta.url), 'utf8');
  const groups = source.split('\ntest(').slice(1);
  assert.equal(groups.length, 22, 'all actual browser groups are accounted for');
  for (const group of groups) {
    const name = group.slice(0, group.indexOf(', {'));
    assert.match(group, /cleanupOwnedBrowser\(/, `${name}: guarded shared teardown`);
    assert.match(group, /primaryError = error/, `${name}: original failure retained`);
    if (!group.startsWith("'real browser verifies supplied works wheel"))
      assert.match(group, /acquireOwnedBrowser\(/, `${name}: first acquisition owned`);
    else assert.ok(group.indexOf('  try {') < group.indexOf('await staticServer()'), 'largest existing group already protects server acquisition');
    assert.doesNotMatch(group, /browser\.kill\(|cdp\?\.close\(\)/, `${name}: no unguarded manual teardown`);
  }
});

test('actual CDP startup and socket failures drain listeners and pending timers', async () => {
  const source = await readFile(new URL('./homepage.browser.test.mjs', import.meta.url), 'utf8');
  const connectSource = source.slice(source.indexOf('async function connect('), source.indexOf("\ntest('"));
  for (const startupFailure of [true, false]) {
    const timers = new Set(), listeners = new Set();
    let socket;
    class OwnedSocket extends EventTarget {
      constructor() {
        super(); socket = this;
        queueMicrotask(() => this.dispatchEvent(new Event(startupFailure ? 'error' : 'open')));
      }
      addEventListener(type, callback, options) { listeners.add(callback); super.addEventListener(type, callback, options); }
      removeEventListener(type, callback) { listeners.delete(callback); super.removeEventListener(type, callback); }
      send() {}
      close() { this.closed = true; throw new Error('owned socket close failed'); }
    }
    const connect = new Function('WebSocket', 'setTimeout', 'clearTimeout', `${connectSource}; return connect;`)(
      OwnedSocket, (callback, ms) => { const id = setTimeout(callback, ms); timers.add(id); return id; },
      id => { clearTimeout(id); timers.delete(id); });
    if (startupFailure) {
      await assert.rejects(connect('owned-fixture'), error => /WebSocket failed/.test(error.message)
        && /socket close failed/.test(error.cleanupErrors[0].message));
    } else {
      const client = await connect('owned-fixture');
      const pending = assert.rejects(client.send('owned.pending'), /Owned CDP connection closed/);
      assert.throws(() => client.close(), /socket close failed/);
      await pending;
      assert.throws(() => client.close(), /socket close failed/);
    }
    assert.equal(socket.closed, true); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
  }
});

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
