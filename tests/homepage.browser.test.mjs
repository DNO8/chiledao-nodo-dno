import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const temporary = join(tmpdir(), 'opencode');
const browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.avif': 'image/avif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};


async function until(read, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timed out: ${description}`);
}

async function staticServer() {
  const canonicalRoot = await realpath(root);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!candidate.startsWith(`${root}${sep}`) || pathname.includes('\0')) {
        response.writeHead(403).end();
        return;
      }
      const canonical = await realpath(candidate);
      if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(canonical);
      response.writeHead(200, { 'Content-Type': mime[extname(canonical)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP WebSocket startup timed out')), 8000);
    socket.addEventListener('open', () => { clearTimeout(timeout); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP WebSocket failed')); }, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  const listeners = new Map();
  const errors = [];
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    pending.set(id, { done, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timeout);
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.done(message.result);
    } else {
      for (const listener of listeners.get(message.method) ?? []) {
        Promise.resolve(listener(message.params, message.sessionId)).catch((error) => errors.push(error.message));
      }
    }
  });
  return {
    send, errors,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close() {
      socket.close();
      for (const call of pending.values()) {
        clearTimeout(call.timeout);
        call.reject(new Error('Owned CDP connection closed'));
      }
      pending.clear();
    },
  };
}

test('polaroid gesture ownership and hydration sizing', { timeout: 150000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const modulePath = [...html.matchAll(/component-url="([^"]+)"/g)].map(m => m[1])
    .find(path => /FormationPolaroid\./.test(path));
  assert.ok(modulePath, 'exact built formation entry identified');
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-polaroid-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp, injection, gate = false, pendingEntry, receipts = [], errors = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned polaroid browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const url = new URL(request.url);
      if (gate && url.origin === hosted.origin && url.pathname === modulePath) {
        pendingEntry = requestId; receipts.push({ path: url.pathname, paused: true }); return;
      }
      const allowed = url.origin === hosted.origin || url.protocol === 'data:'
        || (url.protocol === 'blob:' && request.url.startsWith(`blob:${hosted.origin}/`));
      await cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Target.activateTarget', { targetId: page.id }); await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const frames = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    const load = async (width = 1440, delayed = false) => {
      gate = delayed; pendingEntry = undefined; receipts = []; errors = [];
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
      if (injection) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
      ({ identifier: injection } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__rows=[];window.__owner=null;window.__listeners=[];window.__shifts=[];
        const add=window.addEventListener,remove=window.removeEventListener;
        window.addEventListener=function(type,callback,...rest){
          if(['pointerup','pointercancel','pointermove','blur'].includes(type))window.__listeners.push({type,callback,removed:false});
          return add.call(this,type,callback,...rest);
        };
        window.removeEventListener=function(type,callback,...rest){
          const row=window.__listeners.findLast(r=>r.type===type&&r.callback===callback&&!r.removed);
          if(row)row.removed=true;return remove.call(this,type,callback,...rest);
        };
        add.call(window,'blur',e=>window.__rows.push({type:'blur',trusted:e.isTrusted}));
        for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])
          document.addEventListener(type,e=>{const root=e.target.closest?.('.pl-root');
            if(type==='pointerdown'&&root&&window.__owner===null&&e.isTrusted)window.__owner=e.pointerId;
            window.__rows.push({type,id:e.pointerId,root:!!root,rootTarget:e.target===root,buttons:e.buttons,trusted:e.isTrusted});});
        new PerformanceObserver(list=>{for(const e of list.getEntries())window.__shifts.push({time:e.startTime,
          value:e.value,recent:e.hadRecentInput,sources:e.sources.map(s=>({formation:!!s.node?.closest?.('#formacion'),
            previous:s.previousRect.toJSON(),current:s.currentRect.toJSON()}))});}).observe({type:'layout-shift',buffered:true});
      ` }));
      await cdp.send('Page.navigate', { url: hosted.origin });
      await until(() => evaluate(`document.readyState!=='loading' && !!document.querySelector('[data-formation-polaroid]')
        && [...document.querySelectorAll('astro-island')].filter(i=>/WorksWheelShowcase|timeline/.test(i.getAttribute('component-url')))
          .every(i=>!i.hasAttribute('ssr'))`), 'sibling hydration and parsed formation');
      await evaluate(`(async()=>{await document.fonts.ready;const r=document.querySelector('[data-formation-polaroid]');
        scrollTo({top:r.getBoundingClientRect().top+scrollY-100,behavior:'instant'});})()`);
      if (delayed) {
        await until(() => pendingEntry, 'actual formation entry interception');
        await evaluate(`document.querySelector('[data-polaroid-fallback] img').decode()`);
      }
      else await until(() => evaluate(`document.querySelector('.pl-root')?.dataset.draws>0`), 'real enhanced formation pose');
      await frames();
    };
    const pose = () => evaluate(`(()=>{const r=document.querySelector('.pl-root');return {offset:Number(r.dataset.offset),
      drag:r.dataset.drag,draws:Number(r.dataset.draws),velocity:Number(r.dataset.velocity),captured:r.hasPointerCapture(window.__owner??1),
      transforms:[...r.querySelectorAll('.pl-card')].map(e=>e.style.transform)};})()`);
    const listeners = () => evaluate(`window.__listeners.filter(r=>!r.removed).map(r=>r.type).sort()`);
    const mouse = (type, point, held = false) => cdp.send('Input.dispatchMouseEvent',
      { type, ...point, button: held || type !== 'mouseMoved' ? 'left' : 'none', buttons: held ? 1 : 0,
        ...(type !== 'mouseMoved' ? { clickCount: 1 } : {}) });
    const points = () => evaluate(`(()=>{const s=document.querySelector('.pl-root'),r=s.getBoundingClientRect();
      const inside={x:r.left+r.width*.6,y:r.top+100},outside={x:inside.x,y:r.top-15};return {inside,outside,
        insideHit:s.contains(document.elementFromPoint(inside.x,inside.y)),outsideHit:!s.contains(document.elementFromPoint(outside.x,outside.y))};})()`);
    const clean = () => { assert.deepEqual(errors, []); assert.deepEqual(cdp.errors, []); };

    await t.test('delayed real entry preserves stable SSR root and downstream geometry at four widths', async () => {
      const measurements = [];
      const geometry = () => evaluate(`(()=>{const r=document.querySelector('[data-formation-polaroid]');
        const rect=e=>{const b=e.getBoundingClientRect();return {top:b.top+scrollY,height:b.height,width:b.width};};
        return {root:rect(r),neighbor:rect(document.querySelector('#formacion article')),
          downstream:rect(document.querySelector('#formacion a[href="#contacto"]')),faq:rect(document.querySelector('#faq'))};})()`);
      for (const width of [320, 390, 768, 1440]) {
        await load(width, true);
        assert.equal(await evaluate(`!!document.querySelector('[data-polaroid-fallback]')&&!document.querySelector('.pl-root')`), true);
        let before = await geometry();
        await until(async () => { await frames(); const next = await geometry(); const stable = JSON.stringify(next)===JSON.stringify(before);
          before = next; return stable; }, 'font/image-ready SSR geometry stabilizes');
        // Viewport emulation can mark early shifts as recent input. Cross that
        // exclusion window before release; root/document deltas remain primary.
        await until(() => evaluate('performance.now()>700'), 'navigation input exclusion window elapsed');
        const fallback = await evaluate(`(()=>{const r=document.querySelector('[data-formation-polaroid]');return {
          images:r.querySelectorAll('img').length,captions:r.querySelectorAll('figcaption').length,
          links:[...r.querySelectorAll('nav a')].map(a=>{const b=a.getBoundingClientRect();return {width:b.width,height:b.height};}),
          clipped:[...r.querySelectorAll('figcaption')].some(e=>e.scrollHeight>e.clientHeight),
          contained:[...r.querySelectorAll('img,figcaption,nav a')].every(e=>{const b=e.getBoundingClientRect(),p=r.getBoundingClientRect();
            return b.height>0&&b.top>=p.top&&b.bottom<=p.bottom+.1;}),
          fit:getComputedStyle(r.querySelector('img')).objectFit};})()`);
        assert.equal(fallback.images, 6); assert.equal(fallback.captions, 6);
        assert.ok(fallback.links.every(r=>r.width>=44&&r.height>=44)); assert.equal(fallback.clipped, false); assert.equal(fallback.fit, 'contain');
        assert.equal(fallback.contained, true, 'all native images, captions and wrapped links fit the reserved root');
        const mark = await evaluate('performance.now()');
        gate = false; await cdp.send('Fetch.continueRequest', { requestId: pendingEntry });
        receipts.push({ path: modulePath, released: true }); pendingEntry = undefined;
        await until(() => evaluate(`document.querySelector('.pl-root')?.dataset.draws>0
          && !document.querySelector('[data-polaroid-fallback]')`), 'released real entry runs passive effects and draws');
        await frames(); const after = await geometry();
        const shifts = await evaluate(`window.__shifts.filter(e=>e.time>=${mark})`);
        measurements.push({width,before,after,rootDelta:after.root.height-before.root.height,
          neighborDelta:after.neighbor.top-before.neighbor.top,downstreamDelta:after.downstream.top-before.downstream.top,
          faqDelta:after.faq.top-before.faq.top,shifts,receipts:[...receipts]});
        clean();
      }
      t.diagnostic(`Formation hydration measurements: ${JSON.stringify(measurements)}`);
      for (const row of measurements) {
        assert.deepEqual(row.receipts, [{path:modulePath,paused:true},{path:modulePath,released:true}]);
        assert.ok(Math.abs(row.rootDelta)<1, `${row.width}: root height moved ${row.rootDelta}px`);
        assert.ok(Math.abs(row.downstreamDelta)<1 && Math.abs(row.neighborDelta)<1 && Math.abs(row.faqDelta)<1,
          `${row.width}: formation neighbor/downstream document geometry must not move`);
      }
    });
    await t.test('real outside mouse release before capture cannot create a hover drag', async () => {
      await load();
      const p = await evaluate(`(()=>{const s=document.querySelector('.pl-root'),r=s.getBoundingClientRect();
        const inside={x:r.left+r.width*.6,y:r.top+2},outside={x:inside.x,y:r.top-2};return {inside,outside,
          insideHit:s.contains(document.elementFromPoint(inside.x,inside.y)),outsideHit:!s.contains(document.elementFromPoint(outside.x,outside.y))};})()`);
      assert.equal(p.insideHit, true); assert.equal(p.outsideHit, true);
      const before = await pose(), baseline = await listeners();
      await mouse('mousePressed', p.inside, true); await mouse('mouseMoved', p.outside, true);
      assert.equal((await pose()).captured, false, 'vertical exit has not captured the horizontal gesture');
      await mouse('mouseReleased', p.outside);
      assert.equal(await evaluate(`window.__rows.filter(r=>r.type==='pointerup').at(-1).root`), false);
      await mouse('mouseMoved', {x:p.inside.x-80,y:p.inside.y}); await frames();
      assert.deepEqual(await pose(), before, 'actual outside up retires ownership before hover reentry');
      assert.deepEqual(await listeners(), baseline); clean();
    });
    await t.test('foreign pointer contract probes cannot replace move or retire the real mouse owner', async (st) => {
      for (const type of ['pointerdown','pointermove','pointerup','pointercancel']) await st.test(`foreign ${type}`, async () => {
        await load(); const p = await points(), baseline = await listeners();
        await mouse('mousePressed', p.inside, true); await mouse('mouseMoved', {x:p.inside.x-40,y:p.inside.y}, true);
        const held = await pose(); assert.equal(held.drag, '1'); assert.equal(held.captured, true);
        // These controlled identity probes are not native multitouch evidence.
        await evaluate(`document.querySelector('.pl-root').dispatchEvent(new PointerEvent('${type}',
          {bubbles:true,pointerId:77,pointerType:'touch',button:0,buttons:1,clientX:10,clientY:10}))`);
        assert.deepEqual(await pose(), held, `${type}: foreign pointer must leave real owner's pose and capture intact`);
        await mouse('mouseMoved', {x:p.inside.x-70,y:p.inside.y}, true);
        assert.ok(Math.abs((await pose()).offset-70)<.2, 'original owner continues its direct drag');
        await mouse('mouseReleased', p.outside); await frames();
        assert.equal((await pose()).captured, false); assert.equal((await pose()).drag, '0');
        assert.deepEqual(await listeners(), baseline); clean();
      });
    });
    await t.test('button loss blur root capture loss cancel and resize dispose real held ownership', async (st) => {
      for (const retirement of ['button loss','blur','capture loss','cancel','resize','preference']) await st.test(retirement, async () => {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await load(); const p = await points(), baseline = await listeners();
        await mouse('mousePressed', p.inside, true); await mouse('mouseMoved', {x:p.inside.x-40,y:p.inside.y}, true);
        assert.equal((await pose()).captured, true);
        if (retirement==='button loss') await mouse('mouseMoved', {x:p.inside.x-45,y:p.inside.y});
        else if (retirement==='blur') {
          const secondary = await cdp.send('Target.createTarget', {url:'about:blank'});
          try {
            await cdp.send('Target.activateTarget', {targetId:secondary.targetId});
            await until(() => evaluate(`window.__rows.some(r=>r.type==='blur'&&r.trusted)`), 'real foreground target switch emits blur');
          } finally {
            await cdp.send('Target.activateTarget', {targetId:page.id}); await cdp.send('Page.bringToFront');
            await cdp.send('Target.closeTarget', {targetId:secondary.targetId});
          }
        }
        else if (retirement==='capture loss') await evaluate(`document.querySelector('.pl-root').releasePointerCapture(window.__owner)`);
        else if (retirement==='cancel') await evaluate(`document.querySelector('.pl-root').dispatchEvent(new PointerEvent('pointercancel',
          {bubbles:true,pointerId:window.__owner,pointerType:'mouse'}))`);
        else if (retirement==='resize') await cdp.send('Emulation.setDeviceMetricsOverride', {width:1300,height:900,deviceScaleFactor:1,mobile:false});
        else {
          await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
          await until(() => evaluate(`document.querySelector('.pl-root').dataset.reduced==='false'`), 'live preference controller change');
          await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
          await until(() => evaluate(`!document.querySelector('[data-timeline]').dataset.enhanced`), 'timeline returns to native layout');
          await evaluate(`document.querySelector('.pl-root').scrollIntoView({block:'center',behavior:'instant'})`);
          await until(() => evaluate(`document.querySelector('.pl-root').dataset.reduced==='true'`), 'live preference controller restored');
        }
        await mouse('mouseMoved', {x:p.inside.x-50,y:p.inside.y}); await frames();
        assert.equal((await pose()).captured, false, `${retirement}: capture retired`);
        assert.equal((await pose()).drag, '0', `${retirement}: visible drag state retired`);
        assert.deepEqual(await listeners(), baseline, `${retirement}: exact acquired listener identities removed`);
        const stopped = await pose(); await mouse('mouseMoved', {x:p.inside.x-90,y:p.inside.y}); await frames();
        assert.deepEqual(await pose(), stopped, `${retirement}: no ghost or idle reduced draw`);
        await mouse('mouseReleased', p.outside); clean();
      });
    });
    await t.test('native multitouch keeps the first owner and descendant capture transfer permits page pan', async () => {
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:true,maxTouchPoints:2});
      await load(390); const p = await points(), baseline = await listeners();
      const touch = (type, points = []) => cdp.send('Input.dispatchTouchEvent', {type,
        touchPoints:points.map(point=>({...point,radiusX:2,radiusY:2}))});
      const first = {id:1,...p.inside}, second = {id:2,x:p.inside.x+30,y:p.inside.y+20};
      await touch('touchStart', [first]); await touch('touchStart', [first,second]);
      await touch('touchMove', [first,{...second,x:second.x-20}]);
      assert.equal((await pose()).offset, 0, 'second native touch cannot move first owner');
      await touch('touchEnd', [second]);
      await touch('touchMove', [{...first,x:first.x-35}]); await touch('touchMove', [{...first,x:first.x-70}]);
      t.diagnostic(`Native multitouch receipts: ${JSON.stringify(await evaluate('window.__rows'))}; pose: ${JSON.stringify(await pose())}`);
      await until(async () => Math.abs((await pose()).offset-70)<.2, 'first native touch continues after foreign release');
      assert.equal((await pose()).captured, true);
      const rows = await evaluate(`window.__rows.filter(r=>r.trusted)`);
      assert.equal(new Set(rows.filter(r=>r.type==='pointerdown'&&r.root).map(r=>r.id)).size, 2, 'two acknowledged native pointer identities');
      assert.ok(rows.some(r=>r.type==='pointerup'&&r.id!==rows.find(r=>r.type==='pointerdown').id));
      assert.equal(rows.find(r=>r.type==='pointerdown').rootTarget, false, 'native touch begins on a card descendant');
      await touch('touchCancel'); await frames();
      assert.equal((await pose()).captured, false); assert.deepEqual(await listeners(), baseline);
      assert.equal(await evaluate(`window.__rows.some(r=>r.type==='pointercancel'&&r.trusted)`), true);
      const y = await evaluate('scrollY');
      await touch('touchStart', [first]);
      for (let step=1;step<=5;step++) await touch('touchMove', [{...first,y:first.y-step*25}]);
      await touch('touchEnd');
      await until(async () => await evaluate('scrollY')>y+30, 'vertical native page pan inside formation');
      assert.equal((await pose()).offset, 0); assert.deepEqual(await listeners(), baseline); clean();
    });
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
    if (browser.exitCode === null) browser.kill();
    hosted.server.closeAllConnections(); await new Promise(done => hosted.server.close(done));
  }
});

test('works wheel input ownership', { timeout: 150000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-wheel-input-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp, injection, errors = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned wheel input browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const url = new URL(request.url);
      const allowed = url.origin === hosted.origin || url.protocol === 'data:'
        || (url.protocol === 'blob:' && request.url.startsWith(`blob:${hosted.origin}/`));
      await cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') errors.push(args.map(a => a.value ?? a.description).join(' '));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Target.activateTarget', { targetId: page.id }); await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const load = async (source = '') => {
      if (injection) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
      errors = [];
      ({ identifier: injection } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        ${source}
        window.__inputRows=[];window.__owner=null;window.__captures=0;
        window.__windowListeners=[];
        const add=window.addEventListener,remove=window.removeEventListener;
        window.addEventListener=function(type,callback,...rest){
          if(['pointerup','pointercancel','pointermove','blur'].includes(type))
            window.__windowListeners.push({type,callback,removed:false});
          return add.call(this,type,callback,...rest);
        };
        window.removeEventListener=function(type,callback,...rest){
          const row=window.__windowListeners.findLast(r=>r.type===type&&r.callback===callback&&!r.removed);
          if(row)row.removed=true;return remove.call(this,type,callback,...rest);
        };
        for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','wheel','keydown'])
          document.addEventListener(type,e=>{
            const stage=e.target.closest?.('[data-works-stage]');
            if(type==='pointerdown'&&stage&&e.isTrusted)window.__owner=e.pointerId;
            if(type==='gotpointercapture'&&stage)window.__captures++;
            window.__inputRows.push({type,id:e.pointerId,buttons:e.buttons,key:e.key,trusted:e.isTrusted,
              stage:!!stage,stageTarget:e.target===stage,cancelled:e.defaultPrevented});
          });
      ` }));
      await cdp.send('Page.navigate', { url: hosted.origin });
      await until(() => evaluate(`document.readyState==='complete' && [...document.querySelectorAll('astro-island')]
        .filter(i=>/WorksWheelShowcase|timeline/.test(i.getAttribute('component-url'))).every(i=>!i.hasAttribute('ssr'))
        && !!document.querySelector('[data-works-stage]')`), 'actual hero and timeline hydration');
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    };
    const pose = () => evaluate(`(() => {const s=document.querySelector('[data-works-stage]');return {
      turn:s.dataset.turn,draws:s.dataset.draws??null,captured:s.hasPointerCapture(window.__owner??1),
      transforms:[...s.querySelectorAll('[data-work-card]')].map(e=>e.style.transform),
      selected:[...s.querySelectorAll('[aria-selected="true"]')].map(e=>e.dataset.workCard)};})()`);
    const mouse = (type, point, held = false) => cdp.send('Input.dispatchMouseEvent',
      { type, x: point.x, y: point.y, button: held || type !== 'mouseMoved' ? 'left' : 'none',
        buttons: held ? 1 : 0, ...(type !== 'mouseMoved' ? { clickCount: 1 } : {}) });
    const points = () => evaluate(`(() => {const s=document.querySelector('[data-works-stage]'),r=s.getBoundingClientRect();
      const inside={x:r.left+r.width/2,y:r.top+r.height*.6},outside={x:r.left-12,y:inside.y};
      return {inside,outside,insideHit:s.contains(document.elementFromPoint(inside.x,inside.y)),
        outsideHit:!s.contains(document.elementFromPoint(outside.x,outside.y))};})()`);
    const key = async name => {
      const code = { ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Enter: 13 }[name];
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code,
        ...(name === 'Enter' ? { text: '\r' } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, windowsVirtualKeyCode: code });
    };
    const clean = () => { assert.deepEqual(errors, []); assert.deepEqual(cdp.errors, []); };
    const liveListeners = () => evaluate(`window.__windowListeners.filter(r=>!r.removed).map(r=>r.type).sort()`);
    const artworkPoint = () => evaluate(`(async () => {
      for(const a of document.querySelectorAll('[data-hero-photo]')){
        await a.querySelector('img').decode();const r=a.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
        if(y>0&&y<innerHeight&&a.contains(document.elementFromPoint(x,y)))return {x,y,href:a.href,index:Number(a.closest('[data-work-card]').dataset.workCard)};
      }return null;
    })()`);

    await t.test('unmeasured hydrated ring leaves real wheel, keys and pointers native', async () => {
      await load('window.ResizeObserver=undefined;');
      assert.equal(await evaluate(`document.querySelector('[data-works-stage]').getAttribute('role')`), 'group');
      const before = await pose();
      assert.equal(before.draws, null, 'hydrated geometry remains unmeasured');
      const p = await points(); assert.equal(p.insideHit, true);
      const start = await evaluate('scrollY');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p.inside, deltaX: 0, deltaY: 160 });
      await delay(300);
      const wheel = await evaluate(`window.__inputRows.filter(r=>r.type==='wheel').at(-1)`);
      assert.equal(wheel?.trusted, true); assert.equal(wheel?.stage, true);
      assert.equal(wheel.cancelled, false, 'unmeasured stage must not consume the real page wheel');
      assert.ok(await evaluate('scrollY') > start+20, 'wheel inside hero actually scrolls the native page');
      for (const name of ['End', 'Home', 'ArrowDown', 'ArrowUp']) {
        await evaluate(`scrollTo({top:100,behavior:'instant'});document.querySelector('[data-hero-photo]').focus({preventScroll:true})`);
        const y = await evaluate('scrollY'); await key(name); await delay(250);
        const row = await evaluate(`window.__inputRows.filter(r=>r.type==='keydown').at(-1)`);
        assert.equal(row.trusted, true); assert.equal(row.stage, true); assert.equal(row.cancelled, false, `${name} remains native`);
        assert.notEqual(await evaluate('scrollY'), y, `${name} has actual native page behavior`);
      }
      await evaluate(`scrollTo({top:0,behavior:'instant'})`);
      const pointer = await points(); assert.equal(pointer.insideHit, true);
      await mouse('mousePressed', pointer.inside, true);
      await mouse('mouseMoved', { x:pointer.inside.x, y:pointer.inside.y-60 }, true);
      assert.equal((await pose()).captured, false, 'fallback never acquires capture');
      await mouse('mouseReleased', pointer.outside);
      await delay(200); assert.deepEqual(await pose(), before, 'no phantom selection or draw');
      assert.equal(await evaluate('window.__captures'), 0);
      await evaluate(`document.querySelector('[data-hero-photo]').focus({preventScroll:true})`);
      const href = await evaluate('document.activeElement.href'); await key('Enter');
      await until(async () => (await cdp.send('Page.getFrameTree')).frameTree.frame.url === href, 'native Enter opens original artwork URL');
      await load('window.ResizeObserver=undefined;');
      const artwork = await artworkPoint(); assert.ok(artwork, 'hit-tested native artwork is reachable');
      await mouse('mousePressed', artwork, true); await mouse('mouseReleased', artwork);
      await until(async () => (await cdp.send('Page.getFrameTree')).frameTree.frame.url === artwork.href, 'native click opens original artwork URL');
      clean();
    });

    await t.test('outside release before capture cannot turn subsequent mouse hover into a drag', async () => {
      await load(); await until(() => evaluate(`Number(document.querySelector('[data-works-stage]').dataset.draws)>0`), 'measured initial draw');
      const p = await points(); assert.equal(p.insideHit, true); assert.equal(p.outsideHit, true);
      const before = await pose();
      const listeners = await liveListeners();
      await mouse('mousePressed', p.inside, true);
      await mouse('mouseMoved', p.outside, true);
      assert.equal((await pose()).captured, false, 'horizontal exit is below the vertical capture threshold');
      await mouse('mouseReleased', p.outside);
      const release = await evaluate(`window.__inputRows.filter(r=>r.type==='pointerup').at(-1)`);
      assert.equal(release.trusted, true); assert.equal(release.stage, false, 'real release lands outside stage');
      await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-100 });
      await delay(200);
      assert.deepEqual(await pose(), before, 'released mouse hover cannot change actual artwork poses or turn');
      assert.deepEqual(await liveListeners(), listeners, 'outside release removes every acquired global listener');
      clean();
    });

    await t.test('held mouse ownership, captured release and cancellation retire only the owner', async () => {
      await load(); await until(() => evaluate(`Number(document.querySelector('[data-works-stage]').dataset.draws)>0`), 'measured ring');
      const p = await points(); assert.equal(p.insideHit, true); assert.equal(p.outsideHit, true);
      const listeners = await liveListeners();
      await mouse('mousePressed', p.inside, true);
      await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-100 }, true);
      await until(async () => Number((await pose()).turn) > .2, 'normal held vertical mouse drag changes pose');
      assert.equal((await pose()).captured, true);
      const held = await pose();
      // Controlled foreign events test identity rejection, not native multitouch.
      await evaluate(`(() => {const s=document.querySelector('[data-works-stage]');
        for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])
          s.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:77,pointerType:'touch',button:0,buttons:1,clientX:10,clientY:10}));})()`);
      await delay(100); assert.deepEqual(await pose(), held, 'foreign pointer cannot replace, move or end the captured owner');
      await mouse('mouseReleased', p.outside);
      await delay(200); assert.equal((await pose()).captured, false);
      assert.deepEqual(await liveListeners(), listeners, 'captured release removes acquired listener identities');
      const retired = await pose();
      await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-150 }); await delay(150);
      assert.deepEqual(await pose(), retired, 'captured outside release retires hover ownership');
      for (const retirement of ['button loss', 'pointercancel', 'capture loss']) {
        await mouse('mousePressed', p.inside, true);
        await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-50 }, true);
        await delay(100); assert.equal((await pose()).captured, true);
        if (retirement === 'button loss') await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-55 });
        else if (retirement === 'capture loss') await evaluate(`document.querySelector('[data-works-stage]').releasePointerCapture(window.__owner)`);
        else await evaluate(`document.querySelector('[data-works-stage]').dispatchEvent(new PointerEvent('pointercancel',
          {bubbles:true,pointerId:window.__owner,pointerType:'mouse'}))`);
        await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-60 });
        await delay(200); assert.equal((await pose()).captured, false, `${retirement} releases capture`);
        assert.deepEqual(await liveListeners(), listeners, `${retirement} removes acquired listener identities`);
        const stopped = await pose();
        await mouse('mouseMoved', { x:p.inside.x, y:p.inside.y-160 }); await delay(150);
        assert.deepEqual(await pose(), stopped, `${retirement} cannot leave a hover-driven gesture`);
        await mouse('mouseReleased', p.outside);
      }
      clean();
    });

    await t.test('measured controls and clicks work while readiness loss disposes gesture resources', async () => {
      await load(); await until(() => evaluate(`Number(document.querySelector('[data-works-stage]').dataset.draws)>0`), 'measured stage');
      const artwork = await artworkPoint(); assert.ok(artwork, 'enhanced artwork has a legitimate click target');
      await mouse('mousePressed', artwork, true);
      assert.equal((await pose()).captured, false, 'ordinary image click is not captured at pointerdown');
      await mouse('mouseReleased', artwork);
      await until(async () => Number((await pose()).turn) === artwork.index+1, 'click still selects enhanced artwork');
      assert.equal((await cdp.send('Page.getFrameTree')).frameTree.frame.url, hosted.origin+'/', 'enhanced click stays on landing');
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
      await key('End'); await until(async () => Number((await pose()).turn) === 8, 'End still selects last artwork');
      await key('ArrowUp'); await until(async () => Number((await pose()).turn) === 7, 'ArrowUp still selects previous artwork');
      await key('Home'); await until(async () => Number((await pose()).turn) === 0, 'Home restores original ring');
      const p = await points(); assert.equal(p.insideHit, true);
      const listeners = await liveListeners();
      await mouse('mousePressed', p.inside, true);
      await mouse('mouseMoved', {x:p.inside.x,y:p.inside.y-60}, true);
      await delay(100); assert.equal((await pose()).captured, true);
      // A real layout change invokes the native ResizeObserver with zero height.
      await evaluate(`document.querySelector('[data-works-stage]').style.height='0px'`);
      await until(() => evaluate(`document.querySelector('[data-works-stage]').getAttribute('role')==='group'`), 'actual measured readiness loss');
      assert.equal((await pose()).captured, false);
      assert.deepEqual(await liveListeners(), listeners, 'readiness teardown releases owned listeners');
      assert.equal((await pose()).turn, '0');
      assert.ok((await pose()).transforms.every(p=>p===''), 'readiness loss restores CSS-owned poses');
      assert.equal(await evaluate(`document.querySelector('[data-work-card]').style.getPropertyValue('--ring-angle')`), '0deg', 'React ring variables survive cleanup');
      await mouse('mouseReleased', p.outside);
      await evaluate(`document.querySelector('[data-works-stage]').style.removeProperty('height')`);
      await until(() => evaluate(`document.querySelector('[data-works-stage]').getAttribute('role')==='listbox'`), 'native measurement reentry');
      await delay(200); const restored = await pose();
      await mouse('mouseMoved', {x:p.inside.x,y:p.inside.y-100}); await delay(150);
      assert.deepEqual(await pose(), restored, 'reentry has no retained target, gesture or idle RAF');
      clean();
    });

    await t.test('real touch horizontal drag and cancellation preserve vertical native page pan', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:true,maxTouchPoints:2});
      await load(); await until(() => evaluate(`Number(document.querySelector('[data-works-stage]').dataset.draws)>0`), 'mobile measured ring');
      const p = await evaluate(`(() => {const s=document.querySelector('[data-works-stage]'),r=s.getBoundingClientRect();
        for(let y=Math.max(100,r.top+20);y<Math.min(innerHeight-100,r.bottom);y+=20)
          for(let x=r.left+90;x<r.right-20;x+=20)
            if(s.contains(document.elementFromPoint(x,y)))return {x,y};return null;})()`);
      assert.ok(p, 'touch starts on actual stage hit target');
      const touch = (type, point) => cdp.send('Input.dispatchTouchEvent',
        {type,touchPoints:point?[{...point,id:1,radiusX:2,radiusY:2}]:[]});
      const listeners = await liveListeners();
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`); await key('ArrowDown');
      await until(async () => Number((await pose()).turn) === 1, 'mobile front artwork selected');
      const artwork = await artworkPoint(); assert.ok(artwork, 'touch hits the actual front image');
      await touch('touchStart', {x:artwork.x,y:artwork.y});
      await touch('touchMove', {x:artwork.x-35,y:artwork.y});
      await touch('touchMove', {x:artwork.x-70,y:artwork.y});
      await until(async () => Number((await pose()).turn) > 1.15, 'real horizontal artwork touch survives implicit capture transfer');
      assert.equal(await evaluate(`window.__inputRows.filter(r=>r.type==='pointerdown'&&r.trusted).at(-1).stageTarget`), false,
        'touch begins on artwork descendant, not the stage itself');
      await touch('touchCancel'); await delay(200);
      assert.equal((await pose()).captured, false);
      assert.deepEqual(await liveListeners(), listeners, 'native touch cancellation disposes ownership');
      assert.equal(await evaluate(`window.__inputRows.some(r=>r.type==='pointercancel'&&r.trusted)`), true, 'native pointercancel receipt');
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`); await key('Home');
      await delay(100); const y = await evaluate('scrollY');
      await touch('touchStart', p);
      for(let step=1;step<=5;step++) {await touch('touchMove', {x:p.x,y:p.y-step*25}); await delay(30);}
      await touch('touchEnd'); await delay(250);
      assert.ok(await evaluate('scrollY')>y+30, 'vertical touch on hero actually pans native page');
      assert.equal((await pose()).turn, '0', 'vertical page pan never selects an artwork');
      assert.deepEqual(await liveListeners(), listeners);
      clean();
    });
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
    if (browser.exitCode === null) browser.kill();
    hosted.server.closeAllConnections(); await new Promise(done => hosted.server.close(done));
  }
});

test('observer ownership and reduced-motion drag', { timeout: 150000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const timelinePath = [...html.matchAll(/component-url="([^"]+)"/g)].map(m => m[1]).find(p => /timeline\./.test(p));
  const timelineModule = await readFile(join(root, timelinePath), 'utf8');
  const triggerPath = new URL(timelineModule.match(/import\(["'`]([^"'`()]*ScrollTrigger[^"'`()]*)["'`]\)/)[1],
    `http://localhost${timelinePath}`).pathname;
  const triggerModule = await readFile(join(root, triggerPath), 'utf8');
  const triggerSymbol = triggerModule.match(/([\w$]+) as ScrollTrigger\b/)[1];
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-ownership-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp, injection, instrument = false, errors = [], moduleReceipts = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned ownership browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const url = new URL(request.url);
      const allowed = url.origin === hosted.origin || url.protocol === 'data:'
        || (url.protocol === 'blob:' && request.url.startsWith(`blob:${hosted.origin}/`));
      if (instrument && url.origin === hosted.origin && url.pathname === triggerPath) {
        const body = triggerModule + `\nwindow.__instrumentTrigger(${triggerSymbol});`;
        await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(body).toString('base64') });
        moduleReceipts.push(url.pathname);
      } else await cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') errors.push(args.map(a => a.value ?? a.description).join(' '));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Target.activateTarget', { targetId: page.id }); await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const reduce = value => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    const load = async (source = '', fault = false) => {
      if (injection) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
      errors = []; moduleReceipts = []; instrument = fault;
      ({ identifier: injection } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: source || ';' }));
      await cdp.send('Page.navigate', { url: hosted.origin });
      await until(() => evaluate(`document.readyState==='complete' && [...document.querySelectorAll('astro-island')]
        .filter(i=>/WorksWheelShowcase|timeline/.test(i.getAttribute('component-url'))).every(i=>!i.hasAttribute('ssr'))
        && !!document.querySelector('[data-works-stage]')`), 'real hero and timeline hydration');
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    };
    const clean = () => { assert.deepEqual(errors, [], 'no unaccounted browser errors'); assert.deepEqual(cdp.errors, []); };
    const key = async key => {
      const code = { Enter: 13, ArrowRight: 39, Home: 36 }[key];
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code,
        ...(key === 'Enter' ? { text: '\r' } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
    };
    await t.test('missing ResizeObserver retains the hydrated native eight-artwork ring', async () => {
      await reduce('reduce');
      await load(`window.ResizeObserver=undefined;window.__heroOriginal=null;
        const watch=new MutationObserver(()=>{const a=document.querySelector('[data-hero-photo]');
          if(a&&!window.__heroOriginal){window.__heroOriginal=a;window.__heroImages=[...document.querySelectorAll('[data-hero-photo] img')].map(i=>i.getAttribute('src'));watch.disconnect();}});
        watch.observe(document,{childList:true,subtree:true});`);
      t.diagnostic(`Missing observer runtime errors: ${JSON.stringify(errors)}`);
      clean();
      assert.equal(await evaluate(`window.__heroOriginal===document.querySelector('[data-hero-photo]')`), true);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-hero-photo] img')].map(i=>i.getAttribute('src'))`),
        await evaluate('window.__heroImages'));
      assert.equal(await evaluate(`document.querySelectorAll('[data-hero-photo]').length`), 8);
      assert.equal(await evaluate(`document.querySelector('[data-works-stage]').getAttribute('role')`), 'group');
      assert.equal(await evaluate(`document.querySelector('[data-timeline]').hasAttribute('data-enhanced')`), false);
      await evaluate(`document.querySelector('[data-hero-photo]').focus({preventScroll:true})`);
      const href = await evaluate(`document.activeElement.href`);
      await key('Enter');
      await until(async () => (await cdp.send('Page.getFrameTree')).frameTree.frame.url === href, 'native hydrated artwork keyboard navigation');
      clean();
      await reduce('no-preference'); await load(`window.ResizeObserver=undefined;
        window.__guardListeners=0;window.__instrumentTrigger=ST=>{const add=ST.addEventListener;
          ST.addEventListener=function(...args){window.__guardListeners++;return add.apply(this,args);};};`, true);
      await until(() => evaluate('window.__guardListeners===2'), 'timeline plugin setup completed with only effect-level listeners');
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      assert.equal(await evaluate(`document.querySelector('[data-timeline]').hasAttribute('data-enhanced')`), false,
        'otherwise eligible timeline preflights the missing observer');
      assert.equal(await evaluate(`document.querySelectorAll('[data-work-card]').length===8
        && [...document.querySelectorAll('[data-work-card]')].every(e=>!e.style.transform && e.getBoundingClientRect().width>0)`), true,
        'unmeasured hydrated hero keeps the CSS ring pose');
      const target = await evaluate(`(async () => {const a=document.querySelectorAll('[data-hero-photo]')[2];
        await a.querySelector('img').decode();a.scrollIntoView({block:'center',behavior:'instant'});
        const r=a.getBoundingClientRect();return {href:a.href,x:r.x+r.width/2,y:r.y+r.height/2,
          hit:a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      assert.equal(target.hit, true, 'native artwork pointer target is reachable');
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent',
        { type, button: 'left', clickCount: 1, x: target.x, y: target.y });
      await until(async () => (await cdp.send('Page.getFrameTree')).frameTree.frame.url === target.href, 'native hydrated artwork pointer navigation');
      clean();
    });
    await t.test('reduced held drag publishes direct poses without stale-target redraw or idle animation', async () => {
      await reduce('reduce'); await load(`window.__pointerReceipt={id:null,captured:0,lost:0};
        document.addEventListener('gotpointercapture',e=>{if(e.target.matches('.pl-root')){window.__pointerReceipt.id=e.pointerId;window.__pointerReceipt.captured++;}});
        document.addEventListener('lostpointercapture',e=>{if(e.target.matches('.pl-root'))window.__pointerReceipt.lost++;});`);
      await evaluate(`document.querySelector('#formacion').scrollIntoView({block:'center',behavior:'instant'})`);
      await until(() => evaluate(`document.querySelector('.pl-root')?.dataset.reduced==='true'`), 'visible reduced gallery');
      await delay(300);
      const pose = () => evaluate(`(() => {const r=document.querySelector('.pl-root');return {offset:Number(r.dataset.offset),
        draws:Number(r.dataset.draws),drag:r.dataset.drag,velocity:Number(r.dataset.velocity),
        transforms:[...r.querySelectorAll('.pl-card')].map(e=>e.style.transform)};})()`);
      const before = await pose();
      const point = await evaluate(`(() => {const r=document.querySelector('.pl-root').getBoundingClientRect();return {x:r.x+r.width*.6,y:r.y+100};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x-70, y: point.y });
      const held = await pose();
      t.diagnostic(`Held reduced drag: ${JSON.stringify({before,held})}`);
      assert.equal(held.drag, '1');
      assert.equal(await evaluate(`document.querySelector('.pl-root').hasPointerCapture(window.__pointerReceipt.id)`), true);
      assert.ok(Math.abs(held.offset-before.offset-70)<.2, 'held pointer publishes direct offset before release');
      assert.notDeepEqual(held.transforms, before.transforms, 'actual rendered cards follow held pointer');
      await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
      const redrawn = await pose();
      assert.ok(redrawn.draws>held.draws, 'visibility notification actually redraws the held pose');
      assert.equal(redrawn.offset, held.offset, 'legitimate controller redraw cannot restore stale target');
      const idle = await pose(); await delay(150); assert.deepEqual(await pose(), idle, 'held reduced mode schedules no idle draws');
      assert.ok(idle.transforms.every(p=>new RegExp('rotate\\(0(?:\\.0+)?rad\\)$').test(p)), 'every card has zero reduced swing');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: point.x-70, y: point.y });
      assert.equal((await pose()).drag, '0'); assert.equal((await pose()).velocity, 0);
      assert.equal((await pose()).offset, before.offset, 'release selects the nearest pose without velocity projection');
      assert.equal(await evaluate(`document.querySelector('.pl-root').hasPointerCapture(window.__pointerReceipt.id)`), false,
        'native release clears owned pointer capture');
      // A second real held gesture exercises the cancellation path without
      // changing the browser's native pointer acquisition and movement.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x-35, y: point.y });
      await evaluate(`document.querySelector('.pl-root').dispatchEvent(new PointerEvent('pointercancel',
        {bubbles:true,pointerId:window.__pointerReceipt.id,pointerType:'mouse'}))`);
      assert.equal((await pose()).drag, '0');
      assert.equal(await evaluate(`document.querySelector('.pl-root').hasPointerCapture(window.__pointerReceipt.id)`), false,
        'cancellation clears owned capture');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: point.x-35, y: point.y });
      await evaluate(`document.querySelector('.pl-root').focus({preventScroll:true})`); await key('ArrowRight');
      assert.ok((await pose()).offset>idle.offset, 'reduced keyboard navigation still publishes a destination');
      await key('Home');
      await reduce('no-preference');
      await until(() => evaluate(`!!document.querySelector('[data-timeline]').dataset.enhanced`), 'live normal timeline layout');
      await evaluate(`document.querySelector('.pl-root').scrollIntoView({block:'center',behavior:'instant'})`);
      await until(() => evaluate(`document.querySelector('.pl-root').dataset.reduced==='false'`), 'live normal preference');
      await reduce('reduce');
      await until(() => evaluate(`!document.querySelector('[data-timeline]').dataset.enhanced`), 'live static timeline layout');
      await evaluate(`document.querySelector('.pl-root').scrollIntoView({block:'center',behavior:'instant'})`);
      await until(() => evaluate(`document.querySelector('.pl-root').dataset.reduced==='true'`), 'live reduced preference');
      await delay(300); // Allow the finite layout/visibility notifications to settle.
      const settled = await pose(); await delay(150); assert.deepEqual(await pose(), settled, 'live reduced mode stops animation');
      clean();
    });
    await t.test('timeline acquisition failure releases its real global callback, focus owner and queued refresh', async () => {
      await reduce('no-preference');
      const ownershipSource = `window.__failTimeline=true;
        window.__ownership={rows:[],images:[],failed:false,disconnected:false,queued:[],cancelled:[]};
        const addImage=EventTarget.prototype.addEventListener,removeImage=EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener=function(type,callback,...rest){
          if(type==='load'&&this instanceof HTMLImageElement&&this.closest('[data-timeline]'))
            window.__ownership.images.push({element:this,callback,removed:false});
          return addImage.call(this,type,callback,...rest);
        };
        EventTarget.prototype.removeEventListener=function(type,callback,...rest){
          const row=window.__ownership.images.findLast(r=>r.element===this&&r.callback===callback&&!r.removed);
          if(type==='load'&&row)row.removed=true;return removeImage.call(this,type,callback,...rest);
        };
        window.__instrumentTrigger=ST=>{
          window.__ST=ST;const add=ST.addEventListener,remove=ST.removeEventListener;
          ST.addEventListener=function(type,callback){window.__ownership.rows.push({type,callback,removed:false});return add.call(this,type,callback);};
          ST.removeEventListener=function(type,callback){const row=window.__ownership.rows.findLast(r=>r.type===type&&r.callback===callback&&!r.removed);
            if(row)row.removed=true;return remove.call(this,type,callback);};
        };
        const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame;
        window.requestAnimationFrame=callback=>{const id=request(callback);if(window.__queueReceipt)window.__ownership.queued.push(id);return id;};
        window.cancelAnimationFrame=id=>{window.__ownership.cancelled.push(id);cancel(id);};
        const Native=window.ResizeObserver;
        window.ResizeObserver=class {
          constructor(callback){this.callback=callback;this.native=new Native(callback);this.timeline=false;}
          observe(element){
            if(element.matches('[data-timeline-canvas]')){this.timeline=true;this.native.observe(element);
              window.__ownership.local=window.__ownership.rows.findLast(r=>r.type==='refresh');
              window.__ownership.refresh=this.callback;
              window.__queueReceipt=true;this.callback([]);window.__queueReceipt=false;return;}
            if(window.__failTimeline&&this.timeline&&element.matches('[data-timeline-track]')){window.__ownership.failed=true;throw new Error('Controlled timeline observe failure');}
            this.native.observe(element);
          }
          unobserve(element){this.native.unobserve(element);}
          disconnect(){if(this.timeline)window.__ownership.disconnected=true;this.native.disconnect();}
        };`;
      await load(ownershipSource, true);
      await until(() => evaluate('window.__ownership.failed'), 'controlled observer failure after local refresh acquisition');
      assert.deepEqual(moduleReceipts, [triggerPath], 'exact real built GSAP module instrumented once');
      const receipt = await evaluate(`({failed:window.__ownership.failed,local:!!window.__ownership.local,
        removed:window.__ownership.local?.removed,disconnected:window.__ownership.disconnected,
        queued:window.__ownership.queued,cancelled:window.__ownership.cancelled,
        live:window.__ownership.rows.filter(r=>!r.removed).map(r=>r.type),
        enhanced:document.querySelector('[data-timeline]').hasAttribute('data-enhanced')})`);
      t.diagnostic(`Partial timeline ownership receipts: ${JSON.stringify(receipt)}`);
      assert.equal(receipt.local, true, 'failure occurs after actual global callback registration');
      assert.equal(receipt.removed, true, 'same callback identity is released on partial failure');
      assert.equal(receipt.disconnected, true, 'partially acquired observer is disconnected');
      assert.ok(receipt.queued.length>0 && receipt.queued.every(id=>receipt.cancelled.includes(id)), 'owned queued refresh is cancelled');
      assert.deepEqual(receipt.live, [], 'all acquired global refresh listeners released');
      assert.equal(receipt.enhanced, false);
      assert.equal(await evaluate('window.__ownership.images.filter(r=>r.callback===window.__ownership.refresh).length'), 0,
        'failure precedes owned image listener acquisition (React native load listeners are separate)');
      assert.equal(await evaluate(`document.querySelectorAll('[data-timeline] .timeline-split-line, [data-timeline] [data-reached]').length`), 0);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-timeline-track]')).transform`), 'none');
      const scroll = await evaluate(`(() => {document.querySelector('[data-timeline]').scrollIntoView({block:'start',behavior:'instant'});return scrollY;})()`);
      await evaluate(`document.querySelectorAll('[data-timeline-image]')[5].focus({preventScroll:true})`);
      assert.equal(await evaluate('scrollY'), scroll, 'retired desktop focus aligner cannot move native static page');
      await evaluate('window.__ST.refresh()'); clean();
      const queued = await evaluate('window.__ownership.queued.length');
      await evaluate('window.__queueReceipt=true;window.__ownership.refresh([]);window.__queueReceipt=false;');
      assert.equal(await evaluate('window.__ownership.queued.length'), queued, 'retired observer callback cannot schedule work');
      await load(ownershipSource.replace('window.__failTimeline=true', 'window.__failTimeline=false'), true);
      await until(() => evaluate(`document.querySelector('[data-timeline]').dataset.ownedTriggers==='22'`), 'normal acquired desktop enhancement');
      assert.equal(await evaluate('window.__ownership.rows.filter(r=>!r.removed).length'), 3);
      await reduce('reduce');
      await until(() => evaluate(`!document.querySelector('[data-timeline]').dataset.enhanced`), 'normal context teardown');
      assert.equal(await evaluate('window.__ownership.local.removed && window.__ownership.disconnected'), true,
        'normal teardown releases the same local callback and observer');
      assert.equal(await evaluate('window.__ownership.rows.filter(r=>!r.removed).length'), 2, 'only the two effect-level refresh listeners remain');
      assert.equal(await evaluate(`(() => {const rows=window.__ownership.images.filter(r=>r.callback===window.__ownership.refresh);
        return rows.length===6&&rows.every(r=>r.removed);})()`), true,
        'normal teardown removes each acquired image-load callback');
      const afterTeardown = await evaluate('window.__ownership.queued.length');
      await evaluate(`(async()=>{window.__queueReceipt=true;window.__ownership.refresh([]);
        document.querySelectorAll('[data-timeline] img').forEach(i=>i.dispatchEvent(new Event('load')));
        await document.fonts.ready;window.__queueReceipt=false;})()`);
      assert.equal(await evaluate('window.__ownership.queued.length'), afterTeardown, 'retired load and observer callbacks schedule no refresh');
      assert.equal(await evaluate(`document.querySelectorAll('[data-timeline] .timeline-split-line, [data-timeline] [data-reached]').length`), 0);
      await reduce('no-preference');
      await until(() => evaluate(`document.querySelector('[data-timeline]').dataset.ownedTriggers==='22'`), 'clean enhancement reentry');
      assert.equal(await evaluate('window.__ownership.rows.filter(r=>!r.removed).length'), 3, 'reentry does not duplicate global callbacks');
      clean();
    });
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
    if (browser.exitCode === null) browser.kill();
    hosted.server.closeAllConnections(); await new Promise(done => hosted.server.close(done));
  }
});

test('progressive enhancement capability fallbacks', { timeout: 150000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const siblingModules = [...html.matchAll(/<astro-island\b[^>]*component-url="([^"]+)"[^>]*>/g)]
    .map(match => match[1]).filter(url => /WorksWheelShowcase|timeline/.test(url));
  assert.equal(siblingModules.length, 2, 'exact sibling island modules identified for observer isolation');
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-capability-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp, injection, isolate = false;
  let errors = [], faults = [], modalReads = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned capability browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const url = new URL(request.url);
      const allowed = url.origin === hosted.origin || url.protocol === 'data:'
        || (url.protocol === 'blob:' && request.url.startsWith(`blob:${hosted.origin}/`));
      const sibling = isolate && url.origin === hosted.origin && siblingModules.includes(url.pathname);
      await cdp.send(allowed && !sibling ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(allowed && !sibling ? {} : { errorReason: 'BlockedByClient' }) });
      if (sibling) faults.push({ url: request.url, acknowledged: true });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') errors.push(args.map(value => value.value ?? value.description).join(' '));
      if (args[0]?.value === '__modalCapabilityRead') modalReads.push(args[1].value);
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const key = async key => {
      const codes = { Tab: 9, Escape: 27, Enter: 13, ArrowRight: 39, ' ': 32 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : key,
        windowsVirtualKeyCode: codes[key], ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: codes[key] });
    };
    const click = async selector => {
      const point = await evaluate(`(() => {
        const element=document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({block:'center',behavior:'instant'});
        const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
        return {x,y,hit:element.contains(document.elementFromPoint(x,y))};
      })()`);
      assert.equal(point.hit, true, `${selector}: actual pointer target is reachable`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent',
        { type, button: 'left', clickCount: 1, x: point.x, y: point.y });
    };
    const load = async ({ disabled = false, missing = null, siblings = false } = {}) => {
      if (injection) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection });
      isolate = siblings;
      errors = []; faults = []; modalReads = [];
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: disabled });
      ({ identifier: injection } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        ${missing === 'showModal' ? 'HTMLDialogElement.prototype.showModal=undefined;' : missing === 'throwModal'
          ? 'HTMLDialogElement.prototype.showModal=function(){throw new DOMException("Injected modal failure","InvalidStateError");};'
          : missing ? `window.${missing}=undefined;` : ''}
        window.__originalFormation=null;
        const observer=new MutationObserver(()=>{
          const node=document.querySelector('[data-polaroid-fallback]');
          if(node&&!window.__originalFormation){window.__originalFormation=node;observer.disconnect();}
        });observer.observe(document,{childList:true,subtree:true});
      ` }));
      const previous = (await cdp.send('Page.getFrameTree')).frameTree.frame;
      const navigation = await cdp.send('Page.navigate', { url: hosted.origin });
      assert.equal(navigation.errorText, undefined);
      assert.ok(navigation.loaderId && navigation.loaderId !== previous.loaderId, 'fresh native loader');
      await until(async () => {
        const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame;
        return frame.loaderId === navigation.loaderId && await evaluate(`document.readyState==='complete'
          && !!document.querySelector('astro-island[component-url*="FormationPolaroid"]')`);
      }, 'fresh document parsed');
      t.diagnostic(`fresh capability document: ${JSON.stringify({ missing, disabled, loader: navigation.loaderId })}`);
      return navigation;
    };
    const hydrated = async selector => {
      await until(() => evaluate(`(() => {const island=document.querySelector(${JSON.stringify(selector === '[data-formation-polaroid]'
        ? 'astro-island[component-url*="FormationPolaroid"]' : 'astro-island[component-url*="timeline."]')});
        return island && !island.hasAttribute('ssr');})()`), `${selector}: Astro hydration completed`).catch(async error => {
        t.diagnostic(`hydration failure: ${JSON.stringify({selector, errors, faults, state:await evaluate(`({original:!!window.__originalFormation,
          connected:window.__originalFormation?.isConnected,islands:[...document.querySelectorAll('astro-island')].map(i=>({url:i.getAttribute('component-url'),ssr:i.hasAttribute('ssr')}))})`)})}`);
        throw error;
      });
      // The island event precedes React passive effects; cross two native frames.
      await evaluate(`new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
    };
    const noUnexpectedErrors = () => {
      const unexpected = errors.filter(error => !faults.some(fault =>
        error.includes(fault.url) && /Failed to fetch dynamically imported module|Error hydrating/.test(error)));
      assert.deepEqual(unexpected, [], 'no unaccounted runtime or console errors');
      assert.deepEqual(cdp.errors, [], 'CDP interception has no errors');
    };
    const clearFragment = async id => {
      await until(() => evaluate(`location.hash==='#${id}' && document.querySelector('#${id}').getBoundingClientRect().top
        >= document.querySelector('header').getBoundingClientRect().bottom-1`), `${id}: native fragment clears sticky header`);
    };

    await t.test('mobile links work before scripts and desktop navigation is unchanged', async () => {
      await load({ disabled: true });
      t.diagnostic(`no-JS mobile visibility: ${JSON.stringify(await evaluate(`({links:[...document.querySelectorAll('#mobile-menu a')]
        .filter(a=>a.getClientRects().length).length,toggle:getComputedStyle(document.querySelector('#menu-toggle')).display})`))}`);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#menu-toggle')).display==='none'`), true,
        'no inert toggle is painted without scripts');
      assert.equal(await evaluate(`[...document.querySelectorAll('#mobile-menu a')].filter(a=>a.getClientRects().length).length`), 4,
        'all four mobile links are visible without scripts');
      await evaluate(`document.querySelector('#mobile-menu a').focus()`);
      await key('Enter'); await clearFragment('blockchain');
      for (const id of ['ia', 'formacion', 'contacto']) {
        await click(`#mobile-menu a[href="#${id}"]`); await clearFragment(id);
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
      await click('#mobile-menu a[href="#blockchain"]'); await clearFragment('blockchain');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate(`document.querySelector('#mobile-menu').getClientRects().length`), 0);
      assert.equal(await evaluate(`[...document.querySelectorAll('nav[aria-label="Principal"] a')].filter(a=>a.getClientRects().length).length`), 4);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      noUnexpectedErrors();
    });

    await t.test('Escape restores a focused menu link without stealing outside or fragment focus', async () => {
      await load();
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#mobile-menu')).display`), 'none', 'enhancement starts collapsed');
      await click('#menu-toggle'); await key('Tab');
      assert.equal(await evaluate(`document.activeElement===document.querySelector('#mobile-menu a')`), true, 'real Tab enters menu');
      const scrollBeforeEscape = await evaluate('scrollY');
      await key('Escape');
      assert.equal(await evaluate(`document.activeElement===document.querySelector('#menu-toggle')`), true, 'Escape returns focus from hidden link');
      assert.equal(await evaluate('scrollY'), scrollBeforeEscape, 'focus restoration does not move the page');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#mobile-menu')).display`), 'none');
      await click('#menu-toggle');
      await evaluate(`document.querySelector('header > div a').focus()`);
      await key('Escape');
      assert.equal(await evaluate(`document.activeElement===document.querySelector('header > div a')`), true);
      await click('#menu-toggle'); await key('Tab'); await key('Enter'); await clearFragment('blockchain');
      assert.equal(await evaluate(`document.activeElement===document.querySelector('#menu-toggle')`), false, 'ordinary navigation does not steal focus');
      noUnexpectedErrors();
    });

    for (const missing of ['ResizeObserver', 'IntersectionObserver']) await t.test(`formation retains original native gallery without ${missing}`, async () => {
      await load({ missing, siblings: true });
      await hydrated('[data-formation-polaroid]');
      assert.equal(await evaluate(`typeof window.${missing}`), 'undefined');
      await until(() => new Set(faults.map(fault => new URL(fault.url).pathname)).size === 2,
        'both exact sibling modules failed with acknowledged receipts');
      await until(() => siblingModules.every(path => errors.some(error => error.includes(hosted.origin + path)
        && /Error hydrating.*Failed to fetch dynamically imported module/.test(error))), 'both explicit expected sibling import failures reported');
      t.diagnostic(`isolated siblings: ${JSON.stringify(faults)}`);
      t.diagnostic(`hydrated formation ${missing}: ${JSON.stringify({errors, originalConnected:await evaluate('window.__originalFormation?.isConnected')})}`);
      assert.equal(await evaluate(`!!window.__originalFormation?.isConnected
        && window.__originalFormation===document.querySelector('[data-polaroid-fallback]')`), true,
        'hydrated formation keeps the original SSR viewport connected');
      assert.equal(await evaluate(`document.querySelectorAll('[data-polaroid-fallback] figure').length`), 6);
      assert.equal(await evaluate(`document.querySelectorAll('[data-formation-polaroid] .pl-root').length`), 0);
      for (let index = 0; index < 6; index++) {
        await evaluate(`document.querySelectorAll('[data-polaroid-fallback] figure')[${index}].scrollIntoView({block:'center',inline:'center',behavior:'instant'})`);
        await until(() => evaluate(`(() => {const f=document.querySelectorAll('[data-polaroid-fallback] figure')[${index}],i=f.querySelector('img');
          return i.complete&&i.naturalWidth>0&&f.querySelector('figcaption').textContent.length>15;})()`), `native photo ${index + 1} decoded with caption`);
      }
      await evaluate(`document.querySelector('[data-polaroid-fallback]').scrollTo({left:0,behavior:'instant'})`);
      await click('[data-polaroid-fallback]'); await key('ArrowRight');
      await until(() => evaluate(`document.querySelector('[data-polaroid-fallback]').scrollLeft>20`), 'real native keyboard scroll');
      await click('.fallback-links a:nth-child(6)');
      await until(() => evaluate(`document.querySelector('[data-polaroid-fallback]').scrollLeft
        >document.querySelector('[data-polaroid-fallback]').clientWidth*4`), 'native sixth-photo link');
      noUnexpectedErrors();
    });

    await t.test('supported formation still enhances', async () => {
      await load(); await hydrated('[data-formation-polaroid]');
      await until(() => evaluate(`!!document.querySelector('[data-formation-polaroid] .pl-root')`), 'supported enhancement');
      assert.equal(await evaluate(`document.querySelectorAll('[data-polaroid-fallback]').length`), 0);
      noUnexpectedErrors();
    });

    for (const activation of ['click', 'Enter']) await t.test(`native image ${activation} works without showModal`, async () => {
      const navigation = await load({ missing: 'showModal' }); await hydrated('[data-timeline]');
      const href = await evaluate(`document.querySelector('[data-timeline-image]').href`);
      const before = await evaluate(`({modal:!!document.querySelector('dialog[open]'),locked:document.body.style.overflow==='hidden'})`);
      assert.deepEqual(before, { modal: false, locked: false });
      if (activation === 'click') await click('[data-timeline-image]');
      else { await evaluate(`document.querySelector('[data-timeline-image]').focus()`); await key('Enter'); }
      await until(async () => {
        const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame;
        return frame.url === href && frame.loaderId !== navigation.loaderId;
      }, `native ${activation} follows original full image URL in new loader`);
      assert.equal(await evaluate(`!!document.querySelector('dialog[open]') || document.body.style.overflow==='hidden'`), false);
      noUnexpectedErrors();
    });

    for (const failure of ['throwModal', 'capability removed between handler and effect']) await t.test(`lightbox boundary falls back when ${failure}`, async () => {
      const navigation = await load({ missing: failure === 'throwModal' ? failure : null });
      await hydrated('[data-timeline]');
      const href = await evaluate(`document.querySelector('[data-timeline-image]').href`);
      if (failure !== 'throwModal') await evaluate(`(() => {
        const native=HTMLDialogElement.prototype.showModal;let reads=0;
        Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,get(){
          console.log('__modalCapabilityRead',++reads);return reads===1?native:undefined;
        }});
      })()`);
      await click('[data-timeline-image]');
      await until(async () => {
        const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame;
        return frame.url === href && frame.loaderId !== navigation.loaderId;
      }, 'guarded effect explicitly delivers full image without scroll lock or uncaught failure');
      if (failure !== 'throwModal') assert.deepEqual(modalReads, [1, 2], 'handler sees modal support but effect sees its removal');
      noUnexpectedErrors();
    });

    await t.test('unsupported Space and modified or pre-cancelled activation retain native ownership', async () => {
      await load({ missing: 'showModal' }); await hydrated('[data-timeline]');
      const cancellation = await evaluate(`(() => {
        const a=document.querySelector('[data-timeline-image]');
        const event=new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true});
        a.dispatchEvent(event);return event.defaultPrevented;
      })()`);
      assert.equal(cancellation, false, 'unsupported Space is not consumed');
      await load(); await hydrated('[data-timeline]');
      const receipts = await evaluate(`(() => {
        const a=document.querySelector('[data-timeline-image]'),rows=[];
        // Inspect cancellation after React, then prevent synthetic native navigation.
        const stop=event=>{rows.push(event.defaultPrevented);event.preventDefault();};
        document.addEventListener('click',stop);
        for(const init of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])
          a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,...init}));
        document.removeEventListener('click',stop);
        const prior=new MouseEvent('click',{bubbles:true,cancelable:true});prior.preventDefault();a.dispatchEvent(prior);
        return {rows,modal:!!document.querySelector('dialog[open]')};
      })()`);
      assert.deepEqual(receipts.rows, [false, false, false, false, false], 'React leaves modified and alternate-button clicks uncancelled');
      await evaluate(`new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
      assert.equal(await evaluate(`!!document.querySelector('dialog[open]')`), false, 'pre-cancelled clicks do not open modal');
      await evaluate(`document.querySelector('[data-timeline-image]').focus()`); await key(' ');
      await until(() => evaluate(`!!document.querySelector('dialog[open]')
        && document.querySelector('dialog[open]').contains(document.activeElement)`), 'supported real Space opens focused modal');
      await key('Escape');
      await until(() => evaluate(`!document.querySelector('dialog[open]')
        && document.activeElement===document.querySelector('[data-timeline-image]')`), 'Space modal close restores invoking focus');
      noUnexpectedErrors();
    });
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
    if (browser.exitCode === null) browser.kill();
    await new Promise(done => hosted.server.close(done));
  }
});

test('timeline mobile chronology is readable', { timeout: 90000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-timeline-readable-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned readability browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const local = new URL(request.url).origin === hosted.origin;
      await cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) });
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const metrics = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    const reduce = value => cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value }] });
    let captureSerial = 0;
    const capture = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = `${profile}-${name}-${++captureSerial}.png`;
      await writeFile(path, Buffer.from(data, 'base64'));
      t.diagnostic(`Capture: ${path}`);
    };
    const decorations = async (description, fallback = false) => {
      const value = await evaluate(`(() => {
        const root=document.querySelector('[data-timeline]'),canvas=root.querySelector('[data-timeline-canvas]');
        const line=root.querySelector('[data-journey-line]'),lr=line.getBoundingClientRect(),ls=getComputedStyle(line);
        const track=root.querySelector('[data-timeline-track]'),tr=track.getBoundingClientRect();
        const rail=getComputedStyle(track,'::before'),dots=[...root.querySelectorAll('[data-dot]')];
        const lum=color=>color.match(/[0-9.]+/g).slice(0,3).map(Number).map(n=>n/255)
          .map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
        const contrast=rail.backgroundColor==='rgba(0, 0, 0, 0)'?0:
          (lum(rail.backgroundColor)+.05)/(lum(getComputedStyle(root).backgroundColor)+.05);
        return {viewport:[innerWidth,innerHeight],tall:matchMedia('(min-height: 800px)').matches,
          reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
          enhanced:root.dataset.enhanced??null,mode:root.dataset.mode??null,triggers:Number(root.dataset.ownedTriggers||0),
          canvas:{position:getComputedStyle(canvas).position,overflow:getComputedStyle(canvas).overflow},
          rail:{content:rail.content,width:parseFloat(rail.width),height:parseFloat(rail.height),opacity:rail.opacity,
            transform:rail.transform,contrast,left:tr.left+parseFloat(rail.left),top:tr.top+parseFloat(rail.top)},
          line:{display:ls.display,visibility:ls.visibility,width:lr.width,height:lr.height,transform:ls.transform},
          dots:dots.map(dot=>{const r=dot.getBoundingClientRect(),s=getComputedStyle(dot);
            return {display:s.display,visibility:s.visibility,width:r.width,height:r.height,
              reached:dot.getAttribute('data-reached'),transform:s.transform,shadow:s.boxShadow,
              contained:r.left>=tr.left-10&&r.right<=tr.right&&r.top>=tr.top-1&&r.bottom<=tr.bottom+1,
              railCenterDelta:ls.display==='none'||s.display==='none'?null:r.x+r.width/2-(lr.x+lr.width/2)};})};
      })()`);
      t.diagnostic(`Timeline decorations ${description}: ${JSON.stringify(value)}`);
      assert.ok(value.dots.every(dot=>dot.display==='block'&&dot.width>=10&&dot.height>=10&&dot.visibility==='visible'),
        `${description}: mobile/tablet dots must remain rendered at every height, including static mode`);
      assert.ok(value.dots.every(dot=>dot.contained&&Math.abs(dot.railCenterDelta)<.6), 'visible dots share the contained vertical rail axis');
      assert.equal(value.line.display, 'block');
      assert.ok(value.rail.width>=1&&value.rail.height>0&&value.rail.content!=='none'&&value.rail.opacity==='1'
        &&value.rail.transform==='none'&&value.rail.contrast>=3, 'persistent base rail has nonzero geometry and visible contrast');
      assert.equal(value.triggers, fallback ? 0 : 1);
      if (fallback) {
        assert.equal(value.line.transform, 'none');
        assert.ok(value.dots.every(dot=>dot.reached===null&&dot.transform==='none'&&dot.shadow==='none'), 'static decorations have no residual reached state or motion');
        const staticPose = () => evaluate(`[...document.querySelectorAll('[data-timeline] [data-dot], [data-timeline] [data-journey-line]')]
          .map(e=>({transform:getComputedStyle(e).transform,shadow:getComputedStyle(e).boxShadow,animations:e.getAnimations().length}))`);
        const before = await staticPose();
        assert.ok(before.every(pose=>pose.animations===0), 'static rail and dots have no active animation');
        await delay(150);
        assert.deepEqual(await staticPose(), before, 'static rail and dots remain stable');
        assert.equal(await evaluate(`document.querySelectorAll('[data-timeline] [data-reached], [data-timeline] .timeline-split-line').length`), 0);
      }
    };
    const readable = async (width, height, fallback = false) => {
      await metrics(width, height);
      await until(() => evaluate(`innerWidth===${width} && innerHeight===${height}
        && ${fallback ? '!' : '!!'}document.querySelector('[data-timeline]').dataset.enhanced`), 'responsive timeline mode');
      await delay(350);
      const geometry = await evaluate(`(() => {
        const root=document.querySelector('[data-timeline]'),canvas=root.querySelector('[data-timeline-canvas]');
        const entries=[...root.querySelectorAll('[data-milestone]')];
        return {position:getComputedStyle(canvas).position,overflow:getComputedStyle(canvas).overflow,
          splits:root.querySelectorAll('.timeline-split-line').length,
          tops:entries.map(e=>e.getBoundingClientRect().top),
          widths:entries.map(e=>e.getBoundingClientRect().width),
          pageWidth:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,
          trackTransform:getComputedStyle(root.querySelector('[data-timeline-track]')).transform};
      })()`);
      assert.notEqual(geometry.position, 'sticky', `${width}: mobile chronology must use native vertical flow, not sticky clipping`);
      assert.equal(geometry.splits, 0, 'mobile text has no SplitText masks');
      assert.ok(geometry.tops.every((top, i, all) => !i || top > all[i - 1]), 'every milestone follows the previous one vertically');
      assert.ok(geometry.pageWidth <= geometry.viewport + 1, 'no horizontal page overflow');
      assert.equal(geometry.trackTransform, 'none', 'mobile track has no stale horizontal translation');
      if (!fallback) {
        await evaluate(`(() => {const track=document.querySelector('[data-timeline-track]');
          scrollTo({top:scrollY+track.getBoundingClientRect().top-innerHeight/2,behavior:'instant'});})()`);
        await until(() => evaluate(`Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('[data-journey-line]')).transform).m22)<.0015`), 'actual vertical progress starts at zero');
        assert.equal(await evaluate(`document.querySelectorAll('[data-timeline] [data-reached]').length`), 0, 'initial progress has not reached any mobile dot');
        await decorations(`${width}x${height} initial progress zero`);
        assert.equal(await evaluate(`(() => {const track=document.querySelector('[data-timeline-track]'),r=track.getBoundingClientRect(),s=getComputedStyle(track,'::before');
          const x=r.left+parseFloat(s.left),y=r.top+5;return x>=0&&x<innerWidth&&y>document.querySelector('header').getBoundingClientRect().bottom
            &&y<innerHeight&&getComputedStyle(track).overflow==='visible';})()`), true, 'initial base rail has an unobscured viewport segment before the first dot');
        if (width===390&&height===667) await capture('390x667-initial-zero');
      }
      for (let index = 0; index < 7; index++) {
        const count = await evaluate(`document.querySelectorAll('[data-milestone]')[${index}].querySelectorAll('h3,p,img').length`);
        for (let child = 0; child < count; child++) {
          const value = await evaluate(`(async () => {
            const entry=document.querySelectorAll('[data-milestone]')[${index}],element=entry.querySelectorAll('h3,p,img')[${child}];
            if(element.tagName==='IMG')await element.decode();
            element.scrollIntoView({block:'center',behavior:'instant'});
            // Native centering uses the full viewport, not the fixed header's
            // unobscured reading area (especially significant in landscape).
            scrollBy({top:-document.querySelector('header').getBoundingClientRect().height/2,behavior:'instant'});
            const r=element.getBoundingClientRect(),header=document.querySelector('header').getBoundingClientRect();
            const rects=element.tagName==='IMG'?[r]:(()=>{const range=document.createRange();range.selectNodeContents(element);return [...range.getClientRects()];})();
            const clips=[];for(let p=element.parentElement;p&&p!==document.body;p=p.parentElement){
              const s=getComputedStyle(p);if(/hidden|clip|auto|scroll/.test(s.overflowX+' '+s.overflowY))clips.push(p.getBoundingClientRect());}
            const inside=(a,b)=>a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;
            return {text:element.textContent,visible:getComputedStyle(element).visibility,
              viewport:rects.every(a=>inside(a,{left:0,right:document.documentElement.clientWidth,top:header.bottom,bottom:innerHeight})),
              unclipped:rects.every(a=>clips.every(b=>inside(a,b))),
              media:element.tagName!=='IMG'||(element.complete&&element.naturalWidth>0&&getComputedStyle(element).objectFit==='contain')};
          })()`);
          assert.equal(value.visible, 'visible');
          assert.equal(value.viewport, true, `${width} milestone ${index} child ${child}: all rendered text fragments/media reachable above header`);
          assert.equal(value.unclipped, true, `${width} milestone ${index} child ${child}: no ancestor clips rendered content`);
          assert.equal(value.media, true, 'decoded honest media uses contain');
        }
      }
      await evaluate(`document.querySelectorAll('[data-milestone]')[2].scrollIntoView({block:'start',behavior:'instant'});scrollBy({top:-120,behavior:'instant'})`);
      await decorations(`${width}x${height} ${fallback ? 'fallback' : 'enhanced'}`, fallback);
      await capture(`${width}x${height}-${fallback ? 'fallback' : 'enhanced'}`);
      t.diagnostic(`${width}x${height}: seven milestones, every text fragment and six decoded media vertically readable; fallback=${fallback}`);
    };
    const key = async (key, code, windowsVirtualKeyCode, text) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    };
    await metrics(320, 844);
    await reduce('no-preference');
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate(`document.querySelector('[data-timeline]')?.dataset.enhanced && document.fonts.status==='loaded'
      && [...document.querySelectorAll('[data-timeline] img')].every(i=>i.complete&&i.naturalWidth)`), 'timeline hydration and media');
    for (const [width, height] of [[320, 844], [390, 844], [768, 900]]) {
      await readable(width, height);
      const point = await evaluate(`(() => {const a=document.querySelector('[data-timeline-image]');a.scrollIntoView({block:'center',behavior:'instant'});
        const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      assert.equal(point.hit, true, 'native pointer can reach image');
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: point.x, y: point.y });
      await until(() => evaluate(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').contains(document.activeElement)`), 'pointer image opens focused dialog');
      await key('Escape', 'Escape', 27);
      await until(() => evaluate(`!document.querySelector('dialog[open]') && document.activeElement===document.querySelector('[data-timeline-image]')`), 'Escape returns image focus');
      await key('Enter', 'Enter', 13, '\r');
      await until(() => evaluate(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').contains(document.activeElement)`), 'native keyboard opens focused dialog');
      await key('Escape', 'Escape', 27);
      await until(() => evaluate(`!document.querySelector('dialog[open]') && document.activeElement===document.querySelector('[data-timeline-image]')`), 'keyboard close restores focus');
      for (let index = 0; index < 6; index++) {
        await evaluate(`document.querySelectorAll('[data-timeline-image]')[${index}].focus()`);
        await key('Enter', 'Enter', 13, '\r');
        await until(() => evaluate(`!!document.querySelector('dialog[open]') && document.querySelector('dialog img')?.complete
          && document.querySelector('dialog img').naturalWidth>0`), 'each milestone opens decoded full media');
        const caption = await evaluate(`(() => {
          const dialog=document.querySelector('dialog[open]'),element=dialog.querySelector('figcaption');
          element.scrollIntoView({block:'center',behavior:'instant'});
          const range=document.createRange();range.selectNodeContents(element);
          const bounds=dialog.getBoundingClientRect();
          return {text:element.textContent,fit:getComputedStyle(dialog.querySelector('img')).objectFit,
            readable:[...range.getClientRects()].every(r=>r.left>=bounds.left&&r.right<=bounds.right
              &&r.top>=0&&r.bottom<=innerHeight&&r.top>=bounds.top&&r.bottom<=bounds.bottom)};
        })()`);
        assert.ok(caption.text.length > 40, 'full media retains its factual caption');
        assert.equal(caption.fit, 'contain');
        assert.equal(caption.readable, true, 'every full-media caption fragment is reachable');
        await key('Escape', 'Escape', 27);
        await until(() => evaluate(`!document.querySelector('dialog[open]') && document.activeElement===document.querySelectorAll('[data-timeline-image]')[${index}]`), 'each media returns native invoking focus');
      }
    }
    await reduce('reduce');
    await readable(390, 667, true);
    await readable(390, 844, true);
    await reduce('no-preference');
    for (const [width, height] of [[390, 667], [390, 700], [768, 700], [844, 390]]) await readable(width, height);
    for (const width of [1440, 390, 1440, 390, 1440]) {
      await metrics(width, width === 390 ? 667 : 900);
      await until(() => evaluate(`document.querySelector('[data-timeline]').dataset.mode===${JSON.stringify(width === 1440 ? 'horizontal' : 'vertical')}`), 'desktop/mobile mode reentry');
      await delay(350);
      assert.equal(await evaluate(`Number(document.querySelector('[data-timeline]').dataset.ownedTriggers)`), width === 1440 ? 22 : 1, 'one owned mode without duplicate triggers');
      if (width === 1440) {
        await evaluate(`(() => {const link=document.querySelector('[data-timeline-image]');link.blur();link.focus();})()`);
        await capture('1440-desktop');
      } else await readable(390, 667);
    }
    await metrics(390, 667);
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
    await cdp.send('Page.reload', { ignoreCache: true });
    await until(() => evaluate(`document.readyState==='complete' && document.fonts.status==='loaded'`), 'no-JS chronology loaded');
    await readable(390, 667, true);
    await readable(390, 844, true);
    t.diagnostic('No-JS chronology: script execution disabled before reload; every existing readability assertion passed');
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) await cdp.send('Browser.close').catch(() => {});
    cdp?.close();
    if (browser.exitCode === null) await until(() => browser.exitCode !== null, 'owned readability browser exit').catch(() => browser.kill());
    hosted.server.closeAllConnections();
    await new Promise(done => hosted.server.close(done));
    t.diagnostic(`Owned readability browser exited=${browser.exitCode !== null}; server closed; profile retained: ${profile}`);
  }
});

test('timeline points grow and glow when the line reaches them', { timeout: 90000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-timeline-glow-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let snapshot;
  const errors = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned timeline browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const local = new URL(request.url).origin === hosted.origin;
      await cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.text));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const metrics = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    const reduce = value => cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value }] });
    snapshot = () => evaluate(`(() => {
      const root=document.querySelector('[data-timeline]');if(!root)return null;
      const track=root.querySelector('[data-timeline-track]'),line=root.querySelector('[data-journey-line]');
      const lr=line.getBoundingClientRect(),tr=track.getBoundingClientRect();
      const vertical=root.dataset.mode==='vertical',matrix=new DOMMatrix(getComputedStyle(line).transform);
      return {enhanced:root.dataset.enhanced,vertical,triggers:Number(root.dataset.ownedTriggers||0),
        progress:Number(root.dataset.progress||0),width:vertical?line.offsetHeight:line.offsetWidth,origin:line.offsetLeft,
        railX:lr.x+lr.width/2,endpoint:vertical?lr.bottom:lr.right,scale:vertical?matrix.m22:matrix.m11,
        splits:root.querySelectorAll('.timeline-split-line').length,
        dots:[...root.querySelectorAll('[data-dot]')].map(dot=>{
          const entry=dot.closest('[data-milestone]'),r=dot.getBoundingClientRect(),s=getComputedStyle(dot);
          const center=entry.offsetLeft+dot.offsetLeft+dot.offsetWidth/2;
          const axisCenter=vertical?entry.offsetTop+dot.offsetTop+dot.offsetHeight/2:center;
          return {reached:dot.getAttribute('data-reached'),size:r.width,base:dot.offsetWidth,
            shadow:s.boxShadow,display:s.display,center:r.x+r.width/2,y:r.y+r.height/2,
            expectedCenter:tr.x+center,expectedY:entry.getBoundingClientRect().y+dot.offsetTop+dot.offsetHeight/2,
            threshold:(axisCenter-(vertical?line.offsetTop:line.offsetLeft))/((vertical?line.offsetHeight:line.offsetWidth)||1),
            parents:entry.offsetParent===track&&dot.offsetParent===entry&&line.offsetParent===track,
            entryWidth:entry.offsetWidth,entryLeft:entry.offsetLeft};
        })};
    })()`);
    const at = async fraction => {
      await evaluate(`(() => {
        const root=document.querySelector('[data-timeline]'),canvas=root.querySelector('[data-timeline-canvas]');
        const track=root.querySelector('[data-timeline-track]'),line=root.querySelector('[data-journey-line]');
        const top=root.dataset.mode==='vertical'
          ? scrollY+track.getBoundingClientRect().top-innerHeight/2+line.offsetHeight*${fraction}
          : scrollY+root.getBoundingClientRect().top-document.querySelector('header').getBoundingClientRect().height
            +(root.offsetHeight-canvas.offsetHeight)*${fraction};
        scrollTo({top,behavior:'instant'});
      })()`);
      await until(async () => Math.abs((await snapshot()).scale-fraction)<.0015, 'rendered line reaches requested scroll');
      return snapshot();
    };
    const assertPoints = value => {
      assert.equal(value.dots.length, 7);
      for (const [index, dot] of value.dots.entries()) {
        assert.equal(dot.parents, true, 'measured offset parents share track coordinates');
        assert.ok(Math.abs(dot.center-dot.expectedCenter)<.6, 'growth preserves horizontal center');
        assert.ok(Math.abs(dot.y-dot.expectedY)<.6, 'growth preserves the existing vertical dot center');
        if (value.vertical) assert.ok(Math.abs(dot.center-value.railX)<.6, 'vertical rail and every dot share the same X axis');
        const reached = value.endpoint >= (value.vertical ? dot.y : dot.center);
        if (reached) {
          assert.ok(dot.size/dot.base >= 1.7, `milestone ${index}: line-reached dot must enlarge; ${JSON.stringify(value)}`);
          assert.notEqual(dot.shadow, 'none', 'line-reached dot has rendered glow');
          assert.match(dot.shadow, /(?:200, 23, 42|243, 30, 50)/, 'glow matches red palette');
          assert.equal(dot.reached, 'true');
        } else {
          assert.ok(Math.abs(dot.size-dot.base)<.1, 'unreached dot retains normal size');
          assert.equal(dot.shadow, 'none', 'unreached dot stays unlit');
          assert.equal(dot.reached, null);
        }
      }
    };
    const capture = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = `${profile}-${name}.png`;
      await writeFile(path, Buffer.from(data, 'base64'));
      t.diagnostic(`Capture: ${path}`);
    };
    await metrics(1440, 900);
    await reduce('no-preference');
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate(`document.querySelector('[data-timeline]')?.dataset.enhanced
      && document.fonts.status==='loaded' && [...document.querySelectorAll('[data-timeline] img')].every(i=>i.complete&&i.naturalWidth>0)`), 'timeline hydration and layout inputs');
    let desktop;
    for (const [width, height] of [[1440, 900], [390, 844], [390, 667], [390, 700], [768, 700], [844, 390], [1440, 900]]) {
      await metrics(width, height);
      await until(() => evaluate(`innerWidth===${width} && innerHeight===${height} && !!document.querySelector('[data-timeline]').dataset.enhanced`), 'responsive enhanced layout');
      await delay(350); // Allow the existing finite resize/refresh burst to settle.
      const start = await at(0);
      assertPoints(start);
      await capture(`${width}x${height}-initial-zero`);
      const target = start.dots[3].threshold;
      const before = await at(target-.004);
      assertPoints(before);
      assert.equal(before.dots[3].reached, null, 'specific point before crossing');
      const after = await at(target+.004);
      assertPoints(after);
      assert.equal(after.dots[3].reached, 'true', 'specific point after crossing');
      assert.equal(after.triggers, width < 1024 ? 1 : 22, 'vertical mode owns one line trigger; desktop retains twenty-two triggers');
      if (width < 1024) assert.equal(after.splits, 0, 'vertical glow never masks text');
      assert.deepEqual(after.dots.map(d=>[d.entryLeft,d.entryWidth]), before.dots.map(d=>[d.entryLeft,d.entryWidth]), 'growth cannot shift milestone layout');
      await capture(`${width}x${height}-active`);
      const stable = await snapshot();
      await delay(200);
      assert.deepEqual(await snapshot(), stable, 'reached state has no perpetual pulse');
      assertPoints(await at(target-.004));
      assert.equal((await snapshot()).dots[3].reached, null, 'backward reversal clears specific point');
      assertPoints(await at(1));
      t.diagnostic(`${width}x${height}: before/after/reverse/end passed; threshold=${target}; active size=${after.dots[3].size}; glow=${after.dots[3].shadow}; triggers=${after.triggers}`);
      if (!desktop) desktop = start;
      else if (width===390) assert.notEqual(start.width, desktop.width, 'resize recomputes actual line geometry');
    }
    const fallback = async description => {
      await until(async () => !(await snapshot()).enhanced, description);
      const value = await snapshot();
      assert.equal(value.triggers, 0);
      assert.equal(value.splits, 0);
      const mobile = await evaluate('innerWidth<1024');
      assert.ok(value.dots.every(d=>d.reached===null&&d.display===(mobile?'block':'none')&&d.shadow==='none'), 'fallback keeps mobile decoration static and preserves hidden desktop decoration');
      assert.equal(await evaluate(`document.querySelectorAll('[data-milestone]').length===7&&document.querySelectorAll('[data-timeline-image]').length===6`), true, 'chronology and media survive');
      t.diagnostic(`${description}: reached attributes removed, mobile static/desktop hidden decoration, zero owned triggers/splits`);
    };
    await reduce('reduce');
    await fallback('live reduced-motion cleanup');
    await reduce('no-preference');
    await until(async () => (await snapshot()).enhanced, 'reduced-motion reversal restores enhancement');
    assertPoints(await at(.55));
    await metrics(1440, 700);
    await fallback('desktop short-height cleanup');
    await metrics(390, 667);
    await until(async () => (await snapshot()).enhanced, 'short mobile viewport restores vertical enhancement');
    await delay(350);
    assertPoints(await at(.55));
    assert.equal((await snapshot()).triggers, 1, 'short vertical reentry creates no duplicate triggers');
    assert.deepEqual(errors, []);
    assert.deepEqual(cdp.errors, []);
  } catch (error) {
    if (snapshot) t.diagnostic(`Failure-time timeline: ${JSON.stringify(await snapshot().catch(e=>({error:e.message})))}`);
    t.diagnostic(`Browser exceptions: ${JSON.stringify(errors)}; CDP errors: ${JSON.stringify(cdp?.errors??[])}`);
    throw error;
  } finally {
    if (cdp) await cdp.send('Browser.close').catch(() => {});
    cdp?.close();
    if (browser.exitCode===null) await until(()=>browser.exitCode!==null, 'owned timeline browser exit').catch(()=>browser.kill());
    hosted.server.closeAllConnections();
    await new Promise(done=>hosted.server.close(done));
    t.diagnostic(`Owned timeline browser exited=${browser.exitCode!==null}; server closed; profile retained: ${profile}`);
  }
});

test('landing particle background remains global and respects motion controls', { timeout: 180000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-global-wave-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp, controller, snapshot;
  const errors = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned global wave browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    controller = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const local = new URL(request.url).origin === hosted.origin;
      await cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.text));
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const metrics = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    const reduce = value => cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value }] });
    snapshot = () => evaluate(`(() => {
      const c=document.querySelector('[data-particle-wave]'),o=c?.closest('[data-particle-wave-owner]');
      const b=document.querySelector('[data-wave-toggle]');if(!c||!b||document.readyState==='loading')return null;
      const rect=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
      window.__waveCanvasReceipt??=c;
      return {epoch:performance.timeOrigin,connected:c.isConnected,identity:c===window.__waveCanvasReceipt,
        owners:document.querySelectorAll('[data-particle-wave-owner]').length,
        canvases:document.querySelectorAll('[data-particle-wave]').length,global:!!o&&!o.closest('header,main,footer'),
        fixed:o&&getComputedStyle(o).position,rect:rect(c),owner:o&&rect(o),viewport:[innerWidth,innerHeight],
        raster:[c.width,c.height],dpr:+c.dataset.waveDpr,points:+c.dataset.wavePoints,
        paints:+c.dataset.wavePaints,phase:+c.dataset.wavePhase,queued:+c.dataset.waveQueued,
        same:c===window.globalWaveCanvas,heroOffscreen:document.querySelector('#inicio').getBoundingClientRect().bottom<=0,
        hidden:document.hidden,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        button:{hidden:b.hidden,disabled:b.disabled,pressed:b.getAttribute('aria-pressed'),label:b.textContent.trim()}};
    })()`);
    const idle = async reason => {
      await until(async () => (await snapshot())?.queued === 0, reason);
      const before = await snapshot(); await delay(250); const after = await snapshot();
      t.diagnostic(`Global wave idle ${reason}: ${JSON.stringify({before,after})}`);
      assert.equal(after.epoch, before.epoch, `${reason}: same document`);
      assert.ok(before.connected && after.connected && before.identity && after.identity, `${reason}: same connected canvas`);
      assert.equal(after.paints, before.paints, `${reason}: no idle paints`);
      assert.equal(after.phase, before.phase, `${reason}: no idle phase advance`);
      return after;
    };
    const reload = async reason => {
      const epoch = await evaluate('performance.timeOrigin');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until(async () => {
        const value = await snapshot();
        return value && value.epoch !== epoch && value.connected && value.paints > 0
          && !value.button.hidden && value.dpr > 0
          && value.raster.every((n, i) => n === Math.round(value.owner[i + 2] * value.dpr));
      }, `${reason}: fresh document and initialized raster/control`);
      t.diagnostic(`Global wave reload ${reason}: ${JSON.stringify({beforeEpoch:epoch,after:await snapshot()})}`);
    };
    const viewportReady = async (width, height, reason) => {
      await until(async () => {
        const value = await snapshot();
        return value?.same && value.connected && value.identity && value.viewport[0] === width
          && value.viewport[1] === height && value.owner[3] === height
          && value.owner.every((n, i) => n === value.rect[i]) && value.dpr === 1.5
          && value.raster.every((n, i) => n === Math.round(value.owner[i + 2] * value.dpr));
      }, reason);
      t.diagnostic(`Global wave resize ${reason}: ${JSON.stringify(await snapshot())}`);
    };
    const click = async selector => {
      const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});
        e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
      assert.equal(point.hit, true, `${selector}: foreground hit testing`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent',
        { type, button: 'left', clickCount: 1, x: point.x, y: point.y });
    };
    const capture = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = `${profile}-${name}.png`;
      await writeFile(path, Buffer.from(data, 'base64'));
      t.diagnostic(`Capture: ${path}`);
      return data;
    };
    // Private to the global-wave case: compare decoded compositor pixels, not
    // encoding or unrelated foreground rasterization. Unsupported PNGs fail.
    const { inflateSync } = await import('node:zlib');
    const { createHash } = await import('node:crypto');
    const browserVersion = await cdp.send('Browser.getVersion');
    t.diagnostic(`Global wave snapshot browser: ${JSON.stringify(browserVersion)}`);
    const decode = data => {
      const png = Buffer.from(data, 'base64');
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
      let width, height, channels, ended = false;
      const chunks = [];
      for (let offset = 8; offset < png.length;) {
        const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
        assert.ok(offset + size + 12 <= png.length, 'complete PNG chunk');
        const body = png.subarray(offset + 8, offset + 8 + size);
        if (type === 'IHDR') {
          assert.equal(size, 13);
          width = body.readUInt32BE(0); height = body.readUInt32BE(4);
          assert.equal(body[8], 8, '8-bit screenshot');
          assert.ok(body[9] === 2 || body[9] === 6, 'RGB/RGBA screenshot');
          channels = body[9] === 2 ? 3 : 4;
          assert.deepEqual([...body.subarray(10)], [0,0,0], 'standard noninterlaced PNG');
        } else if (type === 'IDAT') chunks.push(body);
        else if (type === 'IEND') ended = true;
        else assert.ok(type[0] === type[0].toLowerCase(), `unsupported critical chunk ${type}`);
        offset += size + 12;
      }
      assert.ok(ended && width > 0 && height > 0 && channels && chunks.length);
      const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
      assert.equal(raw.length, (stride + 1) * height);
      const pixels = Buffer.alloc(stride * height);
      for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        assert.ok(filter <= 4, 'supported PNG filter');
        for (let x = 0; x < stride; x++) {
          const left = x >= channels ? pixels[y * stride + x - channels] : 0;
          const up = y ? pixels[(y - 1) * stride + x] : 0;
          const corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
          const p = left + up - corner, a = Math.abs(p-left), b = Math.abs(p-up), c = Math.abs(p-corner);
          const predictor = [0,left,up,Math.floor((left+up)/2),a<=b&&a<=c?left:b<=c?up:corner][filter];
          pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
        }
      }
      return { width, height, channels, pixels };
    };
    const bufferReceipt = () => evaluate(`(async () => {
      const c=document.querySelector('[data-particle-wave]');
      const sourceAttributes=c.getContext('2d').getContextAttributes();
      if(!sourceAttributes||sourceAttributes.colorSpace!=='srgb'
        ||sourceAttributes.colorType!=='unorm8')throw new Error('Unsupported source bitmap attributes: '+JSON.stringify(sourceAttributes));
      // Read only a fresh CPU copy. Original-context getImageData can trigger
      // adaptive readback changes; no source context options or pixels change.
      const copy=new OffscreenCanvas(c.width,c.height);
      const context=copy.getContext('2d',{willReadFrequently:true,alpha:sourceAttributes.alpha,
        colorSpace:sourceAttributes.colorSpace,colorType:sourceAttributes.colorType});
      const copyAttributes=context.getContextAttributes();
      if(!copyAttributes.willReadFrequently||copyAttributes.alpha!==sourceAttributes.alpha
        ||copyAttributes.colorSpace!==sourceAttributes.colorSpace||copyAttributes.colorType!==sourceAttributes.colorType)
        throw new Error('Incompatible snapshot attributes: '+JSON.stringify(copyAttributes));
      context.imageSmoothingEnabled=false;
      context.drawImage(c,0,0);
      const bytes=context.getImageData(0,0,copy.width,copy.height,{colorSpace:sourceAttributes.colorSpace}).data;
      const previous=window.__pausedWaveBytes;
      const equal=previous?previous.length===bytes.length&&bytes.every((n,i)=>n===previous[i]):null;
      let differences=null;
      if(previous&&previous.length===bytes.length){
        let pixels=0,channels=0,maxDelta=0,alphaChanges=0,minX=c.width,minY=c.height,maxX=-1,maxY=-1;
        for(let i=0;i<bytes.length;i+=4){
          let changed=false;
          for(let channel=0;channel<4;channel++)if(bytes[i+channel]!==previous[i+channel]){
            changed=true;channels++;maxDelta=Math.max(maxDelta,Math.abs(bytes[i+channel]-previous[i+channel]));
            if(channel===3)alphaChanges++;
          }
          if(changed){const x=(i/4)%c.width,y=Math.floor(i/4/c.width);pixels++;
            minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
        }
        differences={pixels,channels,maxDelta,alphaChanges,bounds:pixels?[minX,minY,maxX,maxY]:null};
      }else if(previous)differences={previousBytes:previous.length,currentBytes:bytes.length};
      window.__pausedWaveBytes=bytes;
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
        .map(n=>n.toString(16).padStart(2,'0')).join('');
      return {digest,equal,differences,bytes:bytes.length,raster:[c.width,c.height],
        ordinal:window.__waveSnapshotOrdinal=(window.__waveSnapshotOrdinal||0)+1,
        method:'fresh detached OffscreenCanvas; intrinsic 1:1 drawImage; copied-context RGBA readback',
        sourceAttributes,copyAttributes,copyOutsideDOM:true,
        source:{epoch:performance.timeOrigin,connected:c.isConnected,same:c===window.globalWaveCanvas,
          identity:c===window.__waveCanvasReceipt,owner:c.closest('[data-particle-wave-owner]')===document.querySelector('[data-particle-wave-owner]'),
          paints:+c.dataset.wavePaints,phase:+c.dataset.wavePhase,queued:+c.dataset.waveQueued}};
    })()`);
    const regionReceipt = () => evaluate(`(() => {
      const rect=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
      const blocks=[];
      const add=(r,kind)=>{if(r[2]>0&&r[3]>0&&r[0]<innerWidth&&r[1]<innerHeight
        &&r[0]+r[2]>0&&r[1]+r[3]>0)blocks.push({rect:r,kind})};
      for(const e of document.querySelectorAll('body *')) {
        if(e.closest('[data-particle-wave-owner]'))continue;
        const s=getComputedStyle(e);
        if(s.display==='none'||s.visibility!=='visible'||s.opacity==='0')continue;
        // Only foreground stacking contexts can obscure the z1 wave. Section
        // surfaces below it do not turn transparent wrappers into opaque ink.
        let foreground=false;
        for(let p=e;p;p=p.parentElement)if(Number(getComputedStyle(p).zIndex)>=2){foreground=true;break;}
        if(!foreground)continue;
        const box=rect(e);
        const pseudo=['::before','::after'].some(p=>{const v=getComputedStyle(e,p);return v.content!=='none'&&v.content!=='normal'});
        if(/^(IMG|SVG|CANVAS|VIDEO|IFRAME|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(e.tagName)
          ||s.backgroundImage!=='none'||!/^rgba\\(.*?, 0\\)$/.test(s.backgroundColor)
          ||s.boxShadow!=='none'||s.filter!=='none'||pseudo
          ||['Top','Right','Bottom','Left'].some(p=>parseFloat(s['border'+p+'Width'])>0))add(box,e.tagName);
        for(const child of e.childNodes)if(child.nodeType===Node.TEXT_NODE&&child.textContent.trim()){
          const range=document.createRange();range.selectNodeContents(child);
          for(const r of range.getClientRects())add([r.x,r.y,r.width,r.height],'text');
        }
      }
      const surfaces=['#contacto','footer'].map(selector=>({selector,rect:rect(document.querySelector(selector))}));
      const tiles=[];
      for(let y=0;y+24<=innerHeight;y+=24)for(let x=0;x+24<=innerWidth;x+=24){
        const inside=surfaces.some(({rect:[a,b,w,h]})=>x>a&&y>b&&x+24<a+w&&y+24<b+h);
        const clear=blocks.every(({rect:[a,b,w,h]})=>x+24<a-2||x>a+w+2||y+24<b-2||y>b+h+2);
        if(inside&&clear)tiles.push([x,y,24,24]);
      }
      const logo=document.querySelector('footer img');
      return {viewport:[innerWidth,innerHeight],scroll:[scrollX,scrollY],surfaces,tiles,blocks,
        footer:{rect:rect(document.querySelector('footer')),logo:{rect:rect(logo),decoded:logo.complete&&logo.naturalWidth>0}}};
    })()`);
    const compareRegion = (a, b, region) => {
      assert.deepEqual([a.width,a.height,a.channels], [b.width,b.height,b.channels]);
      const sx=a.width/region.viewport[0], sy=a.height/region.viewport[1];
      assert.ok(sx>0 && sx===sy, 'uniform actual CSS-to-screenshot mapping');
      let sampled=0, differing=0;
      for(const [x,y,w,h] of region.tiles) {
        for(let py=Math.ceil(y*sy);py<Math.floor((y+h)*sy);py++)
          for(let px=Math.ceil(x*sx);px<Math.floor((x+w)*sx);px++) {
            assert.ok(px>=0&&py>=0&&px<a.width&&py<a.height);
            const i=(py*a.width+px)*a.channels;
            sampled++;
            if(!a.pixels.subarray(i,i+a.channels).equals(b.pixels.subarray(i,i+a.channels)))differing++;
          }
      }
      return {sampled,differing,scale:[sx,sy],screenshot:[a.width,a.height],tiles:region.tiles.length};
    };
    const regionSummary = region => ({viewport:region.viewport,scroll:region.scroll,surfaces:region.surfaces,
      footer:region.footer,tiles:region.tiles.length,excludedInkBoxes:region.blocks.length,
      firstTiles:region.tiles.slice(0,4),lastTiles:region.tiles.slice(-4),
      mapDigest:createHash('sha256').update(JSON.stringify(region)).digest('hex')});
    await metrics(1440, 900);
    await reduce('no-preference');
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate(`document.readyState!=='loading' && !!document.querySelector('footer [data-wave-toggle]')`), 'parsed Footer control');
    await until(async () => (await snapshot())?.paints > 2, 'existing renderer mounted');
    const initial = await snapshot();
    assert.equal(initial.global, true, 'single wave owner must be outside hero/header/main/footer');
    assert.equal(initial.owners, 1);
    await until(() => evaluate(`document.fonts.status==='loaded' && !!document.querySelector('[data-timeline][data-enhanced]')
      && !!document.querySelector('#formacion .pl-print')`), 'foreground enhancement and fonts');
    await evaluate(`window.globalWaveCanvas=document.querySelector('[data-particle-wave]')`);
    for (const [width, height, points] of [[1440, 900, 512], [390, 844, 180]]) {
      await metrics(width, height);
      await until(async () => (await snapshot())?.points === points, 'viewport budget resize');
      await evaluate(`scrollTo({top:0,behavior:'instant'})`);
      await capture(`${width}-hero`);
      for (const selector of ['[data-timeline-canvas]', '#formacion', '#faq', '#contacto', 'footer']) {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start',behavior:'instant'})`);
        const before = await snapshot();
        await until(async () => (await snapshot()).paints > before.paints + 2, `paints beyond hero at ${selector}`);
        const value = await snapshot();
        assert.equal(value.heroOffscreen, true);
        assert.equal(value.same, true, 'scrolling preserves actual canvas identity');
        assert.equal(value.canvases, 1);
        assert.equal(value.fixed, 'fixed');
        assert.deepEqual(value.rect, value.owner);
        assert.deepEqual(value.rect.slice(0, 2), [0, 0]);
        assert.equal(value.rect[3], height);
        assert.ok(value.rect[2] <= width && value.rect[2] >= width - 20, 'actual stable scrollbar gutter');
        assert.equal(value.dpr, 1.5);
        assert.deepEqual(value.raster, value.rect.slice(2).map(n => Math.round(n * 1.5)));
        const layers = await evaluate(`(() => {
          const landing=document.querySelector('[data-landing]'),owner=document.querySelector('[data-particle-wave-owner]');
          const foreground=document.querySelector(${JSON.stringify(selector === '[data-timeline-canvas]' ? selector : `${selector} > div`)});
          const s=getComputedStyle(foreground),l=getComputedStyle(landing);
          return {wave:getComputedStyle(owner).zIndex,foreground:s.zIndex,position:s.position,
            isolation:l.isolation,transform:l.transform,filter:l.filter,contain:l.contain,
            main:getComputedStyle(document.querySelector('main')).zIndex,footer:getComputedStyle(document.querySelector('footer')).zIndex,
            header:getComputedStyle(document.querySelector('header')).zIndex};
        })()`);
        assert.equal(layers.wave, '1');
        assert.equal(layers.foreground, '2');
        if (selector === '[data-timeline-canvas]') {
          assert.equal(layers.position, width >= 1024 ? 'sticky' : 'relative', 'preserved desktop sticky/mobile normal flow');
        }
        assert.deepEqual([layers.isolation, layers.transform, layers.filter, layers.contain], ['isolate', 'none', 'none', 'none']);
        assert.deepEqual([layers.main, layers.footer, layers.header], ['auto', 'auto', '40']);
        assert.equal(await evaluate(`(() => {
          const e=document.querySelector(${JSON.stringify(selector)}).querySelector(${JSON.stringify(selector === '[data-timeline-canvas]' ? '.timeline-heading p' : 'h2')});
          const r=e.getBoundingClientRect(),y=Math.max(document.querySelector('header').getBoundingClientRect().bottom+1,r.y+r.height/2);
          return e.contains(document.elementFromPoint(r.x+r.width/2,y));
        })()`), true, `${selector}: real foreground receives hit testing`);
        if (selector === '#formacion') {
          await until(() => evaluate(`document.querySelectorAll('#formacion img').length>0
            && [...document.querySelectorAll('#formacion img')].every(i=>i.complete&&i.naturalWidth>0)`), 'decoded formation photos');
          await capture(`${width}-formation`);
        }
        t.diagnostic(`${width} ${selector}: ${JSON.stringify({value,layers})}`);
      }
      const surfaces = await evaluate(`(() => {
        const bg=s=>getComputedStyle(document.querySelector(s)).backgroundColor;
        return {hero:bg('#inicio'),pilares:bg('#pilares'),formation:bg('#formacion'),faq:bg('#faq'),contact:bg('#contacto'),footer:bg('footer'),
          card:bg('#pilares article'),course:bg('#formacion article'),faqCard:bg('#faq details'),
          photoFrame:bg('#formacion .pl-print'),photoMat:bg('#formacion .pl-shot'),
          footerLayers:[...document.querySelectorAll('footer > div')].map(e=>getComputedStyle(e).zIndex),
          photos:[...document.querySelectorAll('#formacion img')].every(i=>i.complete&&i.naturalWidth>0),
          mask:getComputedStyle(document.querySelector('[data-particle-wave]')).maskImage};
      })()`);
      assert.deepEqual([surfaces.hero, surfaces.contact, surfaces.footer, surfaces.card], Array(4).fill('rgb(1, 1, 39)'));
      assert.deepEqual([surfaces.formation, surfaces.faq], Array(2).fill('rgb(239, 238, 232)'));
      assert.equal(surfaces.pilares, 'rgb(9, 9, 58)');
      assert.deepEqual([surfaces.course, surfaces.faqCard], Array(2).fill('rgb(248, 246, 238)'));
      assert.deepEqual([surfaces.photoFrame, surfaces.photoMat], ['rgb(251, 250, 247)', 'rgb(217, 213, 204)']);
      assert.deepEqual(surfaces.footerLayers, ['2', '2']);
      assert.equal(surfaces.photos, true);
      assert.match(surfaces.mask, /radial-gradient/);
      await click('#faq summary');
      assert.equal(await evaluate(`document.querySelector('#faq details').open`), true, 'native FAQ remains interactive');
      await click('#faq summary');
      await evaluate(`document.querySelector('#contacto').scrollIntoView({block:'start',behavior:'instant'})`);
      await capture(`${width}-lower-landing`);
      await click('[data-wave-toggle]');
      await idle('paused for actual composited visibility comparison');
      await evaluate(`document.querySelector('#contacto').scrollIntoView({block:'start',behavior:'instant'})`);
      await evaluate(`document.querySelector('footer img').decode()`);
      let previousRegion;
      const region = await until(async () => {
        const current=await regionReceipt(), settled=previousRegion&&JSON.stringify(current)===JSON.stringify(previousRegion);
        previousRegion=current;return settled&&current;
      }, 'decoded footer and stable current DOM background geometry');
      const pausedState = await snapshot(), bufferBefore = await bufferReceipt();
      const visible = decode(await capture(`${width}-lower-paused`));
      const stable = decode(await capture(`${width}-lower-paused-stable`));
      const bufferAfter = await bufferReceipt(), stateAfter = await snapshot();
      const savedVisibility = await evaluate(`(() => {
        const s=document.querySelector('[data-particle-wave-owner]').style;
        const saved={present:[...s].includes('visibility'),value:s.getPropertyValue('visibility'),priority:s.getPropertyPriority('visibility')};
        s.setProperty('visibility','hidden');return saved;
      })()`);
      let withoutWave, restored, hiddenRegion, hiddenBuffer, hiddenState, hiddenVisibility;
      try {
        hiddenVisibility = await evaluate(`getComputedStyle(document.querySelector('[data-particle-wave-owner]')).visibility`);
        withoutWave = decode(await capture(`${width}-lower-without-wave`));
        hiddenRegion = await regionReceipt(); hiddenBuffer = await bufferReceipt(); hiddenState = await snapshot();
      }
      finally {
        await evaluate(`(() => {const s=document.querySelector('[data-particle-wave-owner]').style;
          const saved=${JSON.stringify(savedVisibility)};
          if(saved.present)s.setProperty('visibility',saved.value,saved.priority);else s.removeProperty('visibility');
        })()`);
      }
      restored = decode(await capture(`${width}-lower-restored`));
      const restoredBuffer = await bufferReceipt(), restoredState = await snapshot(), regionAfter = await regionReceipt();
      const stability = compareRegion(visible, stable, region);
      const contribution = compareRegion(visible, withoutWave, region);
      const returned = compareRegion(restored, withoutWave, region);
      const restoration = compareRegion(visible, restored, region);
      t.diagnostic(`Global composition ${width}: ${JSON.stringify({bufferBefore,bufferAfter,restoredBuffer,
        hiddenBuffer,hiddenVisibility,pausedState,stateAfter,hiddenState,restoredState,
        region:regionSummary(region),hiddenRegion:regionSummary(hiddenRegion),regionAfter:regionSummary(regionAfter),
        stability,contribution,returned,restoration})}`);
      assert.ok(region.tiles.length>0, 'DOM proves unobscured contact/footer background');
      assert.equal(pausedState.queued, 0);
      assert.equal(pausedState.button.pressed, 'true');
      assert.equal(hiddenVisibility, 'hidden', 'actual owner is hidden for compositor experiment');
      assert.deepEqual(hiddenRegion, region, 'hidden capture retains same DOM background geometry');
      assert.deepEqual(regionAfter, region, 'same DOM geometry and ink exclusions across visibility experiment');
      assert.deepEqual(stateAfter, pausedState, 'same paused control/document/owner/geometry/paint/phase/queue');
      assert.deepEqual(hiddenState, pausedState, 'hidden owner preserves paused renderer');
      assert.deepEqual(restoredState, pausedState, 'visibility experiment preserves paused renderer');
      assert.equal(bufferAfter.equal, true, 'complete paused RGBA buffer is byte-identical');
      assert.equal(hiddenBuffer.equal, true, 'hidden owner preserves complete buffer');
      assert.equal(restoredBuffer.equal, true, 'visibility experiment preserves complete buffer');
      assert.equal(bufferAfter.digest, bufferBefore.digest);
      assert.equal(restoredBuffer.digest, bufferBefore.digest);
      assert.equal(stability.differing, 0, 'unobscured paused background pixels remain exact');
      assert.ok(contribution.differing>0, 'actual masked wave contributes composited background pixels');
      assert.ok(returned.differing>0, 'restored actual wave contributes composited background pixels');
      assert.equal(restoration.differing, 0, 'exact contribution returns after authored visibility restoration');
      await click('[data-wave-toggle]');
      await until(async () => (await snapshot()).queued === 1, 'resume after composited comparison');
      await until(async () => (await snapshot()).paints>pausedState.paints+2, 'real resumed wave paints');
      const resumedState = await snapshot(), resumedBuffer = await bufferReceipt();
      t.diagnostic(`Global buffer sensitivity ${width}: ${JSON.stringify({resumedState,resumedBuffer})}`);
      assert.notEqual(resumedState.phase, pausedState.phase, 'real resume advances phase');
      assert.equal(resumedBuffer.equal, false, 'real resume changes actual complete canvas bytes');
      assert.notEqual(resumedBuffer.digest, bufferBefore.digest);
      await metrics(width, height - 100);
      await viewportReady(width, height - 100, 'event-driven dynamic viewport resize');
      await metrics(width, height);
      await viewportReady(width, height, 'viewport restoration');
    }
    await click('[data-wave-toggle]');
    assert.equal((await idle('native pause')).button.pressed, 'true');
    assert.equal(await evaluate(`localStorage.getItem('chiledao.hero-wave.paused')`), 'true');
    await reload('persisted pause');
    await until(async () => (await snapshot())?.button.pressed === 'true', 'reload persists pause');
    await idle('persisted pause');
    await click('[data-wave-toggle]');
    await until(async () => (await snapshot()).queued === 1, 'native resume');
    assert.equal(await evaluate(`localStorage.getItem('chiledao.hero-wave.paused')`), 'false');
    await reduce('reduce');
    await until(async () => (await snapshot()).button.disabled, 'live native reduced-motion control');
    const reduced = await idle('live native reduced motion');
    assert.equal(reduced.reduced, true);
    assert.equal(reduced.button.label, 'Fondo estático por preferencia de movimiento');
    await reload('initial reduced motion');
    await until(async () => (await snapshot())?.button.disabled, 'initial reduced motion');
    await idle('initial reduced motion');
    await reduce('no-preference');
    await until(async () => (await snapshot()).queued === 1 && !(await snapshot()).button.disabled, 'native preference reversal');
    const other = await controller.send('Target.createTarget', { url: 'about:blank' });
    await controller.send('Target.activateTarget', { targetId: other.targetId });
    await until(() => evaluate(`document.hidden`), 'genuinely hidden tab');
    const hidden = await idle('actual hidden tab');
    await controller.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    await until(async () => !(await snapshot()).hidden && (await snapshot()).queued === 1, 'visible tab resumes');
    assert.ok((await snapshot()).phase - hidden.phase < .15, 'no hidden catch-up');
    await controller.send('Target.closeTarget', { targetId: other.targetId });
    const removed = await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{
      window.removedWaveOwner=document.querySelector('[data-particle-wave-owner]');
      window.removedWaveCanvas=window.removedWaveOwner.querySelector('canvas');
      const paints=+window.removedWaveCanvas.dataset.wavePaints;window.removedWaveOwner.remove();
      requestAnimationFrame(()=>resolve({paints,after:+window.removedWaveCanvas.dataset.wavePaints,queued:+window.removedWaveCanvas.dataset.waveQueued}));
    }))`);
    assert.equal(removed.queued, 0);
    assert.equal(removed.after, removed.paints);
    await metrics(1440, 900); await reduce('reduce'); await delay(250);
    assert.equal(await evaluate(`+window.removedWaveCanvas.dataset.wavePaints`), removed.paints, 'removed owner listeners cannot paint');
    assert.equal(await evaluate(`document.querySelector('[data-wave-toggle]').hidden`), true);
    await evaluate(`document.querySelector('[data-landing]').prepend(window.removedWaveOwner);document.dispatchEvent(new Event('astro:page-load'));document.dispatchEvent(new Event('astro:page-load'))`);
    await until(async () => (await snapshot())?.button.disabled && !(await snapshot()).button.hidden, 'remount under initial reduced motion');
    await idle('remounted reduced owner');
    await reduce('no-preference');
    await until(async () => (await snapshot()).queued === 1, 'remounted owner resumes');
    await click('[data-wave-toggle]');
    assert.equal((await idle('deduplicated remount pause')).button.pressed, 'true', 'one click invokes only one owned listener');
    assert.equal((await snapshot()).canvases, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(cdp.errors, []);
  } catch (error) {
    if (snapshot) t.diagnostic(`Failure-time global wave: ${JSON.stringify(await snapshot().catch(e=>({error:e.message})))}`);
    t.diagnostic(`Browser exceptions: ${JSON.stringify(errors)}; CDP errors: ${JSON.stringify(cdp?.errors??[])}`);
    throw error;
  } finally {
    if (controller) { await controller.send('Browser.close').catch(() => {}); controller.close(); }
    cdp?.close();
    if (browser.exitCode === null) await until(() => browser.exitCode !== null, 'owned global wave browser exit').catch(() => browser.kill());
    hosted.server.closeAllConnections();
    await new Promise(done => hosted.server.close(done));
    t.diagnostic(`Owned global wave browser exited=${browser.exitCode!==null}; server closed; profile retained: ${profile}`);
  }
});

test('hero continuous particle wave', { timeout: 90000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-wave-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let controller;
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned wave browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    controller = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      await cdp.send(new URL(request.url).origin === hosted.origin ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(new URL(request.url).origin === hosted.origin ? {} : { errorReason: 'BlockedByClient' }) });
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Target.activateTarget', {targetId:page.id});
    await cdp.send('Page.bringToFront');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__waveDocument=crypto.randomUUID();window.__waveMediaEvents=[];
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>window.__waveMediaEvents.push({time:performance.now(),matches:e.matches,trusted:e.isTrusted}));
      window.waveLayoutShifts=[];
      new PerformanceObserver(list=>{for(const entry of list.getEntries())
        if(entry.sources?.some(source=>source.node?.closest?.('[data-particle-wave]')))
          window.waveLayoutShifts.push(entry.value);
      }).observe({type:'layout-shift',buffered:true});
    ` });
    const evaluate = async expression => {
      const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const metrics = async (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    const reduce = async value => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    const snapshot = () => evaluate(`(() => {
      const c=document.querySelector('[data-particle-wave]'),h=document.querySelector('#inicio'),b=document.querySelector('[data-wave-toggle]');
      if(!c||!h||!b||document.readyState==='loading')return null;
      const r=c.getBoundingClientRect(),hr=c.closest('[data-particle-wave-owner]').getBoundingClientRect();
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let hash=2166136261,nonzero=0,maxAlpha=0;const tiles=Array(16).fill(0);
      for(let i=0;i<pixels.length;i+=4){const a=pixels[i+3];if(a){nonzero++;maxAlpha=Math.max(maxAlpha,a);tiles[Math.min(15,Math.floor((i/4)/c.width/(c.height/16)))]+=a;}hash=Math.imul(hash^a,16777619);}
      window.__waveCanvasReceipt??=c;
      return {epoch:window.__waveDocument,connected:c.isConnected,identity:c===window.__waveCanvasReceipt,
        hidden:document.hidden,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        paints:+c.dataset.wavePaints,queued:+c.dataset.waveQueued,points:+c.dataset.wavePoints,dpr:+c.dataset.waveDpr,phase:+c.dataset.wavePhase,
        width:c.width,height:c.height,rect:[r.x,r.y,r.width,r.height],owner:[hr.x,hr.y,hr.width,hr.height],navy:getComputedStyle(h).backgroundColor,
        pointer:getComputedStyle(c).pointerEvents,hash,nonzero,maxAlpha,tiles,button:{hidden:b.hidden,disabled:b.disabled,label:b.textContent.trim(),pressed:b.getAttribute('aria-pressed')}};
    })()`);
    const capture = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const path = `${profile}-${name}.png`;
      await writeFile(path, Buffer.from(data, 'base64'));
      t.diagnostic(`Capture: ${path}`);
    };
    const idle = async reason => {
      await until(async () => (await snapshot())?.queued === 0, reason);
      const before = await snapshot(); await delay(250); const after = await snapshot();
      t.diagnostic(`Wave idle ${reason}: ${JSON.stringify({before,after})}`);
      assert.equal(after.epoch, before.epoch, `${reason}: same document`);
      assert.ok(before.connected && after.connected && before.identity && after.identity, `${reason}: same connected canvas`);
      assert.equal(after.paints, before.paints, `${reason}: no owned idle paints`);
      assert.equal(after.phase, before.phase, `${reason}: no phase advance`);
      return after;
    };
    const reload = async reason => {
      const epoch = await evaluate('window.__waveDocument');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until(async () => {
        const value = await snapshot();
        return value && value.epoch !== epoch && value.connected && value.paints > 0
          && !value.button.hidden && value.dpr > 0
          && value.width === Math.round(value.owner[2] * value.dpr)
          && value.height === Math.round(value.owner[3] * value.dpr);
      }, `${reason}: fresh document and initialized raster/control`);
      t.diagnostic(`Wave reload ${reason}: ${JSON.stringify({beforeEpoch:epoch,after:await snapshot()})}`);
    };
    await metrics(1440, 900);
    await reduce('no-preference');
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate('document.hasFocus() && !document.hidden'), 'owned wave document genuinely foreground');
    await until(() => evaluate(`!!document.querySelector('h1')`), 'SSR hero');
    assert.equal(await evaluate(`document.querySelectorAll('[data-particle-wave]').length`), 1, 'one actual global wave canvas');
    await until(async () => (await snapshot())?.paints > 2, 'continuous actual canvas painting');
    const removalProbe = await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{
      const c=document.querySelector('[data-particle-wave]');window.detachedWaveCanvas=c;
      const paints=+c.dataset.wavePaints;c.remove();
      requestAnimationFrame(()=>resolve({paints,after:+c.dataset.wavePaints,queued:+c.dataset.waveQueued,
        heroConnected:document.querySelector('#inicio').isConnected}));
    }))`);
    await delay(250);
    t.diagnostic(`Removal baseline: ${JSON.stringify({removalProbe,later:await evaluate(`({paints:+window.detachedWaveCanvas.dataset.wavePaints,queued:+window.detachedWaveCanvas.dataset.waveQueued})`)})}`);
    assert.equal(removalProbe.heroConnected, true);
    assert.equal(removalProbe.queued, 0, 'actual removal disposes within one pending frame');
    assert.equal(removalProbe.after, removalProbe.paints, 'no detached paint');
    await reload('connected owner after removal');
    await until(async () => (await snapshot())?.paints > 2, 'fresh connected owner after removal proof');
    for (const [width, height, count] of [[1440, 900, 512], [390, 844, 180], [320, 844, 180]]) {
      await metrics(width, height);
      await until(async () => (await snapshot())?.points === count, 'responsive point budget');
      const before = await snapshot(); await delay(550); const after = await snapshot();
      assert.deepEqual(after.rect, after.owner, 'fixed full owner coverage');
      assert.equal(after.navy, 'rgb(1, 1, 39)');
      assert.equal(after.pointer, 'none');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-works-wheel]')).backgroundColor`), 'rgba(0, 0, 0, 0)', 'wave is not covered by an opaque shell');
      assert.equal(after.dpr, 1.5);
      assert.equal(after.width, Math.round(after.rect[2] * 1.5));
      assert.equal(after.height, Math.round(after.rect[3] * 1.5));
      assert.ok(after.nonzero > 100 && after.maxAlpha > 10 && after.maxAlpha <= 100, 'real transparent subtle dot pixels');
      assert.ok(after.tiles.filter(n => n > 0).length >= 8, 'distributed wave, not a single diagnostic pixel');
      assert.notEqual(after.hash, before.hash, 'actual raster dot positions change');
      assert.ok(after.phase > before.phase && after.phase - before.phase < .3);
      const fps = (after.paints - before.paints) / .55;
      assert.ok(fps > 10 && fps <= 30, `actual paint rate ${fps}`);
      assert.equal(after.queued, 1);
      assert.equal(await evaluate(`document.querySelectorAll('astro-island').length`), 3);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-hero-intro] a')].map(a=>a.getAttribute('href'))`), ['#formacion', 'https://linktr.ee/web3chile']);
      assert.equal(await evaluate(`document.querySelectorAll('#inicio [data-wave-toggle],.timeline-actions').length`), 0);
      const readability = await evaluate(`(() => {
        const rgb=s=>s.match(/[\\d.]+/g).map(Number), navy=rgb(getComputedStyle(document.querySelector('#inicio')).backgroundColor);
        const paper=rgb('rgb(239,238,232)'),red=rgb('rgb(243,30,50)');
        // Conservative envelope ignores the protective mask: brightest paper dot
        // over the maximum existing red glow and the existing 2.5% grid line.
        const bg=navy.map((n,i)=>((n*.88+red[i]*.12)*.975+paper[i]*.025)*.7+paper[i]*.3);
        const lum=c=>c.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
        const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
        const h=document.querySelector('h1'),links=[...document.querySelectorAll('[data-hero-intro] a')];
        const ratios=[h,...links].map(el=>{const s=getComputedStyle(el),fg=rgb(s.color), own=rgb(s.backgroundColor);
          const backdrop=own[3]===0?bg:own;return contrast(fg,backdrop);});
        const hits=links.map(a=>{const r=a.getBoundingClientRect();return a.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
        return {ratios,hits,mask:getComputedStyle(document.querySelector('[data-particle-wave]')).maskImage,shifts:window.waveLayoutShifts};
      })()`);
      assert.ok(readability.ratios.every(ratio => ratio >= 4.5), 'H1 and CTA conservative color bounds');
      assert.deepEqual(readability.hits, [true, true], 'canvas never intercepts either CTA');
      assert.match(readability.mask, /radial-gradient/);
      assert.deepEqual(readability.shifts, [], 'no layout-shift source attributable to canvas');
      t.diagnostic(`Conservative H1/CTA ratios at ${width}: ${JSON.stringify(readability.ratios)}`);
      t.diagnostic(JSON.stringify({ width, points: after.points, dpr: after.dpr, fps, bytes: after.width * after.height * 4, pixels: after.nonzero, maxAlpha: after.maxAlpha, hashes: [before.hash, after.hash] }));
      await capture(`${width}-wave`);
    }
    // Actual footer click while Hero is offscreen; the preference survives reentry/reload.
    await evaluate(`document.querySelector('[data-wave-toggle]').scrollIntoView({block:'center',behavior:'instant'})`);
    const offscreen = await snapshot();
    assert.equal(await evaluate(`document.querySelector('#inicio').getBoundingClientRect().bottom<=0`), true);
    await until(async () => (await snapshot()).paints > offscreen.paints + 2, 'fixed owner paints beyond offscreen hero');
    const point = await evaluate(`(() => {const r=document.querySelector('[data-wave-toggle]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    assert.equal((await snapshot()).button.pressed, 'true');
    assert.equal(await evaluate(`localStorage.getItem('chiledao.hero-wave.paused')`), 'true');
    await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
    await idle('user paused');
    await capture('320-paused');
    await reload('persisted pause');
    await until(async () => (await snapshot())?.button.pressed === 'true', 'persisted pause');
    await idle('persisted pause');
    await evaluate(`document.querySelector('[data-wave-toggle]').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('[data-wave-toggle]').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal((await snapshot()).button.pressed, 'false');
    await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
    await until(async () => (await snapshot())?.queued === 1, 'resume after native Enter');
    t.diagnostic(`wave before media: ${JSON.stringify(await evaluate(`({id:window.__waveDocument,matches:matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden,focus:document.hasFocus(),connected:document.querySelector('[data-particle-wave]').isConnected,button:document.querySelector('[data-wave-toggle]').outerHTML})`))}`);
    const mediaBaseline = await evaluate(`({epoch:window.__waveDocument,count:window.__waveMediaEvents.length})`);
    await reduce('reduce');
    await until(() => evaluate(`window.__waveDocument===${JSON.stringify(mediaBaseline.epoch)} && window.__waveMediaEvents.slice(${mediaBaseline.count}).some(e=>e.matches&&e.trusted)`), 'same-document native reduced-motion change');
    assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true, 'current native query matches independently');
    await until(async () => (await snapshot())?.button.disabled, 'native live preference event delivered').catch(async error=>{
      // Inspect actual native producers and callback closures only after failure.
      // Do not retain queries before the event or introduce a synchronization hook.
      try {
        await cdp.send('Debugger.enable');
        const prototype = await cdp.send('Runtime.evaluate', { expression:'MediaQueryList.prototype', objectGroup:'wave-failure' });
        const queries = await cdp.send('Runtime.queryObjects', { prototypeObjectId:prototype.result.objectId, objectGroup:'wave-failure' });
        const objects = await cdp.send('Runtime.getProperties', { objectId:queries.objects.objectId, ownProperties:true });
        for (const entry of objects.result.filter(p=>/^\d+$/.test(p.name))) {
          const query = await cdp.send('Runtime.callFunctionOn', { objectId:entry.value.objectId,
            functionDeclaration:'function(){return {media:this.media,matches:this.matches}}', returnByValue:true });
          if (query.result.value.media !== '(prefers-reduced-motion: reduce)') continue;
          const listeners = await cdp.send('DOMDebugger.getEventListeners', { objectId:entry.value.objectId });
          t.diagnostic(`wave producer: ${JSON.stringify({query:query.result.value,listeners:listeners.listeners})}`);
          for (const listener of listeners.listeners.filter(l=>l.type==='change')) {
            const fn = listener.originalHandler ?? listener.handler;
            if (!fn?.objectId) continue;
            const properties = await cdp.send('Runtime.getProperties', { objectId:fn.objectId });
            const scopesId = properties.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value.objectId;
            if (!scopesId) continue;
            const scopes = await cdp.send('Runtime.getProperties', { objectId:scopesId, ownProperties:true });
            for (const scope of scopes.result.filter(p=>/^\d+$/.test(p.name))) {
              const bindings = await cdp.send('Runtime.getProperties', { objectId:scope.value.objectId, ownProperties:true });
              if (!bindings.result.some(b=>b.value?.className==='HTMLCanvasElement')) continue;
              t.diagnostic(`wave producer closure: ${JSON.stringify(bindings.result.filter(b=>b.value && ['boolean','number','function'].includes(b.value.type))
                .map(b=>({name:b.name,type:b.value.type,value:b.value.value,source:b.value.description?.slice(0,500)})))}`);
              for (const binding of bindings.result) {
                if (!['MediaQueryList','HTMLButtonElement','HTMLCanvasElement'].includes(binding.value?.className)) continue;
                const identity = await cdp.send('Runtime.callFunctionOn', { objectId:binding.value.objectId, returnByValue:true,
                  functionDeclaration:`function(){return {type:this.constructor.name,media:this.media,matches:this.matches,
                    connected:this.isConnected,currentButton:this===document.querySelector('[data-wave-toggle]'),
                    currentCanvas:this===document.querySelector('[data-particle-wave]'),hidden:this.hidden,disabled:this.disabled}}` });
                t.diagnostic(`wave callback binding ${binding.name}: ${JSON.stringify(identity.result.value)}`);
              }
            }
          }
        }
      } catch (diagnosticError) { t.diagnostic(`wave producer diagnostics unavailable: ${diagnosticError.message}`); }
      t.diagnostic(`wave failure raster/control: ${JSON.stringify(await snapshot())}`);
      for(const row of await evaluate('window.__waveMediaEvents'))t.diagnostic(`wave media: ${JSON.stringify(row)}`);
      t.diagnostic(`wave predicates: ${JSON.stringify(await evaluate(`({epoch:window.__waveDocument,count:window.__waveMediaEvents.length,matches:matchMedia('(prefers-reduced-motion: reduce)').matches,button:document.querySelector('[data-wave-toggle]').outerHTML})`))}; baseline=${JSON.stringify(mediaBaseline)}`);
      t.diagnostic(`wave target: ${JSON.stringify(await controller.send('Target.getTargets'))}`);
      throw error;
    });
    const reduced = await idle('live reduced motion');
    assert.equal(reduced.button.disabled, true);
    assert.equal(reduced.button.label, 'Fondo estático por preferencia de movimiento');
    await reload('initial reduced motion');
    await until(async () => (await snapshot())?.button.disabled, 'initial reduced motion');
    await idle('initial reduced motion');
    await reduce('no-preference');
    await until(async () => (await snapshot())?.queued === 1, 'preference reversal resumes');
    // Browser-owned target switching, not synthetic visibility properties/events.
    const other = await controller.send('Target.createTarget', { url: 'about:blank' });
    await controller.send('Target.activateTarget', { targetId: other.targetId });
    await until(() => evaluate(`document.hidden`), 'actual document hidden');
    const hidden = await idle('document hidden');
    await controller.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    await until(() => evaluate(`!document.hidden`), 'actual document visible');
    await until(async () => (await snapshot())?.queued === 1, 'visible restart');
    assert.ok((await snapshot()).phase - hidden.phase < .15, 'no background catch-up jump');
    await controller.send('Target.closeTarget', { targetId: other.targetId });
    for (const width of [390, 1440, 320]) { await metrics(width, 844); await delay(100); assert.equal((await snapshot()).queued, 1); }
    // Exercise the real component's disposal path, without exposing an app test API.
    await evaluate(`document.dispatchEvent(new Event('astro:before-swap'))`);
    const disposed = await idle('component disposed');
    assert.equal(disposed.button.hidden, true);
    await metrics(390, 844);
    await delay(100);
    assert.equal((await snapshot()).paints, disposed.paints, 'disposed ResizeObserver/listeners do not paint');
    // Remove the actual DOM owner while its observed Hero remains alive/in view.
    await reload('active owner before removal');
    await until(async () => (await snapshot())?.queued === 1, 'active owner before actual removal');
    const detached = await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{
      const c=document.querySelector('[data-particle-wave]'),h=document.querySelector('#inicio');
      window.detachedWaveCanvas=c;window.detachedWaveClears=0;
      const ctx=c.getContext('2d'),clear=ctx.clearRect.bind(ctx);
      ctx.clearRect=(...args)=>{window.detachedWaveClears++;return clear(...args);};
      const paints=+c.dataset.wavePaints;c.remove();
      requestAnimationFrame(()=>resolve({paints,after:+c.dataset.wavePaints,queued:+c.dataset.waveQueued,
        clears:window.detachedWaveClears,connected:c.isConnected,heroConnected:h.isConnected,
        heroVisible:h.getBoundingClientRect().bottom>0&&h.getBoundingClientRect().top<innerHeight}));
    }))`);
    await delay(250);
    const detachedState = () => evaluate(`({paints:+window.detachedWaveCanvas.dataset.wavePaints,
      queued:+window.detachedWaveCanvas.dataset.waveQueued,clears:window.detachedWaveClears,
      hidden:document.querySelector('[data-wave-toggle]').hidden,disabled:document.querySelector('[data-wave-toggle]').disabled})`);
    const settledDetached = await detachedState();
    t.diagnostic(`Actual removal: ${JSON.stringify({detached,settledDetached})}`);
    assert.equal(detached.connected, false);
    assert.equal(detached.heroConnected && detached.heroVisible, true);
    assert.equal(detached.queued, 0, 'actual removal disposes within the next pending frame');
    assert.equal(detached.after, detached.paints, 'pending frame never paints detached owner');
    assert.equal(detached.clears, 0);
    assert.deepEqual(settledDetached, {paints:detached.paints,queued:0,clears:0,hidden:true,disabled:true});
    const storedPause = await evaluate(`localStorage.getItem('chiledao.hero-wave.paused')`);
    await metrics(1440, 900);
    await evaluate(`document.querySelector('[data-wave-toggle]').click();document.dispatchEvent(new Event('visibilitychange'))`);
    await reduce('reduce'); await reduce('no-preference');
    await delay(250);
    assert.deepEqual(await detachedState(), settledDetached, 'resize/footer/visibility/media cannot restart disposed owner');
    assert.equal(await evaluate(`localStorage.getItem('chiledao.hero-wave.paused')`), storedPause, 'disposed footer handler is removed');
    assert.equal(await evaluate(`document.querySelectorAll('h1').length===1 && getComputedStyle(document.querySelector('#inicio')).backgroundColor==='rgb(1, 1, 39)'`), true);
    await evaluate(`document.querySelector('[data-particle-wave-owner]').prepend(window.detachedWaveCanvas);document.dispatchEvent(new Event('astro:page-load'))`);
    await until(async () => !(await snapshot())?.button.hidden && (await snapshot())?.queued === 1, 'disposed owner removed from mount registry');
    // A paused owner has no pending frame: its next callback must dispose, never resume.
    await evaluate(`document.querySelector('[data-wave-toggle]').click()`);
    await idle('paused before removal');
    const pausedRemoval = await evaluate(`(() => {const c=document.querySelector('[data-particle-wave]');window.detachedWaveCanvas=c;
      c.remove();return +c.dataset.wavePaints;})()`);
    await evaluate(`document.querySelector('[data-wave-toggle]').click();document.dispatchEvent(new Event('visibilitychange'))`);
    await metrics(390, 844);
    await reduce('reduce'); await reduce('no-preference');
    await delay(250);
    assert.equal((await detachedState()).paints, pausedRemoval);
    assert.equal((await detachedState()).queued, 0);
    assert.equal((await detachedState()).hidden, true);
    assert.equal((await detachedState()).disabled, true);
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
    await cdp.send('Page.reload', { ignoreCache: true });
    await delay(500);
    assert.equal(await evaluate(`document.querySelector('[data-wave-toggle]').hidden && document.querySelectorAll('h1').length===1 && getComputedStyle(document.querySelector('#inicio')).backgroundColor==='rgb(1, 1, 39)'`), true, 'no-JS navy/copy fallback and no inert control');
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `HTMLCanvasElement.prototype.getContext = () => null;` });
    await cdp.send('Page.reload', { ignoreCache: true });
    await delay(500);
    assert.equal(await evaluate(`document.querySelector('[data-wave-toggle]').hidden && !document.querySelector('[data-particle-wave]').dataset.wavePaints`), true, 'unsupported canvas safe fallback');
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (controller) { await controller.send('Browser.close').catch(() => {}); controller.close(); }
    cdp?.close();
    if (browser.exitCode === null) await until(() => browser.exitCode !== null, 'owned wave Chrome closed').catch(() => browser.kill());
    await new Promise(done => hosted.server.close(done));
    t.diagnostic(`Owned profile retained: ${profile}`);
  }
});

// Observe native delivery without changing capture, routing, or application state.
const nativeWheelReceiptSource = name => `(() => {
  const identities=new WeakMap(),owners=new Map();let nextIdentity=0;
  const identity=node=>{if(!node)return null;if(!identities.has(node))identities.set(node,++nextIdentity);return identities.get(node);};
  window.${name}=[];
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,e=>{
    const current=document.querySelector('[data-works-stage]');
    if(type==='pointerdown'&&current?.contains(e.target))owners.set(e.pointerId,current);
    const owner=owners.get(e.pointerId);
    if(!owner||window.${name}.length>=64)return;
    const row={type,time:performance.now(),timestamp:e.timeStamp,trusted:e.isTrusted,
      id:e.pointerId,pointerType:e.pointerType,button:e.button,buttons:e.buttons,x:e.clientX,y:e.clientY,
      owner:identity(owner),connected:owner.isConnected,currentOwner:owner===current,
      target:identity(e.target),targetTag:e.target.tagName,stageTarget:e.target===owner,
      captured:owner.hasPointerCapture(e.pointerId),targetCaptured:e.target.hasPointerCapture?.(e.pointerId),
      coalesced:e.getCoalescedEvents?.().length??0,focus:document.hasFocus(),hidden:document.hidden};
    window.${name}.push(row);
    queueMicrotask(()=>{row.afterCaptured=owner.hasPointerCapture(e.pointerId);row.prevented=e.defaultPrevented;});
  },{capture:true,passive:true});
})()`;

test('native wheel capture interrupts entrance independently of gallery resize', { timeout: 60000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-capture-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  const errors = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned capture browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const local = new URL(request.url).origin === hosted.origin;
      await cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') errors.push(args.map(a => a.value ?? a.description).join(' '));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: nativeWheelReceiptSource('__captureReceipt') });
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const source = await readFile(new URL('../src/components/ui/works-wheel.tsx', import.meta.url), 'utf8');
    const distance = Number(source.match(/const DRAG_UNITS = (\d+);/)?.[1]);
    const threshold = Number(source.match(/current\.moved > (\d+)/)?.[1]);
    assert.ok(Number.isFinite(distance) && Number.isFinite(threshold));
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate(`document.querySelector('[data-works-showcase]')?.dataset.heroEntrance==='running' && [...document.querySelectorAll('.hero-entrance-word')].some(e=>{const a=Number(getComputedStyle(e).opacity);return a>0&&a<1})`), 'actual in-flight entrance before native drag');
    const gesture = await evaluate(`(() => {
      const stage=document.querySelector('[data-works-stage]'),r=stage.getBoundingClientRect();
      const top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right);
      for(const yr of [.85,.8,.75])for(const xr of [.5,.25,.75]){
        const x=left+(right-left)*xr,y=top+(bottom-top)*yr,hit=document.elementFromPoint(x,y);
        if(y-${distance}>top&&stage.contains(hit)&&!hit.closest('a,button,input,select,textarea,[contenteditable="true"]'))return {x,y,end:y-${distance}};
      }return null;
    })()`);
    assert.ok(gesture, 'hit-tested noninteractive full in-stage trajectory');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gesture.x, y: gesture.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: gesture.x, y: gesture.y });
    const first = threshold + 1;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: gesture.x, y: gesture.y - first });
    await until(() => evaluate(`(() => {const down=window.__captureReceipt.find(e=>e.type==='pointerdown'&&e.trusted);return !!down&&document.querySelector('[data-works-stage]').hasPointerCapture(down.id)})()`), 'application-owned native capture');
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: gesture.x, y: gesture.y - first - (distance - first) * step / 6 });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: gesture.x, y: gesture.end });
    const receipt = await evaluate('window.__captureReceipt');
    t.diagnostic(`independent native delivery: ${JSON.stringify({gesture,cancels:receipt.filter(e=>e.type==='pointercancel').length})}`);
    for (const event of receipt) t.diagnostic(`independent native pointer: ${JSON.stringify(event)}`);
    assert.ok(receipt.some(e => e.type === 'gotpointercapture' && e.trusted && e.captured));
    assert.ok(receipt.some(e => e.type === 'pointermove' && e.trusted && e.captured && e.stageTarget));
    assert.ok(receipt.some(e => e.type === 'pointerup' && e.trusted));
    await until(() => evaluate(`(() => {const root=document.querySelector('[data-works-showcase]');return root.dataset.heroEntrance==='complete'&&Number(root.querySelector('[data-works-stage]').dataset.turn)===1&&[...root.querySelectorAll('.hero-entrance-word,[data-hero-photo]')].every(e=>getComputedStyle(e).opacity==='1'&&getComputedStyle(e).transform==='none')})()`), 'drag advances turn and restores every entrance pose');
    assert.equal(await evaluate(`document.querySelectorAll('h1').length===1&&document.querySelectorAll('.hero-entrance-word').length===0&&getComputedStyle(document.querySelector('h1')).opacity==='1'&&[...document.querySelectorAll('[data-hero-reveal]')].every(e=>getComputedStyle(e).opacity==='1'&&getComputedStyle(e).transform==='none')`), true, 'original single heading and all reveal poses restored');
    assert.equal(await evaluate(`document.querySelector('[data-works-stage]').hasPointerCapture(${receipt.find(e => e.type === 'pointerdown').id})`), false, 'native release retires capture');
    const click = async selector => {
      const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
      assert.equal(point.hit, true, 'actual artwork card receives native click');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    };
    assert.equal(await evaluate(`document.querySelectorAll('[data-work-index],[data-works-reset]').length`), 0, 'homepage intentionally omits CSS controls');
    const key = async (value, code) => {
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: code });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: code });
    };
    const selected = i => until(() => evaluate(`Number(document.querySelector('[data-works-stage]').dataset.turn)===${i + 1}&&document.querySelector('[data-work-card="${i}"]').getAttribute('aria-selected')==='true'`), `native stage selects artwork ${i + 1}`);
    await key('Home', 36);
    await until(() => evaluate(`document.querySelector('[data-works-stage]').dataset.turn==='0'`), 'native Home resets ring');
    await click('[data-work-card="0"]');
    await selected(0);
    await key('ArrowDown', 40);
    await selected(1);
    await key('ArrowUp', 38);
    await selected(0);
    for (let i = 1; i < 8; i++) {
      await key('ArrowDown', 40);
      await selected(i);
    }
    const endpoint = () => evaluate(`(() => {
      const stage=document.querySelector('[data-works-stage]');
      window.__endpointOwner??=stage;
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
      const card=stage.querySelector('[aria-selected="true"]'),details=document.querySelector('[data-details-overlay]');
      return {epoch:performance.timeOrigin,ownerStable:stage===window.__endpointOwner,connected:stage.isConnected,
        turn:Number(stage.dataset.turn),draws:Number(stage.dataset.draws),active:stage.getAttribute('aria-activedescendant'),
        geometry:{stage:rect(stage),card:rect(card),placement:card.style.transform,face:card.firstElementChild.style.transform,
          selected:card.dataset.workCard,ariaSelected:card.getAttribute('aria-selected'),details:rect(details),
          title:details.querySelector('[data-work-title]')?.textContent,height:stage.clientHeight}};
    })()`);
    const beforeEnd = await endpoint();
    t.diagnostic(`endpoint before redundant End: ${JSON.stringify(beforeEnd)}`);
    await key('End', 35);
    await selected(7);
    // End wakes one owned draw even when selection is already at the endpoint.
    const consumedEnd = await until(async () => {
      const value = await endpoint();
      return value.epoch === beforeEnd.epoch && value.ownerStable && value.connected
        && value.draws > beforeEnd.draws && value.turn === 8
        && JSON.stringify(value.geometry) === JSON.stringify(beforeEnd.geometry)
        && value.active === beforeEnd.active && value;
    }, 'redundant native End draw consumed by the same settled stage');
    t.diagnostic(`endpoint redundant End consumed: ${JSON.stringify(consumedEnd)}`);
    await delay(250);
    const quietEndpoint = await endpoint();
    t.diagnostic(`endpoint strict quiet pair: ${JSON.stringify({before:consumedEnd,after:quietEndpoint})}`);
    assert.equal(quietEndpoint.draws, consumedEnd.draws, 'endpoint schedules no idle owned draws');
    assert.deepEqual(quietEndpoint, consumedEnd, 'same endpoint owner, selection and geometry remain settled');
    await key('Home', 36);
    await until(() => evaluate(`document.querySelector('[data-works-stage]').dataset.turn==='0'`), 'native reset restores ring');
    const ringDraws = await evaluate(`document.querySelector('[data-works-stage]').dataset.draws`);
    await delay(250);
    assert.equal(await evaluate(`document.querySelector('[data-works-stage]').dataset.draws`), ringDraws, 'ring endpoint schedules no idle owned draws');
    assert.deepEqual(errors, []);
    assert.deepEqual(cdp.errors, []);
    t.diagnostic(`independent native capture: distance=${distance}, threshold=${threshold}; absent CSS controls, native card selection, eight keyboard selections, ArrowUp/Home/End, complete entrance and both no-idle endpoints passed`);
  } catch (error) {
    if (cdp) {
      try {
        const snapshot = await cdp.send('Runtime.evaluate', {
          expression: `({events:window.__captureReceipt??[],epoch:performance.timeOrigin,ownerStable:document.querySelector('[data-works-stage]')===window.__endpointOwner,stage:document.querySelector('[data-works-stage]')?.dataset,entrance:document.querySelector('[data-works-showcase]')?.dataset,hidden:document.hidden,focus:document.hasFocus()})`, returnByValue: true,
        });
        const { events, ...state } = snapshot.result?.value??{};
        t.diagnostic(`Failure-time independent state: ${JSON.stringify(state)}`);
        for (const event of events??[]) t.diagnostic(`Failure-time independent pointer: ${JSON.stringify(event)}`);
        if (snapshot.exceptionDetails) t.diagnostic(`Pointer receipt diagnostic exception: ${JSON.stringify(snapshot.exceptionDetails)}`);
      } catch (diagnosticError) {
        t.diagnostic(`Pointer receipt diagnostics unavailable: ${diagnosticError.message}`);
      }
    } else t.diagnostic('Pointer receipt diagnostics unavailable: browser connection was not established');
    throw error;
  } finally {
    if (cdp) await cdp.send('Browser.close').catch(() => {});
    cdp?.close();
    if (browser.exitCode === null) await until(() => browser.exitCode !== null, 'owned capture browser exit').catch(() => browser.kill());
    hosted.server.closeAllConnections();
    await new Promise(done => hosted.server.close(done));
    t.diagnostic(`Owned capture browser exited=${browser.exitCode !== null}; server closed; profile retained: ${profile}`);
  }
});

test('hero community CTA and timeline actions absence', { timeout: 60000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-actions-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let controller;
  const blocked = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned actions browser port', 15000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    controller = await connect(version.webSocketDebuggerUrl);
    controller.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
      if (targetInfo.targetId === page.id) return;
      await controller.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
      await controller.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    });
    controller.on('Fetch.requestPaused', async ({ requestId, request }, sessionId) => {
      // Pause new popup sessions before any destination fetch.
      blocked.push(request.url);
      await controller.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
    });
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      if (new URL(request.url).origin === hosted.origin) await cdp.send('Fetch.continueRequest', { requestId });
      else {
        blocked.push(request.url);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    const evaluate = async expression => {
      const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(value.exceptionDetails, undefined);
      return value.result.value;
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate(`!!document.querySelector('[data-timeline][data-enhanced]')`), 'animated Timeline initialized');
    const assertActions = async () => {
      assert.deepEqual(await evaluate(`(() => {const intro=document.querySelector('[data-hero-intro]'),root=document.querySelector('[data-timeline]');return {links:[...intro.querySelectorAll('a')].map(a=>[a.textContent.trim(),a.getAttribute('href'),a.target,a.rel]),actions:root.querySelectorAll('.timeline-actions,.timeline-heading button,a[href="#pilares"]').length,headings:[...root.querySelectorAll('li h3')].map(h=>h.textContent.trim()),media:root.querySelectorAll('[data-timeline-image]').length}})()`), {
        links: [['Explorar formación', '#formacion', '', ''], ['Conocer la comunidad', 'https://linktr.ee/web3chile', '_blank', 'noopener noreferrer']],
        actions: 0, headings: ['BlockCamp', 'Workshop Polkadot', 'Avalanche Bootcamp', 'VendimiaTech', 'Dev3Pack', 'Blockchain Summit Latam', 'Próximo capítulo'], media: 6,
      });
    };
    await assertActions();
    await controller.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }] });
    const point = await evaluate(`(() => {const r=document.querySelector('[data-hero-intro] a[target="_blank"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await until(() => blocked.includes('https://linktr.ee/web3chile'), 'intercepted exact community popup');
    await controller.send('Target.activateTarget', { targetId: page.id });
    await cdp.send('Page.bringToFront');
    for (const [width, height, reduce] of [[390, 844, true], [844, 390, false]]) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      const chronology = () => evaluate(`(() => {
        const root=document.querySelector('[data-timeline]'),track=root.querySelector('[data-timeline-track]');
        const rail=getComputedStyle(track,'::before'),canvas=getComputedStyle(root.querySelector('[data-timeline-canvas]'));
        return {viewport:[innerWidth,innerHeight],reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
          enhanced:root.dataset.enhanced??null,mode:root.dataset.mode??null,triggers:Number(root.dataset.ownedTriggers||0),
          noSplit:!root.querySelector('.timeline-split-line'),position:canvas.position,trackTransform:getComputedStyle(track).transform,
          trackIdentity:new DOMMatrix(getComputedStyle(track).transform).isIdentity,
          rail:{content:rail.content,width:parseFloat(rail.width),height:parseFloat(rail.height),opacity:rail.opacity},
          dots:[...root.querySelectorAll('[data-dot]')].map(dot=>{const r=dot.getBoundingClientRect(),s=getComputedStyle(dot);
            return {width:r.width,height:r.height,display:s.display,visibility:s.visibility};})};
      })()`);
      const expected = {enhanced:reduce?null:'true',mode:reduce?null:'vertical',triggers:reduce?0:1};
      let receipt;
      try {
        await until(async () => {
          receipt = await chronology();
          return receipt.viewport[0]===width && receipt.viewport[1]===height && receipt.reduced===reduce
            && receipt.enhanced===expected.enhanced && receipt.mode===expected.mode
            && receipt.triggers===expected.triggers && receipt.noSplit;
        }, 'current viewport and fixture-specific timeline policy');
      } finally {
        t.diagnostic(`actions chronology ${width}x${height} reduce=${reduce}: ${JSON.stringify(receipt)}`);
      }
      assert.deepEqual({enhanced:receipt.enhanced,mode:receipt.mode,triggers:receipt.triggers}, expected);
      assert.equal(receipt.noSplit, true, 'mobile/tablet has no desktop SplitText');
      assert.ok(['static','relative'].includes(receipt.position), 'native chronology remains normal flow');
      assert.equal(receipt.trackIdentity, true, 'native track is not horizontally translated');
      assert.ok(receipt.rail.content!=='none' && receipt.rail.width>=1 && receipt.rail.height>0 && receipt.rail.opacity==='1', 'base rail remains visible');
      assert.equal(receipt.dots.length, 7);
      assert.ok(receipt.dots.every(dot=>dot.width>=10 && dot.height>=10 && dot.display==='block' && dot.visibility==='visible'), 'all native dots remain visible');
      await assertActions();
      for (let index = 0; index < 7; index++) {
        assert.equal(await evaluate(`(() => {const h=document.querySelectorAll('[data-timeline] li h3')[${index}];h.scrollIntoView({block:'center',behavior:'instant'});const r=h.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight&&getComputedStyle(h).visibility==='visible'})()`), true, 'native milestone reachable');
      }
      await evaluate(`document.querySelector('[data-timeline-image]').click()`);
      await until(() => evaluate(`!!document.querySelector('dialog[open]')`), 'native image modal');
      await controller.send('Target.activateTarget', { targetId: page.id });
      await cdp.send('Page.bringToFront');
      assert.equal(await evaluate(`document.hasFocus() && document.querySelector('dialog[open]').contains(document.activeElement)`), true, 'actual modal focus before Escape');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await until(() => evaluate(`!document.querySelector('dialog[open]')`), 'modal Escape closes');
    }
    assert.deepEqual(cdp.errors, []);
    assert.deepEqual(controller.errors, []);
    assert.ok(blocked.includes('https://linktr.ee/web3chile'));
    t.diagnostic('Hydrated DOM, exact blocked popup, reduced static and short-landscape enhanced vertical chronology/modal passed; seven milestones per fixture; no external destination fetched.');
  } finally {
    if (controller) { await controller.send('Browser.close').catch(() => {}); controller.close(); }
    cdp?.close();
    if (browser.exitCode === null) await until(() => browser.exitCode !== null, 'owned actions Chrome closed').catch(() => browser.kill());
    await new Promise(done => hosted.server.close(done));
    t.diagnostic(`Owned profile retained: ${profile}`);
  }
});

test('hero decoded image fade entrance', { timeout: 120000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-fade-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let cdp;
  let brokenImage = false;
  let drain;
  let epoch = 0;
  const interceptionTrace = [];
  const requests = new Map();
  const ownedCallbacks = new Set();
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned orbit browser port', 15000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(value => value.type === 'page' && value.url === 'about:blank');
    cdp = await connect(target.webSocketDebuggerUrl);
    cdp.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) interceptionTrace.push({ event: 'document', epoch: ++epoch, time: Date.now() });
    });
    cdp.on('Fetch.requestPaused', ({ requestId, request, resourceType, networkId }) => {
      const url = new URL(request.url);
      const held = url.origin === hosted.origin && resourceType === 'Image'
        && /\/(vendimiatech-chiledao|sub0-chiledao)\./.test(url.pathname);
      const fail = !(url.origin === hosted.origin || url.protocol === 'data:')
        || (brokenImage && held && /\/sub0-chiledao\./.test(url.pathname));
      const pause = { requestId, networkId, url: request.url, epoch, time: Date.now(), held,
        action: fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', sends: 0, acknowledged: false };
      assert.equal(requests.has(requestId), false, 'one owner per live pause');
      requests.set(requestId, pause);
      interceptionTrace.push({ event: 'pause', ...pause });
      const callback = (async () => {
        // Snapshot the action at acquisition and retain the real 1300ms hold.
        if (held) await delay(1300);
        assert.equal(pause.epoch, epoch, 'no old-document callback sends after navigation');
        pause.sends += 1;
        interceptionTrace.push({ event: 'send', ...pause, currentEpoch: epoch, time: Date.now() });
        await cdp.send(pause.action, { requestId, ...(fail ? { errorReason: 'BlockedByClient' } : {}) });
        pause.acknowledged = true;
        interceptionTrace.push({ event: 'acknowledged', ...pause, time: Date.now() });
      })();
      ownedCallbacks.add(callback);
      // The connection still records every real rejection; drain awaits it too.
      return callback.finally(() => ownedCallbacks.delete(callback));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const evaluate = async expression => {
      const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    drain = async () => {
      // A browser round trip delivers pending pause events before inspecting
      // the registry. Repeat only when newly acquired finite work exists.
      do {
        await cdp.send('Runtime.evaluate', { expression: '0' });
        await Promise.all([...ownedCallbacks]);
        await cdp.send('Runtime.evaluate', { expression: '0' });
      } while (ownedCallbacks.size);
      for (const pause of requests.values()) {
        assert.equal(pause.sends, 1, `exactly one terminal send: ${pause.requestId}`);
        assert.equal(pause.acknowledged, true, `terminal action acknowledged: ${pause.requestId}`);
      }
      assert.deepEqual(cdp.errors, []);
    };
    const navigate = async () => {
      await drain();
      await cdp.send('Page.navigate', { url: hosted.origin });
    };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
       window.__orbitSamples=[];
       window.__fadeTrace=[];
       const trace=(event,fields={})=>window.__fadeTrace.push({event,time:performance.now(),...fields});
       const observed=new WeakSet();
       new PerformanceObserver(list=>list.getEntries().forEach(e=>trace('longtask',{start:e.startTime,duration:e.duration}))).observe({type:'longtask',buffered:true});
       let previousFrame=0;
        const sample=()=>{
         const now=performance.now();
         if(previousFrame&&now-previousFrame>50)trace('frame-gap',{from:previousFrame,gap:now-previousFrame});
         previousFrame=now;
        const photos=[...document.querySelectorAll('[data-hero-photo]')];
        if(photos.length===8){
           const stage=document.querySelector('[data-works-stage]');
          window.__orbitSamples.push({time:performance.now(),phase:document.querySelector('[data-works-showcase]').dataset.heroEntrance,
             turn:Number(stage.dataset.turn),headings:document.querySelectorAll('#inicio h1').length,
             cards:photos.map(p=>{const r=p.getBoundingClientRect(),s=getComputedStyle(p),f=p.closest('[data-work-face]').getBoundingClientRect();
                 const img=p.querySelector('img');
                 for(const animation of p.getAnimations())if(!observed.has(animation)){
                   observed.add(animation);
                   const index=photos.indexOf(p);
                   const state=()=>({index,start:animation.startTime,current:animation.currentTime,play:animation.playState,timing:animation.effect.getComputedTiming()});
                   trace('observed-animation',state());
                   animation.ready.then(()=>trace('ready',state()),()=>trace('ready-cancelled',state()));
                   animation.finished.then(()=>trace('finished',state()),()=>trace('cancelled',state()));
                 }
                return {decoded:img.complete&&img.naturalWidth>0,state:p.dataset.photoReady,src:img.currentSrc,x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,slotX:f.x+f.width/2,slotY:f.y+f.height/2,rotate:s.rotate,alpha:Number(s.opacity),transform:s.transform};})});
        }
        if(performance.now()<3000)requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    ` });
    for (const width of [1440, 390, 320]) {
      await drain();
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 900 : 844, deviceScaleFactor: 1, mobile: width < 600 });
      await navigate();
       await until(() => evaluate(`window.__orbitSamples?.length>0`), 'first painted static ring', 1500);
       const initialCapture = await cdp.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
       await writeFile(`${profile}-${width}-initial-static-ring.png`, Buffer.from(initialCapture.data,'base64'));
       t.diagnostic(`capture: ${profile}-${width}-initial-static-ring.png`);
        await until(() => evaluate(`window.__orbitSamples?.some(s=>s.cards[6].decoded)`), 'actual delayed image arrival', 3000);
        const arrival = await evaluate(`window.__orbitSamples.find(s=>s.cards[6].decoded)`);
        t.diagnostic(`first delayed decoded frame ${width}: ${JSON.stringify({time:arrival.time,cards:arrival.cards.map(c=>({decoded:c.decoded,alpha:c.alpha,state:c.state,src:c.src}))})}`);
        t.diagnostic(`before arrival ${width}: ${JSON.stringify(await evaluate(`window.__orbitSamples.find(s=>s.time>900)?.cards.map(c=>({decoded:c.decoded,alpha:c.alpha}))`))}`);
        assert.ok(arrival.cards[6].alpha < .2, 'late decoded image must start near transparent, not pop in opaque');
        await until(() => evaluate(`window.__orbitSamples?.some(s=>s.cards[6].decoded&&s.cards[6].alpha>.2&&s.cards[6].alpha<.9)`), 'visible decoded image fade progression', 1500);
       assert.equal(await evaluate(`window.__orbitSamples.every(s=>s.cards.every(c=>c.transform==='none'))`), true, 'no entrance photo transforms, including first paint');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
       const path = `${profile}-${width}-midfade.png`;
      await writeFile(path, Buffer.from(data, 'base64'));
      t.diagnostic(`capture: ${path}`);
       await until(() => evaluate(`document.querySelector('[data-works-showcase]')?.dataset.heroEntrance==='complete' && [...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1')`), 'bounded per-image entrance completion', 3500);
      const samples = await evaluate('window.__orbitSamples');
       for (const row of await evaluate('window.__fadeTrace')) t.diagnostic(`fade lifecycle ${width}: ${JSON.stringify(row)}`);
       const last = samples.at(-1);
       for(let frame=1;frame<samples.length;frame++) for(let i=0;i<8;i++) {
         assert.ok(samples[frame].cards[i].alpha>=samples[frame-1].cards[i].alpha-.001, 'adoption never rehides or replays photos');
       }
       for (const sample of samples) for (const [index, card] of sample.cards.entries()) {
         assert.equal(sample.turn, 0); assert.equal(sample.headings, 1);
         assert.equal(card.transform, 'none'); assert.equal(card.rotate, 'none');
         assert.ok(Math.hypot(card.x-card.slotX,card.y-card.slotY)<2, 'photo stays at actual outer slot');
         for(const key of ['x','y','w','h']) assert.ok(Math.abs(card[key]-last.cards[index][key])<2, `static first/mid/end card ${index} ${key}`);
          assert.ok(card.alpha>=0 && card.alpha<=1);
       }
        const settled = Array.from({length:8},(_,i)=>samples.find(s=>s.cards[i].decoded&&s.cards[i].alpha===1)?.time);
       assert.ok(settled.every(Number.isFinite), JSON.stringify(settled));
        for (let i=0;i<8;i++) {
          const first = samples.find(s=>s.cards[i].decoded);
          assert.ok(first.cards[i].alpha<.2, `first decoded frame ${i} starts near zero`);
           assert.ok(settled[i]-first.time>=600 && settled[i]-first.time<=950,
             `per-image visible 800ms fade: image ${i}, first ${first.time}, settled ${settled[i]}, duration ${settled[i]-first.time}`);
        }
        assert.ok(samples.some(s=>s.cards.slice(0,6).every(c=>c.decoded&&c.alpha===1)&&s.cards.slice(6).every(c=>!c.decoded)), 'fast images finish independently of held images');
       await evaluate(`Promise.all([...document.querySelectorAll('[data-hero-photo] img')].map(i=>i.decode()))`);
      assert.equal(await evaluate(`Number(document.querySelector('[data-works-stage]').dataset.turn)`), 0);
      assert.equal(await evaluate(`[...document.querySelectorAll('[data-hero-photo] img')].filter(i=>i.complete&&i.naturalWidth>0).length`), 8);
      assert.equal(await evaluate(`[...document.querySelectorAll('[data-hero-photo]')].every(p=>{
        const a=p.getBoundingClientRect(),b=p.closest('[data-work-face]').getBoundingClientRect();
        return getComputedStyle(p).transform==='none' && getComputedStyle(p).opacity==='1'
          && ['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<2);
      })`), true, 'all inner owners reset to actual final slots');
      const finalCapture = await cdp.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
      await writeFile(`${profile}-${width}-settled.png`, Buffer.from(finalCapture.data,'base64'));
      t.diagnostic(`capture: ${profile}-${width}-settled.png`);
       t.diagnostic(`fade ${width}: settling ms ${JSON.stringify(settled)}; ${samples.length} first/mid/end frames, inner transforms none, actual slot/geometry deltas <2px`);
    }
    // Actual early input and preference changes interrupt rather than lock the
    // scene. No transforms/progress are injected by this test.
    await drain();
    const responsiveEpoch = epoch;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:1, mobile:false });
    await until(() => ['sub0-chiledao', 'vendimiatech-chiledao'].every(family =>
      [...requests.values()].some(pause => pause.epoch === responsiveEpoch && pause.held
        && pause.url.includes(family) && !pause.acknowledged)), 'both responsive image families held before navigation');
    for (const input of ['keyboard', 'pointer', 'wheel', 'resize', 'live-reduced']) {
      await navigate();
      await until(() => evaluate(`document.querySelector('[data-works-stage]')?.dataset.draws && document.querySelector('[data-works-showcase]')?.dataset.heroEntrance!=='complete'`), `early ${input} prerequisite`);
      const began = await evaluate('performance.now()');
      assert.ok(began<700, `input while entry is pending: ${began}`);
      t.diagnostic(`early ${input}: input at ${began}ms`);
       if (input==='resize') {
         const before = await evaluate(`(() => {
           window.__realPhotoResize=null;
           window.addEventListener('resize',e=>window.__realPhotoResize={trusted:e.isTrusted,viewport:[innerWidth,innerHeight]}, {once:true});
           return {viewport:[innerWidth,innerHeight],states:[...document.querySelectorAll('[data-hero-photo]')].map(p=>({state:p.dataset.photoReady,effects:p.getAnimations().length}))};
         })()`);
         assert.ok(before.states.some(p=>p.state==='fading'&&p.effects>0), 'genuine resize interrupts actual native playback');
         assert.ok(before.states.some(p=>p.state==='pending'), 'genuine resize also owns delayed readiness');
         await cdp.send('Emulation.setDeviceMetricsOverride', {width:1390,height:900,deviceScaleFactor:1,mobile:false});
         await until(() => evaluate('window.__realPhotoResize?.trusted && innerWidth===1390'), 'real changed viewport resize delivered');
         t.diagnostic(`photo genuine resize: ${JSON.stringify({before,event:await evaluate('window.__realPhotoResize')})}`);
       } else if (input==='live-reduced') {
        await cdp.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
      } else if (input==='keyboard') {
        await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
        await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
        await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40 });
       } else if (input==='pointer') {
         const point=await evaluate(`(() => {const r=document.querySelector('[data-hero-photo]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
         await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
         await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
       } else {
        await cdp.send('Input.dispatchMouseEvent', { type:'mouseWheel', x:1100, y:450, deltaX:0, deltaY:900 });
      }
      await until(() => evaluate(`document.querySelector('[data-works-showcase]').dataset.heroEntrance==='complete' && [...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).transform==='none'&&getComputedStyle(p).opacity==='1')`), `immediate ${input} completion`, 800);
      assert.ok(await evaluate(`performance.now()-${began}<800`), 'input does not await choreography');
       if(input!=='live-reduced'&&input!=='resize') await until(() => evaluate(`Math.abs(Number(document.querySelector('[data-works-stage]').dataset.turn)-1)<.001 && document.querySelector('[data-works-showcase]').dataset.mode==='drum'`), 'original selection remains responsive');
        else if(input==='live-reduced') await cdp.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'no-preference'}] });
       // Drain this document's finite image holds before navigating again.
       // Also prove late arrivals stay visible after an actual interruption.
       await evaluate(`Promise.all([...document.querySelectorAll('[data-hero-photo] img')].map(i=>i.decode()))`);
        assert.equal(await evaluate(`[...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1'&&p.getAnimations().length===0)`), true, 'late ready images never get stuck or replay after interruption');
        if(input==='resize') {
          await drain();
          await cdp.send('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
          assert.equal(await evaluate(`[...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1'&&p.getAnimations().length===0)`), true, 'viewport return never replays completed photos');
        }
    }
    await cdp.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
    await navigate();
    await until(() => evaluate(`document.querySelector('[data-works-showcase]')?.dataset.heroEntrance==='complete'`), 'initial reduced motion bypass');
     assert.equal(await evaluate(`window.__orbitSamples.some(s=>s.cards.some(c=>c.transform!=='none'||c.alpha!==1))`), false);
     await evaluate(`Promise.all([...document.querySelectorAll('[data-hero-photo] img')].map(i=>i.decode()))`);
    await cdp.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'no-preference'}] });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
    await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
    await cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
    assert.equal(await evaluate(`document.querySelector('[data-works-showcase]').dataset.heroEntrance`), 'complete', 'Home/resize/preference do not replay');
    brokenImage = true;
    await navigate();
    await until(() => evaluate(`document.readyState==='complete' && [...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1')`), 'broken image fallback', 4000);
    assert.equal(await evaluate(`(() => {const p=document.querySelectorAll('[data-hero-photo]')[6],i=p.querySelector('img');return i.complete&&i.naturalWidth===0&&!!i.alt&&p.getAttribute('href').startsWith('/_astro/')&&getComputedStyle(p).opacity==='1'})()`), true, 'broken image retains visible alt and original artwork link');
    await drain();
    assert.deepEqual(cdp.errors, []);
  } finally {
    t.diagnostic(`Interception trace: ${JSON.stringify(interceptionTrace.filter(row => row.event === 'document' || /\/(vendimiatech-chiledao|sub0-chiledao)\./.test(row.url ?? '')))}`);
    try {
      if (drain) await drain();
    } finally {
      if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); }
      await new Promise(done => { if (browser.exitCode !== null) done(); else browser.once('exit', done); });
      await new Promise(done => hosted.server.close(done));
      t.diagnostic(`Cleanup: owned fade browser exited=${browser.exitCode !== null}; server closed=${!hosted.server.listening}; profile retained=${profile}`);
    }
  }
});

test('timeline modal declaration ownership', { timeout: 90000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-declarations-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let evaluate;
  let ownershipPassed = false;
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned declaration browser port', 15000);
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const local = new URL(request.url).origin === hosted.origin;
      await cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) });
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.declarationTrace=[];
      window.refreshTrace=[];
      const declaration=()=>({value:document.documentElement?.style.getPropertyValue('scroll-behavior'),
        priority:document.documentElement?.style.getPropertyPriority('scroll-behavior')});
      const trace=(event,detail={})=>refreshTrace.push({event,time:performance.now(),...detail,
        declaration:declaration(),enhanced:document.querySelector('[data-timeline]')?.dataset.enhanced,
        open:!!document.querySelector('dialog[open]')});
      const raf=requestAnimationFrame,cancel=cancelAnimationFrame;
      const frames=window.declarationFrames=new Map();
      window.requestAnimationFrame=callback=>{
        const stack=new Error().stack;
        if(!/timeline\\.|ScrollTrigger\\./.test(stack))return raf(callback);
        const caller=stack.split('\\n').slice(2,5).join('\\n');
        const id=raf(time=>{trace('frame-run',{id,caller});frames.delete(id);
          callback(time);trace('frame-end',{id,caller});});
        frames.set(id,caller);trace('frame-queue',{id,caller});return id;
      };
      window.cancelAnimationFrame=id=>{
        if(frames.has(id)){trace('frame-cancel',{id,caller:frames.get(id)});frames.delete(id)}
        cancel(id);
      };
      const record=(style,property,value,priority)=>{
        if(style===document.documentElement?.style||style===document.body?.style)
          window.declarationTrace.push({time:performance.now(),element:style===document.body?.style?'body':'html',
            property,value,priority,stack:new Error().stack,open:!!document.querySelector('dialog[open]')});
      };
      const original=CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty=function(property,value,priority){
        if(property==='scroll-behavior')trace('write',{value,priority,caller:new Error().stack.split('\\n').slice(2,5).join('\\n')});
        record(this,property,value,priority);return original.call(this,property,value,priority);
      };
      const remove=CSSStyleDeclaration.prototype.removeProperty;
      CSSStyleDeclaration.prototype.removeProperty=function(property){
        if(property==='scroll-behavior')trace('remove',{caller:new Error().stack.split('\\n').slice(2,5).join('\\n')});
        return remove.call(this,property);
      };
      // Chrome exposes CSS named properties dynamically, not as prototype
      // descriptors. Delegate to the native CSS methods without changing CSS.
      Object.defineProperty(CSSStyleDeclaration.prototype,'scrollBehavior',{
        configurable:true,enumerable:true,get(){return this.getPropertyValue('scroll-behavior')},
        set(value){trace('gsap-write',{value,caller:new Error().stack.split('\\n').slice(2,5).join('\\n')});
          record(this,'scroll-behavior',value,'');original.call(this,'scroll-behavior',value,'')}
      });
      window.declarationErrors=[];
      addEventListener('error',event=>declarationErrors.push(event.message));
      addEventListener('unhandledrejection',event=>declarationErrors.push(String(event.reason)));
    ` });
    evaluate = async expression => {
      const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const metrics = width => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    const reduce = value => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    const snapshot = () => evaluate(`(() => {
      const properties=['scroll-behavior','overflow','position','top','left','width'];
      return {html:document.documentElement.style.cssText,body:document.body.style.cssText,
        declarations:[document.documentElement,document.body].map(element=>properties.map(property=>({
          property,present:element.style.getPropertyValue(property)!=='',value:element.style.getPropertyValue(property),
          priority:element.style.getPropertyPriority(property)}))),scroll:scrollY,
        open:!!document.querySelector('dialog[open]'),focus:document.activeElement?.getAttribute('data-timeline-image')};
    })()`);
    await metrics(1440);
    await reduce('no-preference');
    await cdp.send('Page.navigate', { url: hosted.origin });
    await until(() => evaluate(`document.querySelector('[data-timeline]')?.dataset.enhanced && document.fonts.status==='loaded'
      && [...document.querySelectorAll('[data-timeline] img')].every(image=>image.complete&&image.naturalWidth>0)
      && window.declarationTrace.some(row=>row.property==='scroll-behavior'&&row.stack.includes('ScrollTrigger'))`), 'real initial refresh and media completion');
    await evaluate(`(async () => {
      const url=performance.getEntriesByType('resource').find(entry=>/\\/ScrollTrigger\\.[^/]+\\.js$/.test(new URL(entry.name).pathname)).name;
      const module=await import(url);
      window.ownershipTrigger=Object.values(module).find(value=>typeof value?.refresh==='function'&&typeof value?.getAll==='function');
      window.refreshOwnership={started:0,completed:0,settled:0};
      ownershipTrigger.addEventListener('refreshInit',()=>{refreshOwnership.started++;
        refreshTrace.push({event:'refresh-begin',transaction:refreshOwnership.started,time:performance.now(),
          value:document.documentElement.style.getPropertyValue('scroll-behavior'),priority:document.documentElement.style.getPropertyPriority('scroll-behavior')});});
      ownershipTrigger.addEventListener('refresh',()=>{
        const completed=++refreshOwnership.completed;
        refreshTrace.push({event:'refresh-end',transaction:completed,time:performance.now(),
          value:document.documentElement.style.getPropertyValue('scroll-behavior'),priority:document.documentElement.style.getPropertyPriority('scroll-behavior')});
        requestAnimationFrame(()=>{refreshOwnership.settled=completed});
      });
    })()`);
    const settledRefresh = async () => {
      const started = await evaluate(`refreshOwnership.started`);
      await evaluate(`ownershipTrigger.refresh()`);
      await until(() => evaluate(`refreshOwnership.started>${started}
        && refreshOwnership.started===refreshOwnership.completed
        && refreshOwnership.completed===refreshOwnership.settled
        && ![...declarationFrames.values()].some(caller=>caller.includes('/timeline.'))`), 'real refresh and queued restoration complete');
    };
    for (const [value, priority] of [['smooth', 'important'], ['', ''], ['auto', '']]) {
      await metrics(1440);
      await reduce('no-preference');
      await until(() => evaluate(`!!document.querySelector('[data-timeline]')?.dataset.enhanced`), 'enhanced declaration fixture');
      await settledRefresh();
      // Explicit fixture declarations, not claims about application-generated CSS.
      await evaluate(`(() => {
        window.scrollTo({top:scrollY+document.querySelector('[data-timeline]').getBoundingClientRect().top-81,behavior:'instant'});
        const link=document.querySelector('[data-timeline-image]');link.focus({preventScroll:true});
        document.documentElement.style.setProperty('--ownership-fixture','root');
        document.body.style.setProperty('--ownership-fixture','body');
        ${value ? `document.documentElement.style.setProperty('scroll-behavior',${JSON.stringify(value)},${JSON.stringify(priority)});` : `document.documentElement.style.removeProperty('scroll-behavior');`}
      })()`);
      await until(() => evaluate(`(() => {const r=document.querySelector('[data-timeline-image]').getBoundingClientRect();
        return scrollY>0 && r.y>=0 && r.bottom<=innerHeight})()`), 'focused thumbnail aligned before declaration snapshot');
      const before = await snapshot();
      await evaluate(`refreshTrace.push({event:'fixture',time:performance.now(),value:${JSON.stringify(value)},priority:${JSON.stringify(priority)}})`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await until(() => evaluate(`!!document.querySelector('dialog[open]') && document.body.style.position==='fixed'`), 'native modal acquisition');
      const acquired = await snapshot();
      t.diagnostic(`Declaration acquisition ${value || 'absent'}: ${JSON.stringify({before:before.html,acquired:acquired.html})}`);
      assert.deepEqual(acquired.declarations[0][0], before.declarations[0][0], 'modal does not acquire unrelated scroll behavior');
      await metrics(390);
      await reduce('reduce');
      await until(() => evaluate(`!document.querySelector('[data-timeline]')?.dataset.enhanced`), 'live reduced native chronology');
      await settledRefresh();
      const during = await snapshot();
      t.diagnostic(`Declaration during ${value || 'absent'}: ${JSON.stringify({html:during.html,body:during.body,open:during.open})}`);
      assert.equal(during.open, true);
      assert.equal(during.html, acquired.html, 'resize/reduced motion preserve acquired root declarations');
      assert.equal(during.body, acquired.body, 'resize/reduced motion preserve acquired body declarations');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await until(() => evaluate(`!document.querySelector('dialog[open]') && document.body.style.position!=='fixed'`), 'native modal cleanup');
      const after = await snapshot();
      t.diagnostic(`Declaration cleanup ${value || 'absent'}: ${JSON.stringify({html:after.html,body:after.body,scroll:after.scroll,focus:after.focus})}`);
      assert.equal(after.html, before.html, 'exact root cssText restored');
      assert.equal(after.body, before.body, 'exact body cssText restored');
      assert.deepEqual(after.declarations, before.declarations, 'presence/value/priority restored');
      assert.ok(Math.abs(after.scroll - before.scroll) <= 1, 'scroll restored within one pixel');
      assert.equal(after.focus, before.focus, 'invoking link focus restored');
      await reduce('no-preference');
      await until(() => evaluate(`document.querySelector('[data-timeline]')?.dataset.mode==='vertical'`), 'queued vertical enhancement after cleanup');
      await settledRefresh();
      const refreshed = await snapshot();
      assert.equal(refreshed.html, before.html, 'queued refresh preserves exact root cssText');
      assert.equal(refreshed.body, before.body, 'queued refresh preserves exact body cssText');
      t.diagnostic(`Declaration restoration ${value || 'absent'}: exact presence/value/priority, unrelated styles, focus and scroll passed`);
    }
    assert.deepEqual(cdp.errors, []);
    assert.deepEqual(await evaluate('window.declarationErrors'), []);
    ownershipPassed = true;
  } finally {
    if (evaluate) {
      const trace = await evaluate(`window.refreshTrace.filter(row=>row.time>=window.refreshTrace.find(row=>row.event==='fixture')?.time)`);
      const counts = trace.reduce((counts, row) => {
        counts[row.event] = (counts[row.event] ?? 0) + 1;
        return counts;
      }, {});
      t.diagnostic(`Refresh transaction summary: ${JSON.stringify({passed:ownershipPassed,counts})}`);
      if (!ownershipPassed) for (const row of trace.slice(-160)) {
        // One event per line keeps the causal order readable after a failure.
        t.diagnostic(`Refresh transaction: ${JSON.stringify(row)}`);
      }
    }
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); }
    await new Promise(done => { if (browser.exitCode !== null) done(); else browser.once('exit', done); });
    await new Promise(done => hosted.server.close(done));
    t.diagnostic(`Cleanup: owned declaration browser exited=${browser.exitCode !== null}; server closed=${!hosted.server.listening}; profile retained=${profile}`);
  }
});

test('hero hard-refresh firstpaint', { timeout: 120000 }, async (t) => {
  await access(temporary);
  await access(browserPath);
  const hosted = await staticServer();
  const profile = await mkdtemp(join(temporary, 'chiledao-loading-profile-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', '--no-proxy-server', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let cdp;
  let hold = true;
  let abort = false;
  const paused = [];
  try {
    const port = await until(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned loading browser port', 15000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(value => value.type === 'page' && value.url === 'about:blank');
    cdp = await connect(target.webSocketDebuggerUrl);
    cdp.on('Fetch.requestPaused', async ({ requestId, request, resourceType }) => {
      if (new URL(request.url).origin !== hosted.origin) {
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } else if (resourceType === 'Script' && abort) {
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } else if (resourceType === 'Script' && hold) paused.push(requestId);
      else await cdp.send('Fetch.continueRequest', { requestId });
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__loadingDocument=crypto.randomUUID();window.__heroShifts=[];window.__heroType=[];window.__heroFontEvents=[];
      window.__rootWidths=[];
      const fontEvent=e=>window.__heroFontEvents.push({event:e.type,time:performance.now(),faces:[...(e.fontfaces??[])].map(f=>({family:f.family,weight:f.weight,status:f.status}))});
      document.fonts.addEventListener('loading',fontEvent);document.fonts.addEventListener('loadingdone',fontEvent);
      const shiftRect=r=>({x:r.x,y:r.y,w:r.width,h:r.height});
      const typography=()=>{
        const root=document.documentElement;
        if(root){const row={time:performance.now(),ready:document.readyState,inner:innerWidth,client:root.clientWidth,scrollHeight:root.scrollHeight,clientHeight:root.clientHeight,body:document.body?.getBoundingClientRect().width??null,sections:document.querySelectorAll('main>section').length,gutter:getComputedStyle(root).scrollbarGutter};
          const signature=JSON.stringify([row.ready,row.inner,row.client,row.scrollHeight,row.body,row.sections]);
          if(signature!==window.__rootWidthSignature&&window.__rootWidths.length<32){window.__rootWidthSignature=signature;window.__rootWidths.push(row);}}
        const h=document.querySelector('[data-hero-intro] h1');
        if(h){
          const s=getComputedStyle(h),words=[...h.querySelectorAll('[data-hero-word]')];
          const state={phase:document.querySelector('[data-works-showcase]')?.dataset.heroEntrance??null,
            family:s.fontFamily,size:s.fontSize,weight:s.fontWeight,lineHeight:s.lineHeight,
             class:h.className,inline:h.getAttribute('style'),heading:shiftRect(h.getBoundingClientRect()),
             copy:[document.querySelector('[data-hero-intro] > p:first-child'),document.querySelector('[data-hero-intro] a[href="#formacion"]')].filter(Boolean).map(e=>{const c=getComputedStyle(e);return {tag:e.tagName,text:e.textContent.trim(),family:c.fontFamily,weight:c.fontWeight,size:c.fontSize,lineHeight:c.lineHeight,style:c.fontStyle,class:e.className,inline:e.getAttribute('style'),rect:shiftRect(e.getBoundingClientRect()),parent:shiftRect(e.parentElement.getBoundingClientRect())};}),
            words:words.map(w=>({text:w.textContent,rect:shiftRect(w.getBoundingClientRect())})),
            fonts:{status:document.fonts.status,check:document.fonts.check(s.fontWeight+' '+s.fontSize+' Sora'),
               faces:[...document.fonts].filter(f=>['Sora','Inter','Geist Mono'].includes(f.family.replaceAll('"',''))&&f.status!=='unloaded').map(f=>({family:f.family,weight:f.weight,status:f.status,display:f.display}))},
            styles:[...document.querySelectorAll('link[rel="stylesheet"]')].map(l=>({href:l.href,loaded:!!l.sheet})),
            token:s.getPropertyValue('--font-heading')};
           const signature=JSON.stringify({...state,copy:state.copy.map(c=>({...c,rect:{w:c.rect.w,h:c.rect.h},parent:{w:c.parent.w,h:c.parent.h}})),words:state.words.map(w=>({text:w.text,w:w.rect.w,h:w.rect.h}))});
           if(signature!==window.__heroTypeSignature){window.__heroTypeSignature=signature;window.__heroType.push({time:performance.now(),...state});}
        }
        if(performance.now()<3000)requestAnimationFrame(typography);
      };requestAnimationFrame(typography);
      new PerformanceObserver(list=>{
        for(const entry of list.getEntries()) {
          if(entry.hadRecentInput || !entry.sources.some(s=>(s.node?.nodeType===1?s.node:s.node?.parentElement)?.closest?.('#inicio')))continue;
          window.__heroShifts.push({score:entry.value,time:entry.startTime,
            entrance:document.querySelector('[data-works-showcase]')?.dataset.heroEntrance,
            sources:entry.sources.map(s=>{
              const node=s.node,element=node?.nodeType===1?node:node?.parentElement;
              return {node:element?{tag:element.tagName,id:element.id,class:element.className,
                owner:element.closest('[data-work-card]')?.dataset.workCard,
                 intro:!!element.closest('[data-hero-intro]'),connected:element.isConnected,text:element.textContent}:null,
                previous:shiftRect(s.previousRect),current:shiftRect(s.currentRect),
                transform:element?getComputedStyle(element).transform:null,
                animations:element?element.getAnimations().map(a=>({name:a.animationName??null,state:a.playState})):[]};
            })});
        }
      }).observe({type:'layout-shift',buffered:true});
    ` });
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Target.activateTarget', { targetId: target.id });
    await cdp.send('Page.bringToFront');
    const evaluate = async expression => {
      const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const geometry = () => evaluate(`(() => {
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
      const root=document.querySelector('[data-works-showcase]');
        return {hero:rect(document.querySelector('#inicio')),header:rect(document.querySelector('header')),intro:rect(root.querySelector('[data-hero-intro]')),h1:root.querySelector('h1').textContent,headings:root.querySelectorAll('h1').length,faces:[...root.querySelectorAll('[data-work-face]')].map(rect),photos:[...root.querySelectorAll('[data-hero-photo]')].map(p=>({alpha:Number(getComputedStyle(p).opacity),transform:getComputedStyle(p).transform})),images:[...root.querySelectorAll('[data-work-face] img')].map(i=>({alt:i.alt,decoded:i.complete&&i.naturalWidth>0})),fallback:!!root.querySelector('[data-works-fallback]'),height:innerHeight,entrance:root.dataset.heroEntrance,
          scroll:scrollY,menuHeight:document.querySelector('#mobile-menu').getBoundingClientRect().height};
    })()`);
    const fontRequests = async label => {
      const rows = await evaluate(`(() => {
        const first=window.__heroType[0]?.time;
        return [...document.querySelectorAll('link[rel="preload"][as="font"]')].map(link=>({
          url:link.href,firstTypography:first,resources:performance.getEntriesByName(link.href).map(r=>({
            start:r.startTime,end:r.responseEnd,initiator:r.initiatorType,transfer:r.transferSize}))}));
      })()`);
      assert.equal(rows.length, 5);
      for (const row of rows) {
        assert.equal(row.resources.length, 1, `preload/CSS request reused: ${JSON.stringify(row)}`);
        assert.equal(row.resources[0].initiator, 'link');
        assert.ok(row.resources[0].start < row.firstTypography, 'parser preload precedes observed CSS typography use');
        t.diagnostic(`font preload ${label}: ${JSON.stringify(row)}`);
      }
      assert.equal(await evaluate('window.__heroShifts.reduce((sum,e)=>sum+e.score,0)'), 0, `${label}: strict hero CLS`);
    };
    const navigationTrace = async label => {
      t.diagnostic(`loading navigation ${label}: ${JSON.stringify({history:await cdp.send('Page.getNavigationHistory'),state:await evaluate(`({epoch:window.__loadingDocument??null,url:location.href,scroll:[scrollX,scrollY],active:document.activeElement?.outerHTML?.slice(0,200),viewport:[innerWidth,innerHeight],hero:(()=>{const r=document.querySelector('#inicio')?.getBoundingClientRect();return r?{y:r.y,h:r.height,documentY:r.y+scrollY}:null})(),navigation:performance.getEntriesByType('navigation').map(e=>({type:e.type,start:e.startTime}))})`)})}`);
    };
    const capture = async name => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = `${profile}-${name}.png`;
      await writeFile(path, Buffer.from(data, 'base64'));
      t.diagnostic(`capture: ${path}`);
    };
    const assertRing = (value, nativeMenu = false) => {
      assert.equal(value.fallback, false, `no giant vertical fallback: ${JSON.stringify(value)}`);
      assert.equal(value.headings, 1);
       assert.equal(value.faces.length, 8);
        assert.ok(value.photos.every(p=>p.alpha>=0&&p.alpha<=1&&p.transform==='none'), 'static photo layers retain independent readiness');
      // No-JS mobile navigation now occupies real flow space. Keep the original
      // ring dimensions and alignment in document coordinates; reload anchoring
      // may preserve the hero's former viewport position beneath the taller header.
      const menuHeight = nativeMenu ? value.menuHeight : 0;
      const scroll = nativeMenu ? value.scroll : 0;
      assert.ok(Math.abs(value.hero.bottom + scroll - value.height - menuHeight) < 2, JSON.stringify(value));
      assert.ok(Math.abs(value.hero.y + scroll - (nativeMenu ? value.header.h : value.header.bottom)) < 2);
      assert.ok(Math.abs(value.intro.y + value.intro.h / 2 - (value.hero.y + value.hero.h / 2)) < 2);
      for (const face of value.faces) {
        assert.ok(face.w > 20 && face.w < 220 && face.h > 20 && face.h < 220, JSON.stringify(face));
        assert.ok(face.x >= -1 && face.right <= value.hero.right + 1
          && face.y >= (nativeMenu ? value.hero.y : value.header.bottom) - 1
          && face.bottom <= value.hero.bottom + 1, JSON.stringify(face));
        assert.equal(face.x < value.intro.right && face.right > value.intro.x && face.y < value.intro.bottom && face.bottom > value.intro.y, false, JSON.stringify(value));
      }
    };
    for (const width of [1440, 390, 320]) {
      await navigationTrace(`before viewport ${width}`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 900 : 844, deviceScaleFactor: 1, mobile: width < 600 });
      await navigationTrace(`after viewport ${width}`);
      hold = true;
      await cdp.send('Page.navigate', { url: hosted.origin });
      await until(() => evaluate(`!!document.querySelector('[data-works-showcase]') && !!document.querySelector('link[rel="stylesheet"]')?.sheet`), 'SSR styled before client modules');
      await evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
      await until(() => evaluate(`[...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1')`), 'photo fade finishes while real modules are still held');
      const before = await geometry();
      const design = await evaluate(`(() => {
        const root=document.documentElement,hero=document.querySelector('#inicio'),h=document.querySelector('h1');
        const style=e=>{const s=getComputedStyle(e);return {family:s.fontFamily,weight:s.fontWeight,size:s.fontSize,color:s.color,background:s.backgroundColor}};
        return {viewport:innerWidth,client:root.clientWidth,baseFont:parseFloat(getComputedStyle(root).fontSize),headingClass:h.className,gutter:getComputedStyle(root).scrollbarGutter,body:document.body.getBoundingClientRect().width,hero:hero.getBoundingClientRect().width,stage:hero.querySelector('[data-works-stage]').getBoundingClientRect().width,heading:style(h),eyebrow:style(hero.querySelector('[data-hero-reveal]')),cta:style(hero.querySelector('a[href="#formacion"]')),header:style(document.querySelector('header'))};
      })()`);
      t.diagnostic(`gutter final design ${width}: ${JSON.stringify(design)}`);
      await capture(`${width}-gutter-design`);
      assert.equal(design.gutter, 'stable');
      const clamp = design.headingClass.match(/text-\[clamp\(([\d.]+)rem,([\d.]+)vw,([\d.]+)rem\)\]/);
      assert.ok(clamp, 'the unchanged declared responsive clamp is present');
      const expectedFont = Math.min(Number(clamp[3])*design.baseFont,
        Math.max(Number(clamp[1])*design.baseFont, Number(clamp[2])*design.client/100));
      assert.equal(Number.parseFloat(design.heading.size), expectedFont, 'declared clamp uses the accepted native available viewport');
      assert.equal(design.heading.weight, '700');
      assert.equal(design.heading.color, 'rgb(248, 246, 238)');
      assert.match(design.heading.family, /^Sora,/);
      assert.equal(design.eyebrow.weight, '400');
      assert.equal(design.cta.weight, '600');
      assert.equal(design.cta.background, 'rgb(200, 23, 42)');
      assert.equal(design.hero, width===1440?1425:width, 'original final classic/mobile hero width');
      assert.equal(design.body, design.hero); assert.equal(design.stage, design.hero);
      assert.ok(paused.length > 0, 'actual client requests held before hydration');
      t.diagnostic(`delayed modules ${width}: ${JSON.stringify(before)}; paused=${paused.length}`);
      await capture(`${width}-before-hydration`);
      assertRing(before);
      hold = false;
      for (const requestId of paused.splice(0)) await cdp.send('Fetch.continueRequest', { requestId });
      await until(() => evaluate(`document.querySelector('[data-works-stage]')?.dataset.draws`), 'hydrated geometry');
      t.diagnostic(`hydrated ${width}: ${JSON.stringify(await geometry())}`);
      await capture(`${width}-hydrated`);
      await until(() => evaluate(`document.querySelector('[data-works-showcase]').dataset.heroEntrance==='complete'`), 'entrance completion');
      const after = await geometry();
      assertRing(after);
      for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(before.intro[key] - after.intro[key]) < 2, `intro ${key} reflow: ${JSON.stringify({before,after})}`);
      for (let i=0;i<8;i++) for (const key of ['x','y','w','h']) assert.ok(Math.abs(before.faces[i][key]-after.faces[i][key])<2, `card ${i} ${key} reflow: ${JSON.stringify({before:before.faces[i],after:after.faces[i]})}`);
      const shifts = await evaluate('window.__heroShifts');
      for(const row of await evaluate('window.__rootWidths'))t.diagnostic(`root width ${width}: ${JSON.stringify(row)}`);
      for (const row of await evaluate('window.__heroFontEvents')) t.diagnostic(`font loading ${width}: ${JSON.stringify(row)}`);
      for (const sample of await evaluate('window.__heroType')) t.diagnostic(`typography ${width}: ${JSON.stringify(sample)}`);
      t.diagnostic(`style/font resources ${width}: ${JSON.stringify(await evaluate(`performance.getEntriesByType('resource').filter(r=>/\\.(css|woff2)(\\?|$)/.test(r.name)).map(r=>({name:r.name,start:r.startTime,end:r.responseEnd}))`))}`);
      t.diagnostic(`hero shift entries ${width}: ${JSON.stringify(shifts)}`);
      const heroCLS = shifts.reduce((sum, entry) => sum + entry.score, 0);
      // Keep the strict ceiling until a nonzero entry's actual source rectangles
      // justify a bounded precision allowance; endpoint boxes alone cannot do so.
      assert.equal(heroCLS, 0, `no hero-owned layout shifts: ${JSON.stringify(shifts)}`);
      await fontRequests(`${width} cold`);
      t.diagnostic(`stable ${width}: intro/card deltas <2px; hero-owned CLS=${heroCLS}; after=${JSON.stringify(after)}`);
      assert.equal(after.h1, before.h1);
      assert.ok(after.images.every(i=>i.decoded&&i.alt));
      await capture(`${width}-after-entrance`);
      let documentId = await evaluate('window.__loadingDocument');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until(() => evaluate(`window.__loadingDocument!==${JSON.stringify(documentId)} && !!document.querySelector('[data-works-showcase]')`), 'new hard refresh document');
      await until(() => evaluate(`document.querySelector('[data-works-showcase]')?.dataset.heroEntrance==='complete'`), 'cache-disabled hard refresh');
      assertRing(await geometry());
      await fontRequests(`${width} hard refresh`);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
      documentId = await evaluate('window.__loadingDocument');
      await cdp.send('Page.reload', { ignoreCache: false });
      await until(() => evaluate(`window.__loadingDocument!==${JSON.stringify(documentId)} && document.querySelector('[data-works-showcase]')?.dataset.heroEntrance==='complete'`), 'new cached reload document');
      assertRing(await geometry());
      await fontRequests(`${width} cached reload`);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      abort = true;
      documentId = await evaluate('window.__loadingDocument');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until(() => evaluate(`window.__loadingDocument!==${JSON.stringify(documentId)} && !!document.querySelector('[data-works-showcase]')`), 'new failed-script document');
       await until(() => evaluate(`document.readyState==='complete'`), 'aborted modules fallback');
       await until(() => evaluate(`[...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1')`), 'CSS-only fade completes with aborted scripts');
      assertRing(await geometry());
      await fontRequests(`${width} aborted scripts`);
      assert.equal(await evaluate(`document.querySelector('[data-hero-intro] a').getAttribute('href')`), '#formacion');
      await capture(`${width}-aborted-scripts`);
      abort = false;
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
      await navigationTrace(`${width} before disabled reload`);
      await cdp.send('Page.reload', { ignoreCache: true });
       await until(() => evaluate(`document.readyState==='complete' && !document.querySelector('[data-works-stage]')?.dataset.draws`), 'permanent script-disabled shell');
       await until(() => evaluate(`[...document.querySelectorAll('[data-hero-photo]')].every(p=>getComputedStyle(p).opacity==='1')`), 'CSS-only fade completes without JavaScript');
      await navigationTrace(`${width} after disabled reload`);
       assertRing(await geometry(), true);
      assert.equal(await evaluate(`document.querySelectorAll('[data-hero-photo][href]').length`), 8, 'native real artwork access without scripts');
      await capture(`${width}-no-js`);
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
    }
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.close();
    }
    await new Promise(done => { if (browser.exitCode !== null) done(); else browser.once('exit', done); });
    await new Promise(done => hosted.server.close(done));
    // Profiles and captures stay in the approved evidence directory; no ambient browser state is touched.
  }
});

test('real browser verifies supplied works wheel, synchronized details and progressive fallback', { timeout: 120000 }, async (t) => {
  // This runner owns only this server, child process, profile and screenshot paths.
  await access(temporary);
  await access(browserPath);
  let server;
  let browser;
  let profile;
  let cdp;
  let browserClosed = false;
  const screenshots = [];
  const requests = { local: 0, blocked: [] };
  let failScripts = false;
  let failEntranceImports = false;
  let blockedEntranceImports = 0;
  let navigationReceipt;
  const entranceFaults = [];
  const scriptRequests = new Map();
  try {
    const hosted = await staticServer();
    server = hosted.server;
    const { origin } = hosted;
    assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 403, 'traversal rejected');
    profile = await mkdtemp(join(temporary, 'chiledao-carousel-profile-'));
    browser = spawn(browserPath, [
      '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-default-apps', '--disable-extensions', '--disable-domain-reliability',
      '--metrics-recording-only', '--no-proxy-server', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let startupError;
    browser.on('error', (error) => { startupError = error; });
    browser.once('exit', () => { browserClosed = true; });
    let stderr = '';
    browser.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const port = await until(async () => {
      if (startupError) throw startupError;
      if (browserClosed) throw new Error(`Owned browser exited during startup: ${stderr}`);
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { return false; }
    }, 'owned browser debugging port', 15000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank');
    assert.ok(page, 'fresh about:blank target');
    cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on('Network.requestWillBeSent', ({ requestId, loaderId, frameId, type }) => {
      if (type === 'Script') scriptRequests.set(requestId, { loaderId, frameId });
    });
    cdp.on('Fetch.requestPaused', async ({ requestId, request, resourceType, frameId, networkId }) => {
      const url = new URL(request.url);
      const allowed = url.origin === origin || url.protocol === 'data:'
        || (url.protocol === 'blob:' && request.url.startsWith(`blob:${origin}/`));
      if (allowed) {
        requests.local += 1;
        if ((failScripts || (failEntranceImports && /SplitText/.test(url.pathname))) && resourceType === 'Script') {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          if (failEntranceImports) {
            blockedEntranceImports += 1;
            entranceFaults.push({ requestId, networkId, frameId, url:request.url, acknowledged:true });
          }
        } else await cdp.send('Fetch.continueRequest', { requestId });
      } else {
        requests.blocked.push(request.url);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    });
    // Interception is installed before any page navigation, not merely launch flags.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: nativeWheelReceiptSource('__pointerReceipt') });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__lateHero={id:crypto.randomUUID(),rows:[],events:[]};
      for(const event of ['scroll','resize','focus','blur','pageshow'])window.addEventListener(event,e=>{
        if(window.__lateHero.events.length<24)window.__lateHero.events.push({event,time:performance.now(),trusted:e.isTrusted,y:scrollY,viewport:[innerWidth,innerHeight],photos:[...document.querySelectorAll('[data-hero-photo]')].map(p=>p.dataset.photoReady)});
      },{passive:true});
      const sample=()=>{
        const root=document.querySelector('[data-works-showcase]');
        if(root){
          const pose=selector=>[...root.querySelectorAll(selector)].map(e=>({alpha:Number(getComputedStyle(e).opacity),effects:e.getAnimations().map(a=>({name:a.animationName??null,state:a.playState,start:a.startTime,current:a.currentTime,duration:a.effect.getTiming().duration}))}));
          const row={time:performance.now(),ready:document.readyState,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden,focus:document.hasFocus(),y:scrollY,phase:root.dataset.heroEntrance??null,starts:root.dataset.heroEntranceStarts??null,draws:root.querySelector('[data-works-stage]')?.dataset.draws??null,words:pose('[data-hero-word],.hero-entrance-word'),photos:pose('[data-hero-photo]')};
          const signature=JSON.stringify([row.ready,row.reduced,row.hidden,row.phase,row.starts,row.words.map(w=>w.alpha<1),row.photos.map(p=>p.alpha<1)]);
          if(signature!==window.__lateHero.signature&&window.__lateHero.rows.length<24){window.__lateHero.signature=signature;window.__lateHero.rows.push(row);}
        }
        if(performance.now()<3000)requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    ` });
    const runtimeErrors = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => runtimeErrors.push(exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') runtimeErrors.push(args.map(value => value.value ?? value.description).join(' '));
    });
    const evaluate = async (expression) => {
      const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const resize = async (width, mobile = false) => {
      const hydrated = await evaluate(`document.querySelector('[data-works-stage]')?.getAttribute('role')==='listbox'`);
      let before;
      if (hydrated) {
        await evaluate(`window.__publicationOwner=document.querySelector('[data-works-stage]'); true`);
        before=await publicationReceipt();
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 1 });
      if (hydrated) await publishedGeometry(width, mobile ? 844 : 900, false, before);
    };
    // Independent receipt of the CSS publication contract in works-wheel.tsx.
    // ResizeObserver -> React metrics -> owned RAF must publish CURRENT inputs;
    // neither a zero turn nor CSS recentering proves that boundary was crossed.
    const publicationReceipt = () => evaluate(`(() => {
      const stage=document.querySelector('[data-works-stage]'),overlay=document.querySelector('[data-hero-overlay]');
      const cards=[...stage.querySelectorAll('[data-work-card]')],wheel=cards[0].parentElement;
      const rect=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
      const w=stage.clientWidth,h=stage.clientHeight,iw=overlay.offsetWidth,ih=overlay.offsetHeight;
      const details=document.querySelector('[data-details-overlay]').offsetHeight;
      const active=cards.findIndex(card=>card.getAttribute('aria-selected')==='true');
      const turn=Number(stage.dataset.turn),m=Math.min(1,Math.max(0,turn)),pos=Math.max(0,turn-1);
      const mix=(a,b)=>a+(b-a)*m,rad=angle=>angle*Math.PI/180;
      const cardW=Math.min(h*.38*1.45,w*(w<600 ? .65 : .34),360),cardH=cardW/1.45;
      const viewerH=w>=900?h*.78:Math.max(120,h-details-48),viewerW=w>=900?w*.58:w*.88;
      const sizes=cards.map(card=>{const img=card.querySelector('img'),ratio=Number(img.getAttribute('width'))/Number(img.getAttribute('height'));
        const height=Math.min(viewerH,viewerW/ratio);return {w:height*ratio,h:height};});
      const drumR=(sizes[active]?.h??cardH)*2.22,bow=cardH*1.82;
      const faceW=Math.min(w<600?74:150,Math.max(50,(w-iw)/4)),scale=faceW/(cardW||1);
      const ringX=Math.max(iw/2+faceW/2+12,w/2-faceW*.55-12);
      const ringR=Math.max(cardH*1.14,ih/2+faceW*.6+24,h/2-faceW*.6-12);
      // Let the browser serialize expected inline CSS with the same precision as
      // published CSS, without attaching or changing any application element.
      const css=document.createElement('div').style;
      const canonical=(property,value)=>{css[property]=value;return css[property];};
      const rows=cards.map((card,i)=>{
        const d=i-pos,angle=d*(360/cards.length),drumAngle=d*40;
        const x=Math.sign(Math.sin(rad(angle)))*Math.abs(Math.sin(rad(angle)))**.5*ringX;
        const y=-Math.sign(Math.cos(rad(angle)))*Math.abs(Math.cos(rad(angle)))**(w<360 ? .2 : .5)*ringR;
        const cx=x-Math.sin(rad(angle))*ringR,cy=y+Math.cos(rad(angle))*ringR;
        const width=mix(cardW,sizes[i].w),height=mix(cardH,sizes[i].h);
        const transform='translate('+((1-m)*cx)+'px,'+((1-m)*cy)+'px) '
          +'translateX('+(m*(-bow*(1-Math.cos(rad(drumAngle)))))+'px)'
          +' rotateZ('+((1-m)*angle)+'deg) translateY('+(-(1-m)*ringR)+'px)'
          +' rotateX('+(m*drumAngle)+'deg) translateZ('+(m*drumR)+'px)';
        const expected={width:canonical('width',width+'px'),height:canonical('height',height+'px'),
          marginLeft:canonical('marginLeft',-width/2+'px'),marginTop:canonical('marginTop',-height/2+'px'),
          transform:canonical('transform',transform),scale:canonical('transform','scale('+mix(scale,1)+')')};
        const actual={width:card.style.width,height:card.style.height,marginLeft:card.style.marginLeft,
          marginTop:card.style.marginTop,transform:card.style.transform,scale:card.firstElementChild.style.transform};
        return {index:i,actual,expected,match:JSON.stringify(actual)===JSON.stringify(expected),face:rect(card.firstElementChild)};
      });
      const expectedWheel={transform:canonical('transform','translateZ('+(-m*drumR)+'px)'),
        top:canonical('top',mix(h/2,w>=900?h/2:viewerH/2+16)+'px'),left:canonical('left',mix(50,w>=900?34:50)+'%')};
      const actualWheel={transform:wheel.style.transform,top:wheel.style.top,left:wheel.style.left};
      return {epoch:performance.timeOrigin,owner:stage.id,ownerStable:!window.__publicationOwner||stage===window.__publicationOwner,
        connected:stage.isConnected&&overlay.isConnected,viewport:[innerWidth,innerHeight],inputs:{w,h,iw,ih,details,active,narrow:w<360},
        turn,draws:Number(stage.dataset.draws),stage:rect(stage),intro:rect(document.querySelector('[data-hero-intro]')),
        metrics:{cardW,cardH,faceW,scale,ringX,ringR},wheel:{actual:actualWheel,expected:expectedWheel},cards:rows,
        matches:cards.length===8&&w>0&&h>0&&rows.every(row=>row.match)&&JSON.stringify(actualWheel)===JSON.stringify(expectedWheel)};
    })()`);
    const publicationDiagnostic = (label, value) => {
      if (!value) return;
      const {cards,...scalars}=value;
      t.diagnostic(`geometry publication ${label}: ${JSON.stringify(scalars)}`);
      for (const {index,actual,expected,match,face} of cards) {
        t.diagnostic(`geometry publication ${label} card ${index}: ${JSON.stringify({actual,match,face,...(!match?{expected}:{})})}`);
      }
    };
    const publishedGeometry = async (width, height, ring = false, resizeBefore) => {
      if (!resizeBefore) await evaluate(`window.__publicationOwner=document.querySelector('[data-works-stage]'); true`);
      const before=resizeBefore??await publicationReceipt();
      const label=`${width}x${height} ring=${ring}`;
      publicationDiagnostic(`${label} before`,before);
      let previous,latest,pair;
      // This is a bounded publication wait, not an overlap predicate or a sleep.
      const signature=value=>JSON.stringify({...value,draws:undefined});
      try {
        pair=await until(async () => {
          latest=await publicationReceipt();
          const eligible=latest.epoch===before.epoch&&latest.owner===before.owner&&latest.ownerStable&&latest.connected
            &&latest.viewport[0]===width&&latest.viewport[1]===height&&latest.matches&&(!ring||latest.turn===0);
          const stable=eligible&&previous&&signature(previous)===signature(latest);
          const first=previous;
          previous=eligible?latest:undefined;
          return stable&&{first,second:latest};
        }, 'all eight current-input CSS publications and same-owner stable pair');
      } finally {
        if (pair) {
          const {cards,...first}=pair.first;
          t.diagnostic(`geometry publication ${label} stable first: ${JSON.stringify(first)}`);
        }
        publicationDiagnostic(`${label} after`,latest);
      }
      return pair.second;
    };
    const navigate = async () => {
      const previous = (await cdp.send('Page.getFrameTree')).frameTree.frame;
      const previousEpoch = await evaluate('window.__lateHero?.id??null');
      const navigation = await cdp.send('Page.navigate', { url: origin });
      assert.equal(navigation.errorText, undefined, 'native navigation succeeds');
      assert.ok(navigation.loaderId && navigation.loaderId !== previous.loaderId, 'navigation starts a fresh native document loader');
      navigationReceipt = { previousLoader:previous.loaderId, loader:navigation.loaderId, frame:navigation.frameId, previousEpoch };
      await until(async () => {
        const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame;
        return frame.id === navigation.frameId && frame.loaderId === navigation.loaderId
          && await evaluate(`document.readyState==='complete' && document.querySelectorAll('[data-formation-polaroid]').length===1
            && document.querySelector('[data-formation-polaroid]').isConnected && document.querySelector('[data-works-stage]')?.isConnected`);
      }, 'fresh native document and connected current owners ready');
      const epoch = await evaluate('window.__lateHero?.id??null');
      if (epoch) assert.notEqual(epoch, previousEpoch, 'available JS document epoch is fresh');
      navigationReceipt = { ...navigationReceipt, epoch };
      t.diagnostic(`fresh navigation: ${JSON.stringify(navigationReceipt)}`);
      return navigationReceipt;
    };
    const formation = '#formacion [data-formation-polaroid]';
    const state = (selector) => evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const viewport = root.querySelector('.pl-root') || root.querySelector('[data-polaroid-fallback]');
      const figures = [...viewport.querySelectorAll('figure')];
      const native = !viewport.matches('.pl-root');
      const index = native ? figures.reduce((best, slide, index) => Math.abs(slide.offsetLeft - figures[0].offsetLeft - viewport.scrollLeft) < Math.abs(figures[best].offsetLeft - figures[0].offsetLeft - viewport.scrollLeft) ? index : best, 0) : Number(viewport.dataset.active);
      return {
        index, left: native ? viewport.scrollLeft : Number(viewport.dataset.offset),
        width: native ? viewport.clientWidth : parseFloat(getComputedStyle(viewport).getPropertyValue('--pl-cw')) * 1.08,
        viewportWidth: viewport.getBoundingClientRect().width,
        paintedWidth: native ? viewport.getBoundingClientRect().width : Number(viewport.querySelector('path').getAttribute('d')?.match(/[0-9.]+/g)?.at(-2)),
        previous: native ? true : root.querySelector('.pl-prev').disabled,
        next: native ? false : root.querySelector('.pl-next').disabled,
        current: index,
        status: native ? '' : root.querySelector('.pl-sr').textContent,
        hidden: native,
      };
    })()`);
    const selected = async (selector, index, count) => {
      // Owned animation deliberately sleeps offscreen; inspect only after the
      // real gallery enters the viewport, including after responsive resize.
      await center(`${selector} .pl-root`);
      const drawsBefore = await evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).querySelector('.pl-root').dataset.draws)`);
      await until(async () => {
        const value = await state(selector);
        const eligible = await evaluate(`(() => {
          const root=document.querySelector(${JSON.stringify(selector)}).querySelector('.pl-root'),r=root.getBoundingClientRect();
          const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
          const painted=reduced?root.dataset.reduced==='true'&&Number(root.dataset.draws)>0:Number(root.dataset.draws)>${drawsBefore};
          return root.isConnected&&!document.hidden&&r.bottom>0&&r.y<innerHeight&&r.right>0&&r.x<innerWidth&&painted;
        })()`);
        return eligible && value.index === index && value.current === index
          && Math.abs(value.left - index * value.width) < 2
          && Math.abs(value.paintedWidth - value.viewportWidth) < 2
          && value.status.startsWith(`Foto ${index + 1} de ${count}:`)
          && value.previous === (index === 0) && value.next === (index === count - 1);
      }, `settled ${selector} photo ${index + 1}`).catch(async error => {
        t.diagnostic(`unsettled selection: ${JSON.stringify({expected:index,state:await state(selector),metrics:await evaluate("(() => {const root=document.querySelector('.pl-root'),bar=root.querySelector('.pl-bar'),r=root.getBoundingClientRect();return {rect:{y:r.y,bottom:r.bottom,w:r.width},scroll:scrollY,velocity:root.dataset.velocity,draws:root.dataset.draws,cardWidth:getComputedStyle(root).getPropertyValue('--pl-cw'),barHeight:bar.offsetHeight,title:root.querySelector('.pl-title').textContent,caption:root.querySelector('.pl-sub').textContent,focus:document.activeElement.className,hidden:document.hidden}})()")})}`);
        throw error;
      });
      const value = await state(selector);
      assert.ok(value.status.startsWith(`Foto ${index + 1} de ${count}:`));
      assert.equal(value.previous, index === 0);
      assert.equal(value.next, index === count - 1);
      assert.equal(value.hidden, false);
    };
    const center = async (selector) => evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const box = element.getBoundingClientRect();
       return { x: box.x + box.width / 2, y: box.y + (${JSON.stringify(selector)} === '[data-works-stage]' ? box.height * .18 : box.height / 2) };
    })()`);
    const click = async (selector) => {
      const point = await center(selector);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
     const key = async (key, modifiers = 0) => {
       const codes = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, Tab: 9, Escape: 27, Enter: 13, ' ': 32 };
       const code = key === ' ' ? 'Space' : key;
       await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: codes[key], ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : key === ' ' ? { text:' ',unmodifiedText:' ' } : {}) });
       await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: codes[key] });
    };
    const swipe = async (selector) => {
      const point = await center(`${selector} .pl-root`);
      const width = (await state(selector)).width;
      const start = point.x + width * 0.35;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y: point.y }] });
      for (let step = 1; step <= 12; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start - width * 0.7 * step / 12, y: point.y }] });
        await delay(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const layout = async (width) => {
      const metrics = await evaluate(`({
        width: innerWidth, page: document.documentElement.scrollWidth,
        frames: [...document.querySelectorAll('.pl-shot')].map(element => {
          const box = element.getBoundingClientRect();
          const image = element.querySelector('img');
          return { width: box.width, height: box.height, fit: getComputedStyle(image).objectFit };
        })
      })`);
      assert.equal(metrics.width, width);
      assert.ok(metrics.page <= width, `no horizontal page overflow: ${JSON.stringify(metrics)}`);
      for (const frame of metrics.frames) {
        assert.ok(Math.abs(frame.width / frame.height - 1) < 0.01);
        assert.equal(frame.fit, 'contain');
      }
      t.diagnostic(`layout: viewport=${width}, page=${metrics.page}, six formation instant-print contain frames`);
    };
    const capture = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = join(temporary, `${profile.split(sep).at(-1)}-${name}.png`);
      await writeFile(path, Buffer.from(data, 'base64'));
      screenshots.push(path);
      t.diagnostic(`screenshot: ${path}`);
    };

    await resize(1440);
    await navigate();
    const entranceState = () => evaluate(`(() => {
      const root=document.querySelector('[data-works-showcase]'), heading=root.querySelector('h1');
      const poses=selector=>[...root.querySelectorAll(selector)].map(e=>({opacity:Number(getComputedStyle(e).opacity),transform:getComputedStyle(e).transform}));
      const photoOwners=[...root.querySelectorAll('[data-hero-photo]')].map(e=>({ready:e.dataset.photoReady,connected:e.isConnected,
        decoded:e.querySelector('img').complete&&e.querySelector('img').naturalWidth>0,
        opacityEffects:e.getAnimations().filter(a=>a.effect?.getKeyframes().some(frame=>'opacity' in frame)).map(a=>({state:a.playState,time:a.currentTime,duration:a.effect.getTiming().duration}))}));
      return {epoch:window.__lateHero?.id,state:root.dataset.heroEntrance,starts:root.dataset.heroEntranceStarts,words:poses('.hero-entrance-word'),photos:poses('[data-hero-photo]'),photoOwners,turn:Number(root.querySelector('[data-works-stage]')?.dataset.turn),headings:root.querySelectorAll('h1').length,text:heading.textContent,decoded:[...root.querySelectorAll('[data-hero-photo] img')].every(i=>i.complete&&i.naturalWidth>0),placements:[...root.querySelectorAll('[data-work-card]')].map(e=>({card:e.style.transform,face:e.firstElementChild.style.transform}))};
    })()`);
    const entranceRunning = async () => {
      const value = await until(async () => {
        const pose = await entranceState();
        return pose.state === 'running' && pose.words.some(w=>w.opacity>0&&w.opacity<1)
          && new Set(pose.words.map(w=>w.opacity)).size>1
           && pose.photos.some(p=>p.opacity<1) && pose;
        }, 'actual bounded word stagger and photo fade phase', 2000).catch(async error => {
          for(const row of await evaluate('window.__lateHero.rows'))t.diagnostic(`late hero pose: ${JSON.stringify(row)}`);
          throw error;
        });
      assert.equal(value.state, 'running');
      assert.equal(value.turn, 0); assert.equal(value.headings, 1); assert.equal(value.decoded, true);
      assert.equal(value.photos.length, 8); assert.ok(value.words.length >= 6);
      assert.ok(value.words.some(w=>w.opacity>0&&w.opacity<1), 'actual intermediate word reveal');
      assert.ok(value.photos.some(p=>p.opacity<1), 'actual intermediate photo reveal');
      assert.ok(new Set(value.words.map(w=>w.opacity)).size>1, 'actual word stagger');
       assert.ok(value.photos.every(p=>p.transform==='none'), 'photos fade without entrance transforms');
      t.diagnostic(`entrance intermediate: ${JSON.stringify(value)}`);
      for(const row of await evaluate('window.__lateHero.events'))t.diagnostic(`entrance native event: ${JSON.stringify(row)}`);
      return value;
    };
    const entranceComplete = async () => {
      await until(async () => (await entranceState()).state === 'complete', 'bounded hero entrance completion', 2000);
      const hookComplete = await entranceState();
      t.diagnostic(`hook completion/photo-owner boundary: ${JSON.stringify({epoch:hookComplete.epoch,state:hookComplete.state,photoOwners:hookComplete.photoOwners})}`);
      // The inline photo controller owns decode and its separate native playback.
      await until(async () => {
        const value = await entranceState();
        return value.epoch === hookComplete.epoch && value.photoOwners.length === 8
          && value.photoOwners.every(p=>p.connected&&p.ready==='complete'&&p.decoded&&p.opacityEffects.length===0);
      }, 'eight current photo owners complete with native opacity playback retired', 2000);
      const value=await entranceState();
      t.diagnostic(`photo-owner terminal receipt: ${JSON.stringify({epoch:value.epoch,state:value.state,photoOwners:value.photoOwners,photos:value.photos})}`);
      assert.equal(value.words.length, 0, 'SplitText restores original heading DOM');
      assert.equal(value.headings, 1);
      assert.equal(value.text, 'Aprende sobre Blockchain e Inteligencia Artificial');
      assert.ok(value.photos.every(p=>p.opacity===1&&p.transform==='none'), 'all owned inner poses restored');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('h1')).opacity==='1' && [...document.querySelectorAll('[data-hero-reveal]')].every(e=>getComputedStyle(e).opacity==='1'&&getComputedStyle(e).transform==='none')`), true);
      return value;
    };
    const startedAt=Date.now();
    const intermediate=await entranceRunning();
    await capture('desktop-entrance');
    const completed=await entranceComplete();
    assert.ok(Date.now()-startedAt<2000, 'entrance is not a prolonged splash');
    assert.deepEqual(completed.placements, intermediate.placements, 'GSAP never changes wheel-owned placements/scales');
    assert.equal(completed.turn, 0);
    t.diagnostic(`entrance completed after ${Date.now()-startedAt}ms; all eight inner poses and unsplit single H1 restored`);
    await until(() => evaluate(`document.querySelector('.pl-root') !== null`), 'enhancement mounted');
    await center('.pl-root');
    await until(() => evaluate(`document.querySelector('.pl-root')?.dataset.draws`), 'visible enhancement initialized');
    await until(() => evaluate(`document.querySelector('[data-works-stage]')?.clientWidth > 0`), 'wheel initialized');
    await selected(formation, 0, 6);
    const accessibility = await cdp.send('Accessibility.getFullAXTree');
    for (const name of ['Afiches de actividades', 'Encuentros de formación', 'Foto anterior', 'Foto siguiente']) {
      assert.ok(accessibility.nodes.some((node) => !node.ignored && node.name?.value === name), `accessible name: ${name}`);
    }
    await layout(1440);
    const heroGeometry = async () => {
      await evaluate(`scrollTo({top: 0, behavior: 'instant'})`);
      await until(() => evaluate(`Number(document.querySelector('[data-works-stage]').dataset.turn) === 0`), 'ring geometry settled');
      const viewport=await evaluate('[innerWidth,innerHeight]');
      await publishedGeometry(...viewport, true);
      const value = await evaluate(`(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom }; };
        return { viewport: {w:innerWidth,h:innerHeight}, header:rect(document.querySelector('header')),
          hero:rect(document.querySelector('#inicio')), stage:rect(document.querySelector('[data-works-stage]')),
          intro:rect(document.querySelector('[data-hero-intro]')), font:parseFloat(getComputedStyle(document.querySelector('h1')).fontSize),
          faces:[...document.querySelectorAll('[data-work-card] > span')].map(rect) };
      })()`);
      assert.ok(Math.abs(value.hero.y - value.header.bottom) < 2, JSON.stringify(value));
      assert.ok(Math.abs(value.hero.bottom - value.viewport.h) < 2, JSON.stringify(value));
      assert.ok(Math.abs(value.intro.x + value.intro.w / 2 - (value.stage.x + value.stage.w / 2)) < 2);
      assert.ok(Math.abs(value.intro.y + value.intro.h / 2 - (value.stage.y + value.stage.h / 2)) < 2);
      assert.ok(value.font >= 26);
      for (const face of value.faces) {
        assert.ok(face.x >= -1 && face.right <= value.viewport.w + 1 && face.y >= value.header.bottom - 1 && face.bottom <= value.stage.bottom + 1, `unclipped face: ${JSON.stringify(value)}`);
        const overlap = face.x < value.intro.right && face.right > value.intro.x && face.y < value.intro.bottom && face.bottom > value.intro.y;
        assert.equal(overlap, false, `face/intro overlap: ${JSON.stringify(value)}`);
      }
      t.diagnostic(`hero geometry: ${JSON.stringify(value)}`);
      const frames = await evaluate(`[...document.querySelectorAll('[data-work-card]')].map(card => [card, card.firstElementChild, card.querySelector('[data-hero-photo]'), card.querySelector('picture')].map(e => ({background:getComputedStyle(e).backgroundColor,shadow:getComputedStyle(e).boxShadow})))`);
      for (const layers of frames) for (const layer of layers) {
        assert.equal(layer.background, 'rgba(0, 0, 0, 0)', 'actual small-ring card/face/entrance/picture backgrounds transparent');
        assert.equal(layer.shadow, 'none', 'no rectangular frame shadow plate');
      }
      t.diagnostic(`ring computed frame layers: ${JSON.stringify(frames)}`);
    };
    const titles = ['Block Camp', 'Bootcamp Blockchain — Avalanche', 'Build Buddies', 'Open Web3 Meetup · Vol. 2', 'Cowork con ETHGlobal', 'IA y tecnologías disruptivas', 'sub0 · Builder Party Chile', 'Crypto Vendimia · Hackathon'];
    const categories = ['Formación', 'Bootcamp', 'Encuentro comunitario', 'Meetup', 'Cowork', 'Seminario', 'Encuentro', 'Hackathon'];
    const descriptions = [
      'Aprendizaje sobre Blockchain y Web3 para construir un proyecto.',
      'Bootcamp online de Blockchain, camino al Hackathon Web3 Chile. La inscripción del afiche pertenece al archivo; consulta próximas actividades.',
      'Encuentro en Santiago presentado en una gráfica con Chile DAO y Meta Pool.',
      'Encuentro sobre Web3 anunciado en el Parque Padre Hurtado.',
      'Propuesta de cowork en Santiago con ETHGlobal, Chile DAO y Tellus Cooperative.',
      'Seminario sobre innovación, negocios y futuro. Chile DAO aparece como panel invitado, no como organizador.',
      'Encuentro para builders anunciado como Builder Party Chile de sub0.',
      'Hackathon sobre aplicaciones, experimentación con IA y emprendimiento tecnológico.',
    ];
    const wheelState = () => evaluate(`(() => {
      const stage = document.querySelector('[data-works-stage]');
         const option = document.getElementById(stage.getAttribute('aria-activedescendant'));
      const details = document.querySelector('[data-product-details]');
      const image = option.querySelector('img');
      return { turn: Number(stage.dataset.turn), index: Number(option.dataset.workCard),
        selected: option.getAttribute('aria-selected'), title: details.querySelector('[data-work-title]').textContent,
        category: details.querySelector('[data-work-category]').textContent,
        description: details.querySelector('[data-work-description]').textContent,
        alt: image.alt, decoded: image.complete && image.naturalWidth > 0,
        fit: getComputedStyle(image).objectFit,
        transform: option.style.transform, perspective: stage.style.perspective };
    })()`);
    const wheelSelected = async (index, turn = index + 1) => {
      await until(async () => {
        const value = await wheelState();
        return value.index === index && value.title === titles[index] && Math.abs(value.turn - turn) < 0.001
          && value.decoded && value.transform.length > 0 && Number.parseFloat(value.perspective) > 0;
      }, `wheel activity ${index + 1}, turn ${turn}`);
      const value = await wheelState();
      assert.equal(value.category, categories[index]);
      assert.equal(value.selected, 'true');
      assert.equal(value.description, descriptions[index]);
      assert.equal(value.fit, 'contain');
      assert.match(value.alt, /Afiche/);
      assert.match(value.transform, /rotateZ.*translateY.*rotateX.*translateZ/);
      if (turn > 0) {
        assert.equal(await evaluate(`(() => {const link=document.querySelector('[data-hero-intro] a');link.focus();return document.activeElement!==link})()`), true, 'invisible intro link cannot receive focus');
        const geometry = await evaluate(`(() => {
          const stage=document.querySelector('[data-works-stage]');
          const face=document.getElementById(stage.getAttribute('aria-activedescendant')).firstElementChild.getBoundingClientRect();
          const details=document.querySelector('[data-product-details]').getBoundingClientRect();
          const hero=document.querySelector('#inicio').getBoundingClientRect();
           return {face:{x:face.x,right:face.right,y:face.y,bottom:face.bottom,h:face.height},details:{x:details.x,y:details.y,bottom:details.bottom},hero:{y:hero.y,bottom:hero.bottom,h:hero.height},width:innerWidth};
        })()`);
        if (geometry.width >= 900) {
          assert.ok(geometry.face.right < geometry.details.x, `desktop side metadata: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.face.h >= geometry.hero.h * .6, `substantially larger poster: ${JSON.stringify(geometry)}`);
        } else assert.ok(geometry.face.bottom <= geometry.details.y, `stacked metadata: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.face.y >= geometry.hero.y && geometry.face.bottom <= geometry.hero.bottom, 'complete contained artwork inside hero');
        assert.ok(geometry.details.y >= geometry.hero.y && geometry.details.bottom <= geometry.hero.bottom, 'details remain inside hero');
        t.diagnostic(`selected artwork geometry: ${JSON.stringify(geometry)}`);
      }
      return value;
    };
    await wheelSelected(0, 0);
    await resize(320, true);
    await delay(250);
    await evaluate(`scrollTo({top:0,behavior:'instant'})`);
    const absentHeroControls = async () => {
      assert.equal(await evaluate(`document.querySelectorAll('#inicio [data-work-index], #inicio [data-works-reset], #inicio a[title="Afiche de archivo; no es una convocatoria vigente."]').length`), 0, 'no extra hero controls in DOM');
      assert.equal(await evaluate(`document.querySelector('[data-works-stage]').clientHeight === document.querySelector('[data-works-wheel]').clientHeight`), true, 'zero footer reservation');
    };
    const home = async () => {
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
      await key('Home');
      await wheelSelected(0, 0);
    };
    await absentHeroControls();
    await heroGeometry();
    await capture('320-ring');
    for (const index of [0, 7]) {
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
      await key(index === 0 ? 'ArrowDown' : 'End');
      await wheelSelected(index);
      await evaluate(`scrollTo({top:0,behavior:'instant'})`);
      await absentHeroControls();
    }
    await evaluate(`scrollTo({top:0,behavior:'instant'})`);
    await absentHeroControls();
    await capture('320-selected-stack');
    await home();
    await resize(1440);
    await delay(250);
    await heroGeometry();
    const rest = await wheelState();
    await delay(200);
    const restingFrames = await evaluate(`document.querySelector('[data-works-stage]').dataset.draws`);
    await delay(800);
    assert.deepEqual(await wheelState(), rest, 'initial base ring never auto-turns');
    assert.equal(await evaluate(`document.querySelector('[data-works-stage]').dataset.draws`), restingFrames, 'no wheel idle draws despite GSAP ticker');
    await center('#inicio h1');
    await capture('desktop-ring');
    for (let index = 0; index < 8; index += 1) {
      await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
      await key('ArrowDown');
      await wheelSelected(index);
      assert.equal(await evaluate(`document.querySelector('[data-hero-overlay]').inert && getComputedStyle(document.querySelector('[data-hero-overlay]')).visibility === 'hidden'`), true, 'intro links inaccessible in drum');
    }
    // Geometry changes may alter layout only via separate details, never the H1.
    await capture('desktop-drum');
    await home();
    await click('[data-work-card="0"]');
    await wheelSelected(0, 1);
    await home();
    const ringPoint = await evaluate(`(() => {
      scrollTo({ top: 150, behavior: 'instant' });
      const box = document.querySelector('[data-works-stage]').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    const ringScroll = await evaluate('scrollY');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...ringPoint, deltaX: 0, deltaY: -160 });
    await until(() => evaluate(`scrollY < ${ringScroll} - 20`), 'base ring releases upward page scroll');
    await wheelSelected(0, 0);
    await center('[data-works-stage]');
    await evaluate(`document.querySelector('[data-works-stage]').focus()`);
    await key('ArrowDown');
    await wheelSelected(0, 1);
    await key('ArrowDown');
    await wheelSelected(1);
    await key('ArrowUp');
    await wheelSelected(0, 1);
    await key('End');
    await wheelSelected(7);
    const boundaryPoint = await center('[data-works-stage]');
    const beforeScroll = await evaluate('scrollY');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...boundaryPoint, deltaX: 0, deltaY: 160 });
    await until(() => evaluate(`scrollY > ${beforeScroll} + 20`), 'last boundary releases vertical page scroll');
    await wheelSelected(7);
    await evaluate(`document.querySelector('[data-works-stage]').focus()`);
    await key('Home');
    await wheelSelected(0, 0);
    const wheelPoint = await center('[data-works-stage]');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 1800 });
    await wheelSelected(1);
    const dragPoint = await center('[data-works-stage]');
    dragPoint.y += 130;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...dragPoint });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: dragPoint.x, y: dragPoint.y - 70 * step });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: dragPoint.x, y: dragPoint.y - 420 });
    await wheelSelected(2);
    await evaluate(`document.querySelector('[data-works-stage]').focus()`);
    await key('Home');
    await key('Tab');
    assert.equal(await evaluate(`document.activeElement.matches(':focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2`), true);
    const ids = await evaluate(`[...document.querySelectorAll('[id]')].map(element => element.id)`);
    assert.equal(new Set(ids).size, ids.length, 'unique aria IDs');
    assert.equal(await evaluate(`document.querySelectorAll('[data-work-card] a:not([tabindex="-1"]), [data-work-card] button').length`), 0, 'no focusable culled cards');
    await absentHeroControls();
    t.diagnostic('wheel: initial ring/idle stability, all eight real decoded posters/exact side details, card, wheel, drag, ArrowUp/Down, Home/End and boundary page scroll passed');

    await home();
    await evaluate(`document.querySelector('[data-hero-intro] a[href="#formacion"]').focus()`);
    await key('Enter');
    await until(() => evaluate(`location.hash === '#formacion'`), 'real keyboard formation CTA');
    await click('header nav a[href="#contacto"]');
    await until(() => evaluate(`location.hash === '#contacto'`), 'real pointer contact CTA');

    const timelineState = () => evaluate(`(() => {
      const root = document.querySelector('[data-timeline]');
      const canvas = root.querySelector('[data-timeline-canvas]');
      const track = root.querySelector('[data-timeline-track]');
      const rect = element => { const r=element.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; };
      const vertical=root.dataset.mode==='vertical';
      return { enhanced:root.dataset.enhanced, vertical, progress:Number(root.dataset.progress), triggers:Number(root.dataset.ownedTriggers || 0),
        splits:root.querySelectorAll('.timeline-split-line').length, root:rect(root), canvas:rect(canvas),
        header:rect(document.querySelector('header')), x:new DOMMatrix(getComputedStyle(track).transform).m41,
        line:new DOMMatrix(getComputedStyle(root.querySelector('[data-journey-line]')).transform)[vertical?'m22':'m11'],
        entries:[...root.querySelectorAll('[data-milestone]')].map(element => ({box:rect(element),title:element.querySelector('h3').textContent,
          font:parseFloat(getComputedStyle(element.querySelector('h3')).fontSize),
          dot:(() => {const dot=element.querySelector('[data-dot]'),r=dot.getBoundingClientRect();
            return {size:r.width,base:dot.offsetWidth,center:r.x+r.width/2,
              shadow:getComputedStyle(dot).boxShadow,reached:dot.hasAttribute('data-reached')};})(),
          content:rect(element.querySelector('.milestone-content')),
          lineOffsets:[...element.querySelectorAll('.timeline-split-line')].map(line=>new DOMMatrix(getComputedStyle(line).transform).m42),
          image:element.querySelector('img') ? {decoded:element.querySelector('img').complete && element.querySelector('img').naturalWidth>0,fit:getComputedStyle(element.querySelector('img')).objectFit} : null})) };
    })()`);
    const timelineAt = async (fraction, name) => {
      await until(() => evaluate(`document.querySelector('[data-timeline]').dataset.enhanced === 'true'`), 'GSAP successful activation');
      await evaluate(`(() => {
        const root=document.querySelector('[data-timeline]'), canvas=root.querySelector('[data-timeline-canvas]');
        const header=document.querySelector('header').getBoundingClientRect().height;
        const track=root.querySelector('[data-timeline-track]'),line=root.querySelector('[data-journey-line]');
        scrollTo({top:root.dataset.mode==='vertical'
          ? scrollY+track.getBoundingClientRect().top-innerHeight/2+line.offsetHeight*${fraction}
          : scrollY+root.getBoundingClientRect().top-header+(root.offsetHeight-canvas.offsetHeight)*${fraction},behavior:'instant'});
      })()`);
      await until(async () => Math.abs((await timelineState()).progress - fraction) < .006, 'ScrollTrigger refresh and measured progress');
      const value = await timelineState();
      if (value.vertical) {
        assert.equal(value.triggers, 1);
        assert.equal(value.splits, 0);
        assert.equal(value.x, 0);
        assert.equal(value.entries.filter(entry => entry.image?.decoded).length, 6);
        assert.ok(value.entries.every((entry,index,all)=>!index||entry.box.y>all[index-1].box.bottom), 'native vertical chronology');
        for (let index = 0; index < 7; index++) {
          await center(`[data-milestone="milestone-${index}"] h3`);
          assert.equal(await evaluate(`(() => {const r=document.querySelector('[data-milestone="milestone-${index}"] h3').getBoundingClientRect();
            return r.y>=document.querySelector('header').getBoundingClientRect().bottom&&r.bottom<=innerHeight;})()`), true, 'vertical heading reachable');
        }
        await capture(name);
        return value;
      }
      assert.ok(Math.abs(value.canvas.y - value.header.bottom) < 2, JSON.stringify(value));
      assert.ok(Math.abs(value.canvas.bottom - (await evaluate('innerHeight'))) < 2, JSON.stringify(value));
      assert.equal(value.triggers, 22);
      assert.ok(value.splits >= 14);
      assert.equal(value.entries.filter(entry => entry.image?.decoded).length, 6);
      for (const entry of value.entries) {
        assert.ok(entry.font >= 20);
        if (entry.image) assert.equal(entry.image.fit, 'contain');
        assert.ok(entry.content.y >= value.canvas.y && entry.content.bottom <= value.canvas.bottom, `readable content: ${JSON.stringify(value)}`);
        if (entry.box.x >= 0 && entry.box.right <= value.canvas.right) {
          assert.ok(entry.lineOffsets.every(offset=>Math.abs(offset)<1), 'fully visible milestone has revealed heading and text');
          const lineEnd = await evaluate(`document.querySelector('[data-journey-line]').getBoundingClientRect().right`);
          const reached = lineEnd >= entry.dot.center;
          assert.equal(entry.dot.reached, reached, 'visible milestone follows actual line arrival');
          assert.ok(Math.abs(entry.dot.size-entry.dot.base*(reached?1.75:1))<.1, 'dot size follows reached state');
          assert.equal(entry.dot.shadow==='none', !reached, 'dot glow follows reached state');
        }
      }
      if (fraction === 0) assert.ok(value.entries[0].box.x >= 0 && value.entries[0].box.right < value.canvas.right);
      if (fraction === 1) assert.ok(value.entries[6].box.x >= 0 && value.entries[6].box.right <= value.canvas.right);
      await capture(name);
      t.diagnostic(`timeline ${name}: progress=${value.progress}, trackX=${value.x}, lineScale=${value.line}, canvas=${JSON.stringify(value.canvas)}, triggers=${value.triggers}, splits=${value.splits}, six decoded media`);
      return value;
    };
    assert.equal(await evaluate(`document.querySelector('#inicio').nextElementSibling.id`), 'trayectoria');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-milestone] h3')].map(e=>e.textContent)`),
      ['BlockCamp', 'Workshop Polkadot', 'Avalanche Bootcamp', 'VendimiaTech', 'Dev3Pack', 'Blockchain Summit Latam', 'Próximo capítulo']);
    const timelineStart = await timelineAt(0, 'desktop-timeline-start');
    const timelineMiddle = await timelineAt(.5, 'desktop-timeline-middle');
    const timelineEnd = await timelineAt(1, 'desktop-timeline-end');
    assert.ok(timelineMiddle.x < timelineStart.x && timelineEnd.x < timelineMiddle.x);
    assert.ok(timelineEnd.line > timelineMiddle.line && timelineMiddle.line > timelineStart.line);
    const modalCases = async (width, native = false) => {
      await evaluate(`window.timelineFocusTrace??=[];if(!window.timelineFocusTraceInstalled){
        document.addEventListener('focusin',event=>timelineFocusTrace.push({time:performance.now(),id:event.target.getAttribute('data-timeline-image'),tag:event.target.tagName}));
        window.timelineFocusTraceInstalled=true;
      }`);
      for (let index = 0; index < 6; index += 1) {
        const selector = `[data-timeline-image="milestone-${index}"]`;
        const focusProbe = () => evaluate(`(() => {
          const e=document.querySelector('${selector}'),r=e.getBoundingClientRect(),root=e.closest('[data-timeline]'),track=root.querySelector('[data-timeline-track]');
          return {time:performance.now(),requested:e.dataset.timelineImage,active:document.activeElement?.getAttribute('data-timeline-image'),
            rect:{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom},progress:root.dataset.progress,
            transform:getComputedStyle(track).transform,scroll:{x:scrollX,y:scrollY,local:track.scrollLeft},events:timelineFocusTrace.length};
        })()`);
        const focusBefore = await focusProbe();
        // A previous lifecycle probe can leave this exact link active while
        // timelineAt moves the scene elsewhere. Refocus needs a real transition.
        await evaluate(`(() => {const link=document.querySelector('${selector}');
          if(document.activeElement===link)link.blur();link.focus({preventScroll:true});})()`);
          if (native) await center(selector);
        await delay(120);
        const thumb = await evaluate(`(() => {const e=document.querySelector('${selector}'),r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,href:e.href,scroll:scrollY,body:document.body.style.cssText,html:document.documentElement.style.cssText}})()`);
        const focusAfter = await focusProbe();
        const focusEvents = await evaluate(`timelineFocusTrace.slice(${focusBefore.events})`);
        const inView = thumb.x >= 0 && thumb.right <= width && thumb.y >= 0 && thumb.bottom <= (await evaluate('innerHeight'));
        if (!inView || focusBefore.active === focusBefore.requested) {
          t.diagnostic(`Thumbnail focus ${width}/${index}: ${JSON.stringify({before:focusBefore,after:focusAfter,events:focusEvents})}`);
        }
        assert.ok(focusEvents.some(event => event.id === focusBefore.requested), 'fixture delivers a genuine thumbnail focus event');
        assert.ok(thumb.x >= 0 && thumb.right <= width && thumb.y >= 0 && thumb.bottom <= (await evaluate('innerHeight')), 'focused offscreen image becomes visible');
         await key(index % 2 ? ' ' : 'Enter');
        await until(() => evaluate(`document.querySelector('dialog').open && document.querySelector('dialog img')?.complete && document.querySelector('dialog img').naturalWidth>0`), 'large local decoded modal');
        const modal = await evaluate(`(() => {const d=document.querySelector('dialog'),img=d.querySelector('img'),r=d.getBoundingClientRect(),c=d.querySelector('button').getBoundingClientRect();return {src:img.src,w:img.naturalWidth,h:img.naturalHeight,fit:getComputedStyle(img).objectFit,box:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},button:{w:c.width,h:c.height},focus:d.contains(document.activeElement),caption:d.querySelector('figcaption').textContent,lock:document.body.style.position}})()`);
        assert.equal(modal.src, thumb.href);
        assert.equal(modal.fit, 'contain');
        const imageContext = await evaluate(`(() => {const link=document.querySelector('${selector}'), image=document.querySelector('dialog img');return {alt:image.alt,thumbAlt:link.querySelector('img').alt,title:link.closest('[data-milestone]').querySelector('h3').textContent,period:link.closest('[data-milestone]').querySelector('[data-timeline-period]').textContent,kind:link.querySelector('img').dataset.mediaKind}})()`);
        assert.equal(imageContext.alt, imageContext.thumbAlt, 'viewer keeps factual alternative');
        assert.ok(modal.caption.startsWith(imageContext.title + ' · ' + imageContext.period + '.'));
        assert.equal(modal.caption.includes(imageContext.alt), false, 'visible marketing caption is not alt narration');
        const mediaCaptions = ['Aprender los fundamentos de Blockchain para explorar proyectos Web3.', 'Explorar protocolos Web3: del contrato inteligente a la gobernanza on-chain.', 'Profundizar en protocolos Web3 con un enfoque de proyecto.', 'Explorar ideas mediante experimentación y prototipos en comunidad.', 'Conectar con una comunidad internacional para explorar proyectos Web3.', 'Conocer el ecosistema Blockchain y sus espacios de encuentro.'];
        assert.ok(modal.caption.includes(mediaCaptions[index]));
        assert.ok(modal.caption.includes(imageContext.kind === 'poster' ? 'Afiche de archivo; no es una convocatoria vigente.' : imageContext.kind === 'logo' ? 'Identidad del encuentro; no es una fotografía.' : 'Fotografía de archivo.'));
        assert.ok(modal.w <= 1600 && modal.h <= 1600);
        assert.equal(modal.lock, 'fixed');
        assert.equal(modal.focus, true);
        assert.ok(modal.button.w >= 44 && modal.button.h >= 44);
        assert.ok(modal.box.x >= 0 && modal.box.right <= width && modal.box.y >= 0 && modal.box.bottom <= (await evaluate('innerHeight')));
        const focusEvidence = () => evaluate(`(() => {
          const d=document.querySelector('dialog'),a=document.activeElement;
          const identity=e=>({tag:e?.tagName,id:e?.id,html:e?.outerHTML.slice(0,500)});
          return {active:identity(a),hasFocus:document.hasFocus(),open:d.open,modal:d.matches(':modal'),
            contained:d.contains(a),visibility:document.visibilityState,scroll:scrollY,
            focusables:[...d.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].map(identity)};
        })()`);
        for (let tab = 0; tab < 6; tab += 1) {
          const beforeTab = await focusEvidence();
          await key('Tab', tab >= 3 ? 8 : 0);
          const after = await focusEvidence();
          if (!after.contained || !after.hasFocus || !after.open || !after.modal) {
            t.diagnostic(`modal focus failure ${width}/${index}/${tab}: ${JSON.stringify({before:beforeTab,after})}`);
          }
          assert.equal(after.contained, true, 'native modal Tab trap');
          assert.equal(after.hasFocus, true, 'document retains focus through forward/reverse cycles');
          assert.equal(after.open && after.modal, true, 'native top-layer dialog remains open');
        }
        await key('ArrowRight');
        assert.equal(await evaluate(`document.querySelector('dialog').open`), true, 'non-Tab keys do not close viewer');
        if (index === 0) await capture(width >= 900 ? 'desktop-timeline-dialog' : 'mobile-timeline-dialog');
        if (index % 3 === 0) await key('Escape');
        else if (index % 3 === 1) await click('dialog button');
        else {
          await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:1,y:1,button:'left',clickCount:1 });
          await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:1,y:1,button:'left',clickCount:1 });
        }
        await until(() => evaluate(`!document.querySelector('dialog').open`), 'modal closed');
        const restored = await evaluate(`({focus:document.activeElement===document.querySelector('${selector}'),scroll:scrollY,body:document.body.style.cssText,html:document.documentElement.style.cssText})`);
        assert.equal(restored.focus, true);
        assert.ok(Math.abs(restored.scroll - thumb.scroll) <= 1);
        assert.equal(restored.body, thumb.body); assert.equal(restored.html, thumb.html);
        t.diagnostic(`modal ${width}px ${index}: ${JSON.stringify(modal)}; invoking focus and exact styles/scroll restored`);
      }
    };
    await modalCases(1440);
    await evaluate(`document.querySelector('[data-timeline-image="milestone-0"]').focus({preventScroll:true})`);
    await key(' ');
    await until(() => evaluate(`document.querySelector('dialog').matches(':modal')`), 'Space opens lifecycle probe');
    const lockedStyles = await evaluate(`({body:document.body.style.cssText,html:document.documentElement.style.cssText})`);
    await resize(390, true);
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await delay(150);
    assert.equal(await evaluate(`document.querySelector('dialog').matches(':modal') && document.querySelector('dialog').contains(document.activeElement)`), true, 'resize/live reduced motion preserves open dialog and focus');
    assert.deepEqual(await evaluate(`({body:document.body.style.cssText,html:document.documentElement.style.cssText})`), lockedStyles, 'layout changes do not reopen scroll-lock ownership');
    // Explicit disconnected-invoker fault injection, not simulated user input.
    await evaluate(`(() => {const old=document.querySelector('[data-timeline-image="milestone-0"]');window.__originalInvoker=old;old.replaceWith(old.cloneNode(true));})()`);
    await key('Escape');
    await until(() => evaluate(`!document.querySelector('dialog').open`), 'lifecycle probe closes');
    assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-timeline-image="milestone-0"]') && !window.__originalInvoker.isConnected`), true, 'disconnected invoker returns focus to corresponding current link');
    await evaluate(`document.querySelector('[data-timeline-image="milestone-0"]').replaceWith(window.__originalInvoker);delete window.__originalInvoker`);
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await resize(1440);
    t.diagnostic('modal lifecycle: real Space, resize and live reduced motion retained top layer/focus/lock; explicit disconnected-link fault restored current corresponding link');
    await timelineAt(0, 'desktop-timeline-keyboard');
    await evaluate(`document.querySelector('[data-timeline-image]').focus()`);
    await evaluate(`window.__timelineScrollEnded=false;document.addEventListener('scrollend',()=>{window.__timelineScrollEnded=true},{once:true})`);
    await key('ArrowDown');
    await until(async () => (await timelineState()).progress > 0, 'native keyboard advances timeline');
    await until(() => evaluate('window.__timelineScrollEnded'), 'native keyboard scrollend before mouse input');
    const beforeTimelineWheel = (await timelineState()).progress;
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:700,y:400});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel',x:700,y:400,deltaX:0,deltaY:200});
    await until(async () => {
      const value = await timelineState();
      return value.progress > beforeTimelineWheel + .03;
    }, 'real mouse scroll advances timeline').catch(async error => {
      t.diagnostic(`native timeline failed mouse: ${JSON.stringify(await timelineState())}`);
      throw error;
    });

    const readableTimelineFallback = async () => {
      await until(async () => {
        const value = await timelineState();
        return !value.enhanced && value.x === 0 && value.splits === 0;
      }, 'native timeline fallback after owned context reversion');
      const value = await timelineState();
      assert.equal(value.triggers, 0);
      assert.equal(value.splits, 0);
      assert.equal(value.x, 0);
      assert.equal(value.entries.filter(entry => entry.image?.decoded).length, 6, 'all fallback media decoded');
      for (let index = 0; index < 7; index += 1) {
        await center(`[data-milestone="milestone-${index}"] h3`);
        assert.equal(await evaluate(`(() => {const e=document.querySelector('[data-milestone="milestone-${index}"] h3'); const r=e.getBoundingClientRect();return r.y>=document.querySelector('header').getBoundingClientRect().bottom&&r.bottom<=innerHeight&&getComputedStyle(e).visibility==='visible';})()`), true, 'fallback milestone reachable');
      }
    };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await resize(390, true);
      if (cycle === 0) {
        await timelineAt(0, 'mobile-timeline-start');
        await timelineAt(1, 'mobile-timeline-end');
        await modalCases(390, true);
      }
      await timelineAt(.5, `mobile-timeline-middle-${cycle}`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
      await readableTimelineFallback();
      if (cycle === 0) await modalCases(390, true);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'no-preference'}] });
      await resize(1440);
      const repeat = await timelineAt(.5, `desktop-timeline-repeat-${cycle}`);
      assert.equal(repeat.splits, timelineMiddle.splits, 'no SplitText wrapper accumulation');
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
    await readableTimelineFallback();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'no-preference'}] });
    await timelineAt(1, 'desktop-timeline-restored');
    await cdp.send('Emulation.setDeviceMetricsOverride', {width:844,height:390,deviceScaleFactor:1,mobile:true});
    await timelineAt(.5, 'landscape-vertical-timeline');
    await resize(1440);
    await home();

    await center(`${formation} .pl-root`);
    await cdp.send('Target.activateTarget', {targetId:page.id});
    await cdp.send('Page.bringToFront');
    await evaluate(`document.querySelector('.pl-root').focus({preventScroll:true})`);
    assert.equal(await evaluate(`document.hasFocus() && document.activeElement.matches('.pl-root')`), true, 'actual document and gallery focus before mobile Home');
    await key('Home');
    for (let index = 0; index < 6; index += 1) {
      if (index) await key('ArrowRight');
      await selected(formation, index, 6);
      await until(() => evaluate(`(() => {const image=document.querySelectorAll('.pl-shot img')[${index}];return image.complete&&image.naturalWidth>0})()`), 'actual formation photo decoded');
      const photo = await evaluate(`(() => {const r=document.querySelector('.pl-root'),i=r.querySelectorAll('img')[${index}];return {src:i.currentSrc,alt:i.alt,w:i.naturalWidth,h:i.naturalHeight,title:r.querySelector('.pl-title').textContent,caption:r.querySelector('.pl-sub').textContent}})()`);
      assert.match(photo.src, /\/_astro\//);
      assert.ok(photo.alt.length > 20 && photo.caption.length > 15);
      const photoThemes = [
        ['block-camp-3', 'Blockchain en la práctica', 'Explora cómo funciona Blockchain y dónde puede aplicarse.'],
        ['polkadot-chiledao', 'Aprende en comunidad', 'Comparte preguntas y conecta con otras personas interesadas en Web3.'],
        ['polkadot-chiledao-2', 'Conecta con el ecosistema Web3', 'Acércate a una comunidad donde aprender y explorar proyectos.'],
        ['polkadot-chiledao-4', 'Preguntas que abren posibilidades', 'Intercambia perspectivas para comprender las tecnologías descentralizadas.'],
        ['polkadot-chiledao-5', 'Fundamentos para avanzar', 'Comprende Blockchain antes de profundizar en protocolos y proyectos Web3.'],
        ['vendimiatech-workshop-chiledao', 'De las ideas a la práctica', 'Explora el aprendizaje mediante experimentación y prototipos.'],
      ];
      assert.ok(photo.src.includes('/' + photoThemes[index][0] + '.'));
      assert.equal(photo.title, photoThemes[index][1]);
      assert.equal(photo.caption, photoThemes[index][2]);
      assert.notEqual(photo.alt, photo.caption);
      t.diagnostic(`formation decoded photo ${index}: ${JSON.stringify(photo)}`);
    }
    await capture('desktop-polaroid');
    const polaroidGeometry = async (width) => {
      await center('.pl-root');
      const value = await evaluate(`(() => {
        const root=document.querySelector('.pl-root'), active=root.querySelector('[data-on="1"]'), rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height}};
        return {root:rect(root),paper:rect(active.querySelector('.pl-print')),bar:rect(root.querySelector('.pl-bar')),copy:[...root.querySelectorAll('.pl-title,.pl-sub')].map(rect),buttons:[...root.querySelectorAll('button')].map(rect),path:root.querySelector('path').getAttribute('d'),pegs:root.querySelectorAll('.pl-peg').length,pose:active.style.transform,page:document.documentElement.scrollWidth};
      })()`);
      assert.equal(value.pegs, 6);
      assert.match(value.path, /^M0 .+ Q/);
      assert.ok(value.paper.x >= value.root.x && value.paper.right <= value.root.right && value.paper.bottom < value.bar.y, 'paper clears caption/control bar');
      assert.ok(value.bar.bottom <= value.root.bottom && value.bar.x >= value.root.x && value.bar.right <= value.root.right);
      assert.ok(value.buttons.every(b => b.w >= 44 && b.h >= 44));
      assert.ok(value.copy.every(c => c.x >= value.bar.x && c.right <= value.bar.right && c.bottom <= Math.min(...value.buttons.map(b => b.y))), 'long title/caption clears buttons without clipping');
      assert.ok(value.page <= width);
      t.diagnostic(`Polaroid geometry ${width}: ${JSON.stringify(value)}`);
      return value;
    };
    const initialPose = await polaroidGeometry(1440);
    await delay(200);
    assert.notEqual(await evaluate(`document.querySelector('.pl-card[data-on="1"]').style.transform`), initialPose.pose, 'visible normal breeze updates pendulum pose');
    for (const width of [320, 390, 1440]) {
      await resize(width, width < 900);
      await selected(formation, 5, 6);
      await polaroidGeometry(width);
      await capture(`${width}-formation-copy`);
      await center('#contacto');
      const conversion = await evaluate(`(() => {const section=document.querySelector('#contacto'),links=[...section.querySelectorAll('a')];return {heading:section.querySelector('h2').textContent.trim(),links:links.map(e=>({text:e.textContent.trim(),href:e.getAttribute('href'),x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right,height:e.getBoundingClientRect().height})),page:document.documentElement.scrollWidth}})()`);
      assert.equal(conversion.heading, 'Da el siguiente paso en tu aprendizaje.');
      assert.deepEqual(conversion.links.map(link=>[link.text,link.href]), [['Consultar talleres y capacitación','mailto:contacto@chiledao.cl'],['Conocer la comunidad','https://linktr.ee/web3chile']]);
      assert.ok(conversion.links.every(link=>link.x>=0&&link.right<=width&&link.height>=44));
      assert.ok(conversion.page<=width);
      await capture(`${width}-conversion`);
      t.diagnostic(`conversion ${width}: ${JSON.stringify(conversion)}`);
    }
    await click(`${formation} .pl-prev`);
    await selected(formation, 4, 6);
    await click(`${formation} .pl-next`);
    await selected(formation, 5, 6);
    assert.equal(await evaluate(`document.activeElement===document.querySelector('.pl-root')`), true, 'disabling last arrow preserves focus');
    const beforeIdle = await state(formation);
    await delay(1300);
    const afterIdle = await state(formation);
    assert.ok(Math.abs(afterIdle.left - beforeIdle.left) < 2, 'idle offset stable within scroll rounding');
    assert.deepEqual({ ...afterIdle, left: beforeIdle.left }, beforeIdle, 'no idle autoplay during observation');
    await evaluate(`document.querySelector('.pl-root').focus({preventScroll:true})`);
    await key('Home'); await selected(formation, 0, 6);
    const cardPoint = await evaluate(`(() => {const r=document.querySelector('.pl-root').getBoundingClientRect(),c=document.querySelector('.pl-card[data-i="1"] .pl-shot').getBoundingClientRect();return {x:Math.min(r.right-12,c.right-12),y:c.y+c.height/2}})()`);
    assert.equal(await evaluate(`document.elementFromPoint(${cardPoint.x},${cardPoint.y})?.closest('[data-i]')?.dataset.i`), '1', 'real visible neighboring card hit target');
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...cardPoint});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...cardPoint});
    await selected(formation, 1, 6);
    const mouse = await center('.pl-root');
    mouse.y -= 80;
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...mouse});
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',buttons:1,button:'left',x:mouse.x-step*22,y:mouse.y});
      await delay(25);
    }
    const releasedOffset = (await state(formation)).left;
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,x:mouse.x-176,y:mouse.y});
    await delay(100);
    assert.notEqual((await state(formation)).left, releasedOffset, 'mouse release continues actual spring/inertia');
    await until(async () => (await state(formation)).index > 1, 'real mouse drag selects later photo');
    await delay(900);
    await selected(formation, (await state(formation)).index, 6);
    await evaluate(`document.querySelector('.pl-root').focus({preventScroll:true})`);
    await key('End'); await selected(formation, 5, 6);
    await resize(390, true);
    await selected(formation, 5, 6);
    await polaroidGeometry(390);
    await wheelSelected(0, 0);
    await layout(390);
    await heroGeometry();
    await capture('mobile-ring');
    await click('#inicio a[href="#formacion"]');
    await until(() => evaluate(`location.hash === '#formacion'`), 'mobile formation CTA');
    await click('#menu-toggle');
    await click('#mobile-menu a[href="#contacto"]');
    await until(() => evaluate(`location.hash === '#contacto'`), 'mobile contact CTA');
    await center(`${formation} .pl-root`);
    await cdp.send('Target.activateTarget', {targetId:page.id});
    await cdp.send('Page.bringToFront');
    await evaluate(`document.querySelector('.pl-root').focus({preventScroll:true})`);
    assert.equal(await evaluate(`document.hasFocus() && document.activeElement.matches('.pl-root')`), true, 'real foreground gallery focus before Home');
    await evaluate(`(() => {
      const root=document.querySelector('.pl-root');
      window.__galleryTraversal={running:true,rows:[],keys:[]};
      const trace=window.__galleryTraversal;
      trace.receive=e=>{
        if(e.target===root&&['Home','End'].includes(e.key))trace.keys.push({key:e.key,trusted:e.isTrusted,prevented:e.defaultPrevented,focused:document.hasFocus()&&document.activeElement===root});
      };
      window.addEventListener('keydown',trace.receive);
      let previous='';
      const sample=()=>{
        if(!trace.running)return;
        const spacing=parseFloat(getComputedStyle(root).getPropertyValue('--pl-cw'))*1.08;
        const identity=root.dataset.active+':'+spacing;
        if(identity!==previous){
          trace.rows.push({time:performance.now(),active:Number(root.dataset.active),spacing,offset:Number(root.dataset.offset),velocity:Number(root.dataset.velocity)});
          previous=identity;
        }
        requestAnimationFrame(sample);
      };
      sample();
    })()`);
    try {
      // Caption-height changes must not replace a native endpoint request with
      // the transient nearest slide. Exercise both directions, not just Home.
      for (const [input, index] of [['Home', 0], ['End', 5], ['Home', 0]]) {
        await key(input);
        await selected(formation, index, 6);
      }
      const traversal = await evaluate(`({rows:window.__galleryTraversal.rows,keys:window.__galleryTraversal.keys})`);
      assert.deepEqual(traversal.keys, ['Home', 'End', 'Home'].map(input => ({key:input,trusted:true,prevented:true,focused:true})), 'genuine endpoint input is received and prevented by the focused gallery');
      assert.ok(new Set(traversal.rows.map(row => row.spacing)).size > 1, 'real caption-driven spacing change exercised during endpoint traversal');
      t.diagnostic(`gallery endpoint traversal: ${traversal.keys.length} native prevented keys; ${new Set(traversal.rows.map(row => row.spacing)).size} actual spacings; Home/End/Home settled`);
    } catch (error) {
      for (const row of await evaluate('window.__galleryTraversal.rows')) t.diagnostic(`gallery traversal: ${JSON.stringify(row)}`);
      t.diagnostic(`gallery native keys: ${JSON.stringify(await evaluate('window.__galleryTraversal.keys'))}`);
      throw error;
    } finally {
      await evaluate(`window.__galleryTraversal.running=false;window.removeEventListener('keydown',window.__galleryTraversal.receive)`);
    }
    await swipe(formation);
    await until(async () => (await state(formation)).index > 0, 'native touch changes photo');
    await delay(400);
    const swiped = await state(formation);
    await selected(formation, swiped.index, 6);
    const verticalPhoto = await center('.pl-root');
    const verticalBefore = await state(formation);
    const verticalScroll = await evaluate('scrollY');
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[verticalPhoto]});
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:verticalPhoto.x,y:verticalPhoto.y-step*20}]});
      await delay(20);
    }
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await until(() => evaluate(`scrollY > ${verticalScroll}+20`), 'formation vertical gesture preserves native page travel');
    assert.equal((await state(formation)).index, verticalBefore.index, 'vertical/pointercancel does not select a card');
    await center('.pl-root');
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[verticalPhoto]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchCancel',touchPoints:[]});
    assert.equal((await state(formation)).index, verticalBefore.index, 'cancel without movement has no false click');
    await wheelSelected(0, 0);
    await resize(1440);
    await selected(formation, swiped.index, 6);
    await resize(390, true);
    await selected(formation, swiped.index, 6);
    await center(`${formation} .pl-root`);
    await capture('mobile-formation');
    await resize(320, true);
    await selected(formation, swiped.index, 6);
    await polaroidGeometry(320);
    await capture('320-polaroid');
    await resize(390, true);
    await center('.pl-root');
    await selected(formation, swiped.index, 6);
    let stableFrames = 0;
    let previousSpacing;
    await until(async () => {
      const value = await state(formation);
      const velocity = Number(await evaluate(`document.querySelector('.pl-root').dataset.velocity`));
      const stable = Math.abs(value.left-value.index*value.width)<2 && Math.abs(velocity)<.01 && value.width===previousSpacing;
      previousSpacing=value.width;
      stableFrames=stable?stableFrames+1:0;
      return stableFrames>=5;
    }, 'stable responsive offset velocity and spacing before hiding');
    const beforeHidden = await state(formation);
    t.diagnostic(`visibility motion BEFORE: ${JSON.stringify({state:beforeHidden,velocity:await evaluate("document.querySelector('.pl-root').dataset.velocity")})}`);
    await cdp.send('Page.setWebLifecycleState', {state:'frozen'});
    assert.equal(await evaluate('document.hidden'), true, 'real browser lifecycle hides document');
    const hiddenDraws = await evaluate(`document.querySelector('.pl-root').dataset.draws`);
    await delay(200);
    assert.equal(await evaluate(`document.querySelector('.pl-root').dataset.draws`), hiddenDraws, 'hidden document stops owned frames');
    await cdp.send('Page.setWebLifecycleState', {state:'active'});
    const visibilityEvidence = () => evaluate(`(() => {
      const root=document.querySelector('.pl-root'),r=root.getBoundingClientRect();
      return {visibility:document.visibilityState,hidden:document.hidden,bounds:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},intersection:window.__visibilityIntersection??null,draws:root.dataset.draws};
    })()`);
    await evaluate(`window.__visibilityIntersection=null;window.__visibilityObserver=new IntersectionObserver(entries=>{window.__visibilityIntersection={eligible:entries[0].isIntersecting,ratio:entries[0].intersectionRatio};window.__visibilityObserver.disconnect()});window.__visibilityObserver.observe(document.querySelector('.pl-root'))`);
    await delay(100);
    const afterActive=await visibilityEvidence();
    t.diagnostic(`visibility after lifecycle active (not foreground): ${JSON.stringify(afterActive)}`);
    // Lifecycle active unfreezes scheduling but does not foreground a hidden tab.
    // Exercise actual owned targets instead of synthesizing visibility events.
    const secondary = await cdp.send('Target.createTarget', {url:'about:blank'});
    let secondaryConnection;
    try {
      const ownedTargets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const secondaryPage=ownedTargets.find(target=>target.id===secondary.targetId);
      assert.ok(secondaryPage);
      secondaryConnection=await connect(secondaryPage.webSocketDebuggerUrl);
      await cdp.send('Target.activateTarget', {targetId:secondary.targetId});
      await secondaryConnection.send('Page.bringToFront');
      await until(() => evaluate('document.hidden'), 'primary truly backgrounded');
      const secondaryVisibility=async()=> (await secondaryConnection.send('Runtime.evaluate', {expression:'document.visibilityState',returnByValue:true})).result.value;
      assert.equal(await secondaryVisibility(), 'visible', 'owned background target actually foregrounded');
      const backgroundDraws=await evaluate(`document.querySelector('.pl-root').dataset.draws`);
      await delay(200);
      assert.equal(await evaluate(`document.querySelector('.pl-root').dataset.draws`), backgroundDraws, 'real background tab stops owned frames');
      await cdp.send('Target.activateTarget', {targetId:page.id});
      await cdp.send('Page.bringToFront');
      await until(() => evaluate('!document.hidden'), 'primary truly foregrounded');
      assert.equal(await secondaryVisibility(), 'hidden', 'owned secondary actually backgrounded');
      await until(() => evaluate(`window.__visibilityIntersection?.eligible && Number(document.querySelector('.pl-root').dataset.draws)>${backgroundDraws}`), 'foreground intersection and owned draw restart');
      t.diagnostic(`visibility after real foreground: ${JSON.stringify(await visibilityEvidence())}; secondary hidden; background draws=${backgroundDraws}`);
    } finally {
      secondaryConnection?.close();
      await cdp.send('Target.closeTarget', {targetId:secondary.targetId});
      await evaluate(`window.__visibilityObserver?.disconnect();delete window.__visibilityObserver;delete window.__visibilityIntersection`);
    }
    await until(() => evaluate(`!document.hidden && Number(document.querySelector('.pl-root').dataset.draws)>${hiddenDraws}`), 'visible document restarts owned frames');
    assert.equal((await state(formation)).index, beforeHidden.index, 'visibility restart preserves selection');
    t.diagnostic(`visibility motion AFTER: ${JSON.stringify({state:await state(formation),velocity:await evaluate("document.querySelector('.pl-root').dataset.velocity")})}`);
    assert.ok(Math.abs((await state(formation)).left-beforeHidden.left)<2, 'visibility restart has no offset jump');
    t.diagnostic(`touch: actual CDP touch gesture selected photo ${swiped.index + 1}; state/buttons synchronized; selected photos preserved across 1440/390 resize`);

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    await readableTimelineFallback();
    const assertReducedPoses = async input => {
      const pose = await evaluate(`(() => {
        const root=document.querySelector('.pl-root'),r=root.getBoundingClientRect();
        return {root:{x:r.x,w:r.width},cards:[...root.querySelectorAll('.pl-card')].map(card=>{
          const style=getComputedStyle(card),matrix=new DOMMatrixReadOnly(style.transform),box=card.getBoundingClientRect();
          return {index:Number(card.dataset.i),selected:card.dataset.on==='1',authored:card.style.transform,computed:style.transform,
            a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,translate:style.translate,rotate:style.rotate,
            visibility:style.visibility,transition:style.transitionProperty,effects:card.getAnimations().map(a=>a.constructor.name),x:box.x,w:box.width};
        })};
      })()`);
      assert.equal(pose.cards.length, 6);
      for (const card of pose.cards) {
        assert.deepEqual({a:card.a,b:card.b,c:card.c,d:card.d}, {a:1,b:0,c:0,d:1}, `reduced ${input} card ${card.index} renders exactly zero rotation: ${JSON.stringify(card)}`);
        assert.equal(card.translate, 'none');
        assert.equal(card.rotate, 'none');
        assert.equal(card.transition, 'none', 'imperative reduced poses cannot acquire CSS transitions');
        assert.deepEqual(card.effects, [], 'no pending card effect overrides the actual reduced pose');
      }
      const active = pose.cards.find(card => card.selected);
      assert.equal(active.visibility, 'visible', 'reduced endpoint is actually visible, not just selected in React');
      assert.ok(Math.abs(active.x+active.w/2-(pose.root.x+pose.root.w/2))<2, 'computed reduced endpoint stays in its actual centered slot');
      t.diagnostic(`reduced ${input}: six exact computed zero rotations; no card CSS effects; selected photo ${active.index+1} visible and centered`);
    };
    await center('.pl-root');
    await evaluate(`document.querySelector('.pl-root').focus({preventScroll:true})`);
    await key('Home'); await selected(formation, 0, 6);
    await assertReducedPoses('Home');
    const motionDraws = await evaluate(`document.querySelector('.pl-root').dataset.draws`);
    await delay(200);
    assert.equal(await evaluate(`document.querySelector('.pl-root').dataset.draws`), motionDraws, 'reduced-motion Polaroid has no idle owned RAF');
    await key('End'); await selected(formation, 5, 6);
    await assertReducedPoses('End');
    await center('#contacto');
    await delay(150);
    const offscreenDraws = await evaluate(`document.querySelector('.pl-root').dataset.draws`);
    await delay(200);
    assert.equal(await evaluate(`document.querySelector('.pl-root').dataset.draws`), offscreenDraws, 'offscreen Polaroid stops owned frames');
    const fallbackPhotos = async () => {
      for (let index = 0; index < 6; index += 1) {
        await evaluate(`document.querySelectorAll('[data-polaroid-fallback] figure')[${index}].scrollIntoView({block:'center',inline:'center',behavior:'instant'})`);
        await until(() => evaluate(`(() => {const f=document.querySelectorAll('[data-polaroid-fallback] figure')[${index}],i=f.querySelector('img');return i.complete&&i.naturalWidth>0&&f.querySelector('figcaption').textContent.length>15})()`), `fallback real photo ${index+1}`);
      }
    };
    await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
    await key('ArrowDown');
    await key('ArrowDown');
    await wheelSelected(1);
    assert.equal((await wheelState()).turn, 2, 'reduced motion skips interpolation');
    const touchPoint = await center('[data-works-stage]');
    const startX = touchPoint.x + 100;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: touchPoint.y }] });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - 250 * step / 10, y: touchPoint.y }] });
      await delay(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wheelSelected(2);
    await capture('mobile-drum');
    const vertical = await center('[data-works-stage]');
    const scrollBeforeTouch = await evaluate('scrollY');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vertical.x, y: vertical.y }] });
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vertical.x, y: vertical.y - 180 * step / 8 }] });
      await delay(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(() => evaluate(`scrollY > ${scrollBeforeTouch} + 20`), 'native vertical touch page travel');
    await wheelSelected(2);
    await center('#inicio h1');
    await capture('mobile');
    await click('#faq summary');
    assert.equal(await evaluate(`document.querySelector('#faq details').open`), true);
    await click('#faq summary');
    assert.equal(await evaluate(`document.querySelector('#faq details').open`), false);
    await click('#menu-toggle');
    assert.equal(await evaluate(`document.querySelector('#menu-toggle').getAttribute('aria-expanded')`), 'true');
    await key('Escape');
    assert.equal(await evaluate(`document.querySelector('#menu-toggle').getAttribute('aria-expanded')`), 'false');
    await click('#menu-toggle');
    await click('#mobile-menu a[href="#formacion"]');
    assert.equal(await evaluate(`document.querySelector('#menu-toggle').getAttribute('aria-expanded')`), 'false');
    await until(() => evaluate(`location.hash === '#formacion' && document.querySelector('#formacion').getBoundingClientRect().top >= document.querySelector('header').getBoundingClientRect().bottom`), 'formation anchor clears sticky header');
    t.diagnostic('reduced motion: immediate target offset; native FAQ, mobile menu Escape/link closure and sticky-header anchor clearance passed');

    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
    await navigate();
    for (const selector of [formation]) {
      const fallback = await state(selector);
      assert.equal(fallback.hidden, true, 'no-JS controls stay hidden');
      assert.equal(fallback.index, 0);
    }
    assert.equal(await evaluate(`document.querySelector('[data-works-stage]').getAttribute('role')`), 'group', 'no inert listbox controls without JS');
    await until(() => evaluate(`[...document.querySelectorAll('[data-work-face] img')].length===8 && [...document.querySelectorAll('[data-work-face] img')].every(i=>i.complete&&i.naturalWidth>0)`), 'no-JS eight real artworks decoded');
    await readableTimelineFallback();
    assert.equal(await evaluate(`document.querySelectorAll('[data-timeline-image][href^="/_astro/"]').length`), 6, 'no-JS image URLs remain real');
    await fallbackPhotos();
    await evaluate(`document.querySelector('[data-polaroid-fallback]').scrollTo({left:0,behavior:'instant'})`);
    assert.equal(await evaluate(`document.querySelector('[data-work-title]').textContent`), 'Block Camp');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-work-face] img')).objectFit`), 'contain');
    await center('[data-works-stage]');
    await capture('mobile-no-js');
    await click(`${formation} [data-polaroid-fallback]`);
    await key('ArrowRight');
    await until(async () => (await state(formation)).index > 0, 'no-JS native keyboard scrolling');
    await delay(400);
    assert.ok((await state(formation)).index > 0, 'no-JS keyboard reaches another photograph');
    await layout(390);
    // New loads exercise initial-only lifecycle contracts using real CDP input.
    await cdp.send('Emulation.setScriptExecutionDisabled', {value:false});
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const wheelSource = await readFile(new URL('../src/components/ui/works-wheel.tsx', import.meta.url), 'utf8');
    const dragUnits = Number(wheelSource.match(/const DRAG_UNITS = (\d+);/)?.[1]);
    const captureThreshold = Number(wheelSource.match(/current\.moved > (\d+)/)?.[1]);
    assert.ok(Number.isFinite(dragUnits) && Number.isFinite(captureThreshold), 'existing native drag contract found');
    for (const action of ['keyboard', 'wheel', 'pointer', 'motion']) {
      await navigate();
      await entranceRunning();
      if (action==='keyboard') {
        await evaluate(`document.querySelector('[data-works-stage]').focus({preventScroll:true})`);
        await key('ArrowDown');
      } else if (action==='wheel') {
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel',x:195,y:160,deltaX:0,deltaY:900});
       } else if (action==='pointer') {
         const gesture = await evaluate(`(() => {
           const stage=document.querySelector('[data-works-stage]'),r=stage.getBoundingClientRect();
           const top=Math.max(r.top,0),bottom=Math.min(r.bottom,innerHeight),left=Math.max(r.left,0),right=Math.min(r.right,innerWidth);
           for(const yRatio of [.85,.8,.75])for(const xRatio of [.5,.25,.75]){
             const x=left+(right-left)*xRatio,y=top+(bottom-top)*yRatio;
             const hit=document.elementFromPoint(x,y);
             if(y-${dragUnits}>top&&stage.contains(hit)&&!hit.closest('a,button,input,select,textarea,[contenteditable="true"]')){
               window.__pointerReceipt=[];
               return {x,y,end:y-${dragUnits},bounds:{top,bottom,left,right},hit:hit.tagName};
             }
           }
           return null;
         })()`);
         assert.ok(gesture, 'real visible stage offers a noninteractive in-stage drag trajectory');
         const firstMove = captureThreshold + 1;
         await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:gesture.x,y:gesture.y});
         await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,x:gesture.x,y:gesture.y});
          await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',button:'left',buttons:1,x:gesture.x,y:gesture.y-firstMove});
         await until(() => evaluate(`(() => {
           const down=window.__pointerReceipt.find(e=>e.type==='pointerdown'&&e.trusted);
           return !!down&&document.querySelector('[data-works-stage]').hasPointerCapture(down.id);
         })()`), 'application acquires capture after a real in-stage move');
         for (let step=1;step<=6;step+=1) {
           const distance=firstMove+(dragUnits-firstMove)*step/6;
            await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',button:'left',buttons:1,x:gesture.x,y:gesture.y-distance});
         }
          await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:gesture.x,y:gesture.end});
          const receipt = await evaluate('window.__pointerReceipt');
          t.diagnostic(`late native drag: ${JSON.stringify({gesture,dragUnits,captureThreshold,cancels:receipt.filter(e=>e.type==='pointercancel').length})}`);
          for (const event of receipt) t.diagnostic(`late native pointer: ${JSON.stringify(event)}`);
          assert.ok(receipt.some(e=>e.type==='gotpointercapture'&&e.trusted&&e.captured), 'native application-owned capture event observed');
          assert.ok(receipt.some(e=>e.type==='pointermove'&&e.trusted&&e.captured&&e.stageTarget), 'actual drag moves reach the captured stage');
          assert.ok(receipt.some(e=>e.type==='pointerup'&&e.trusted), 'actual native release observed');
          assert.equal(await evaluate(`document.querySelector('[data-works-stage]').hasPointerCapture(${receipt.find(e=>e.type==='pointerdown').id})`), false, 'native release retires late capture');
      } else await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await entranceComplete();
      if (action==='keyboard'||action==='wheel') await wheelSelected(0,1);
       if (action==='pointer') await until(async()=> (await entranceState()).turn>0, 'early real drag still advances wheel').catch(async error=>{
         for(const row of await evaluate('window.__pointerReceipt'))t.diagnostic(`late pointer receipt: ${JSON.stringify(row)}`);
         t.diagnostic(`late pointer state: ${JSON.stringify(await entranceState())}`);
         throw error;
       });
      if (action==='motion') assert.equal((await entranceState()).turn,0);
      t.diagnostic(`early ${action}: entrance restored without blocking wheel/motion handling`);
      await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    }
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await navigate();
    const bypassed=await entranceComplete();
    assert.equal(bypassed.starts, undefined, 'initial reduced motion never starts a timeline');
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await resize(320,true); await home(); await heroGeometry();
    await resize(390,true); await heroGeometry();
    await resize(1440); await heroGeometry();
    assert.equal((await entranceState()).starts,undefined,'motion changes, Home and resize never replay bypassed entrance');
    failEntranceImports=true;
    const failedImportDocument = await navigate();
    const currentEntranceFaults = () => entranceFaults.map(fault=>({ ...fault, ...scriptRequests.get(fault.networkId) }))
      .filter(fault=>fault.acknowledged&&fault.loaderId===failedImportDocument.loader&&fault.frameId===failedImportDocument.frame);
    await until(() => currentEntranceFaults().length > 0, 'acknowledged SplitText dependency failure belongs to fresh native loader');
    t.diagnostic(`fresh import fault acknowledged: ${JSON.stringify({document:failedImportDocument,faults:currentEntranceFaults()})}`);
    await entranceComplete();
    assert.ok(blockedEntranceImports>0, 'actual dynamic SplitText import failure exercised');
    assert.ok(currentEntranceFaults().length>0, 'fallback proof retains acknowledged dependency failure in current document');
    assert.equal((await entranceState()).decoded,true,'failed animation imports retain eight real photos');
    assert.equal(await evaluate(`document.querySelectorAll('[data-hero-intro] a').length`),2);
    failEntranceImports=false;
    await resize(390,true);
    failScripts = true;
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
    await navigate();
    await until(() => evaluate(`[...document.querySelectorAll('[data-work-face] img')].length===8 && [...document.querySelectorAll('[data-work-face] img')].every(i=>i.complete&&i.naturalWidth>0)`), 'failed-JS eight artwork shell');
    await readableTimelineFallback();
    assert.equal(await evaluate(`document.querySelectorAll('[data-polaroid-fallback] figure').length`), 6, 'failed scripts retain six factual photographs');
    await fallbackPhotos();
    assert.equal(await evaluate(`document.querySelector('[data-work-title]').textContent`), 'Block Camp');
    assert.equal(await evaluate(`document.querySelector('[data-works-stage]').getAttribute('role')`), 'group');
    assert.deepEqual(runtimeErrors, [], 'no uncaught runtime exceptions');
    assert.deepEqual(cdp.errors, [], 'no interception/controller errors');
    t.diagnostic('no-JS and failed-JS: same ring with eight decoded archive artwork links and readable intro, no inert listbox; formation native keyboard scrolling retained without JS. Mobile wheel horizontal touch, vertical page travel and reduced motion passed.');
    t.diagnostic(`request isolation: ${requests.local} permitted local/data/blob requests; ${requests.blocked.length} external requests intercepted and aborted before network: ${requests.blocked.join(', ')}`);
    for (const path of screenshots) t.diagnostic(`screenshot: ${path}`);
  } catch (error) {
    if (cdp) {
      try {
        const snapshot = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `({epoch:window.__lateHero?.id,events:window.__pointerReceipt??[],stage:document.querySelector('[data-works-stage]')?.dataset,entrance:document.querySelector('[data-works-showcase]')?.dataset,photos:[...document.querySelectorAll('[data-hero-photo]')].map(e=>({ready:e.dataset.photoReady,connected:e.isConnected,opacity:getComputedStyle(e).opacity,transform:getComputedStyle(e).transform,decoded:e.querySelector('img').complete&&e.querySelector('img').naturalWidth>0,effects:e.getAnimations().map(a=>({state:a.playState,time:a.currentTime,duration:a.effect.getTiming().duration}))})),hidden:document.hidden,focus:document.hasFocus()})` });
        const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame;
        const { events, ...state } = snapshot.result?.value??{};
        t.diagnostic(`Failure-time main journey state: ${JSON.stringify({navigation:navigationReceipt,frame:{id:frame.id,loader:frame.loaderId},state,faults:entranceFaults.map(fault=>({...fault,...scriptRequests.get(fault.networkId)}))})}`);
        for (const event of events??[]) t.diagnostic(`Failure-time main pointer: ${JSON.stringify(event)}`);
      } catch (diagnosticError) { t.diagnostic(`Main journey diagnostics unavailable: ${diagnosticError.message}`); }
    }
    throw error;
  } finally {
    if (browser && !browserClosed) {
      if (cdp) await cdp.send('Browser.close').catch(() => {});
      try { await until(() => browserClosed, 'owned browser exit', 5000); }
      catch {
        browser.kill();
        await until(() => browserClosed, 'owned child exit after kill', 5000);
      }
    }
    cdp?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    t.diagnostic(`cleanup: owned browser exited=${browserClosed}; server closed=${Boolean(server && !server.listening)}; fresh profile retained=${profile}; screenshots retained outside profile`);
  }
});
