// Ownership starts before the next factory can fail, not after browser startup.
export async function acquireOwnedBrowser({ startServer, createProfile, startBrowser,
  graceMs, exitMs, report, startupMs = 8000 }) {
  let hosted, profile, browser;
  try {
    hosted = await startServer();
    profile = await createProfile();
    browser = startBrowser(profile);
    await new Promise((done, reject) => {
      const retire = error => {
        clearTimeout(timer);
        browser.removeListener('spawn', spawned);
        browser.removeListener('error', failed);
        if (error) reject(error); else done();
      };
      const spawned = () => retire(), failed = error => retire(error);
      const timer = setTimeout(() => retire(new Error('Owned browser spawn timed out')), startupMs);
      browser.once('spawn', spawned); browser.once('error', failed);
    });
    return { hosted, profile, browser };
  } catch (primaryError) {
    await cleanupOwnedBrowser({ browser, server: hosted?.server, primaryError, graceMs, exitMs, report });
  }
}

// Only injected, test-owned handles are touched; every asynchronous wait is finite.
export async function cleanupOwnedBrowser({ browser, cdp, server, diagnostics, report,
  primaryError, connections = [], graceMs = 1000, exitMs = 2000, clock = globalThis }) {
  const errors = [];
  const onError = error => errors.push(error);
  browser?.on('error', onError);
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
    }
    for (const client of new Set([cdp, ...connections].filter(Boolean)))
      await attempt(() => client.close(), 'CDP socket close');
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
    browser?.removeListener('error', onError);
    if (server) {
      await attempt(() => server.closeAllConnections(), 'server sockets close');
      await attempt(() => new Promise((done, reject) => server.close(error => error ? reject(error) : done())), 'server close');
    }
  }
  const result = { exited: exited(), errors };
  if (report) await attempt(() => report(result), 'cleanup report');
  if (primaryError) {
    if (errors.length && Object.isExtensible(primaryError))
      primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), ...errors];
    throw primaryError;
  }
  if (errors.length) throw new AggregateError(errors, 'Owned browser cleanup failed');
  return result;
}
