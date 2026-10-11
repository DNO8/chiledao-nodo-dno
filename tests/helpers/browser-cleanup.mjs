// Only injected, test-owned handles are touched; every asynchronous wait is finite.
export async function cleanupOwnedBrowser({ browser, cdp, server, diagnostics, report,
  primaryError, graceMs = 1000, exitMs = 2000, clock = globalThis }) {
  const errors = [];
  const exited = () => !browser?.pid || browser.exitCode != null || browser.signalCode != null;
  let onExit;
  const exit = new Promise(done => {
    onExit = done;
    if (exited()) done();
    else browser.once('exit', onExit);
  });
  const bounded = async (operation, ms, label) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = clock.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })]);
    } finally { clock.clearTimeout(timer); }
  };
  const attempt = async (operation, label, ms = graceMs) => {
    try { await bounded(operation, ms, label); }
    catch (error) { errors.push(error); }
  };
  try {
    if (diagnostics) await attempt(diagnostics, 'cleanup diagnostics');
    if (cdp) {
      await attempt(() => cdp.send('Browser.close'), 'Browser.close');
      await attempt(() => cdp.close(), 'CDP socket close');
    }
    if (!exited()) {
      try { await bounded(() => exit, graceMs, 'graceful child exit'); }
      catch {
        await attempt(() => {
          if (!exited() && !browser.kill()) throw new Error('Owned child kill was rejected');
        }, 'owned child kill');
        if (!exited()) await attempt(() => exit, 'owned child exit after kill', exitMs);
      }
    }
  } finally {
    browser?.removeListener('exit', onExit);
    if (server) {
      await attempt(() => server.closeAllConnections(), 'server sockets close');
      await attempt(() => new Promise((done, reject) => server.close(error => error ? reject(error) : done())), 'server close');
    }
  }
  const result = { exited: exited(), errors };
  if (report) await attempt(() => report(result), 'cleanup report');
  if (primaryError) {
    if (errors.length && Object.isExtensible(primaryError)) primaryError.cleanupErrors = errors;
    throw primaryError;
  }
  if (errors.length) throw new AggregateError(errors, 'Owned browser cleanup failed');
  return result;
}
