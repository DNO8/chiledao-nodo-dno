import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { worksAssetCopies } from './fixtures/works-assets.mjs';

const decode = (value) => value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
  if (entity.startsWith('#')) {
    return String.fromCodePoint(entity[1].toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  }
  return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[entity.toLowerCase()];
});

// A small tree reader for generated HTML, not a browser or a visibility engine.
function parse(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  for (const token of html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').match(/<!--[^]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim().toLowerCase();
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index > 0) stack.length = index;
    } else if (/^<[a-z]/i.test(token)) {
      const tag = token.match(/^<([\w-]+)/)[1].toLowerCase();
      const attrs = {};
      const attributes = token.slice(tag.length + 1, -1);
      for (const match of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
      }
      const node = { tag, attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
    } else if (!token.startsWith('<')) {
      stack.at(-1).children.push(decode(token));
    }
  }
  return root;
}

function all(node, predicate) {
  return node.children.flatMap((child) => typeof child === 'string' ? [] : [
    ...(predicate(child) ? [child] : []), ...all(child, predicate),
  ]);
}
const text = (node) => node.children.map((child) => typeof child === 'string' ? child : text(child)).join(' ').replace(/\s+/g, ' ').trim();
const byTag = (node, tag) => all(node, (child) => child.tag === tag);
const document = parse(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8'));
const byId = (id) => all(document, (node) => node.attrs.id === id);
const one = (nodes, message) => {
  assert.equal(nodes.length, 1, message);
  return nodes[0];
};
const main = one(byTag(document, 'main'), 'one main landmark');
const destinations = ['#blockchain', '#ia', '#formacion', '#contacto'];
const labels = ['Blockchain', 'IA', 'Formación', 'Contacto'];

test('root reserves native scrollbar space without an overflow or pixel workaround', () => {
  const html = one(byTag(document, 'html'), 'one root');
  assert.equal(html.attrs.style, 'scrollbar-gutter: stable;');
});

test('above-fold font preloads reuse registered local hashed WOFF2 assets', () => {
  const expected = ['sora-latin-700-normal', 'inter-latin-400-normal',
    'inter-latin-500-normal', 'inter-latin-600-normal', 'geist-mono-latin-400-normal'];
  const preloads = byTag(document, 'link').filter(node => node.attrs.rel === 'preload' && node.attrs.as === 'font');
  assert.equal(preloads.length, expected.length, 'only five actually used above-fold faces');
  assert.equal(new Set(preloads.map(node => node.attrs.href)).size, expected.length);
  const styles = byTag(document, 'link').filter(node => node.attrs.rel === 'stylesheet')
    .map(node => readFileSync(new URL(`../dist${node.attrs.href}`, import.meta.url), 'utf8')).join('\n');
  for (const [index, preload] of preloads.entries()) {
    assert.match(preload.attrs.href, new RegExp(`^/_astro/${expected[index]}\\.[\\w-]+\\.woff2$`));
    assert.equal(preload.attrs.type, 'font/woff2');
    assert.equal(preload.attrs.crossorigin, 'anonymous');
    assert.equal(readFileSync(new URL(`../dist${preload.attrs.href}`, import.meta.url)).toString('ascii', 0, 4), 'wOF2');
    assert.ok(styles.includes(preload.attrs.href.split('/').at(-1)), 'CSS and preload resolve the same asset');
    const [family, weight] = expected[index].split('-latin-');
    const registration = readFileSync(new URL(`../node_modules/@fontsource/${family}/${parseInt(weight)}.css`, import.meta.url), 'utf8');
    assert.ok(registration.includes(`${expected[index]}.woff2`));
    assert.match(registration, /font-display:\s*swap/);
  }
});

test('HTML reader handles minification, nested labels and encoded attributes', () => {
  const fixture = parse('<main><a href="#formaci&#243;n">Blockchain &amp; <span>IA</span></a><br><p>Formaci&#xF3;n&nbsp;útil</p></main>');
  const link = one(byTag(fixture, 'a'), 'fixture link');
  assert.equal(link.attrs.href, '#formación');
  assert.equal(text(link), 'Blockchain & IA');
  assert.equal(text(one(byTag(fixture, 'p'), 'fixture paragraph')), 'Formación útil');
  assert.equal(byTag(fixture, 'main').length, 1);
});

test('hero names both learning subjects without hidden-heading classes', () => {
  const hero = one(byId('inicio'), 'one hero');
  const heading = one(byTag(document, 'h1'), 'one H1');
  assert.ok(byTag(hero, 'h1').includes(heading));
  assert.match(text(heading), /Blockchain/);
  assert.match(text(heading), /Inteligencia Artificial/);
  for (const node of [main, hero, heading, ...all(heading, () => true)]) {
    assert.equal(node.attrs['aria-hidden'], undefined);
    assert.equal(node.attrs.hidden, undefined);
    assert.doesNotMatch(node.attrs.class ?? '', /(?:^|\s)(?:\S*:)?(?:sr-only|hidden|invisible|opacity-0)(?:\s|$)/);
  }
  const links = byTag(hero, 'a');
  assert.ok(links.some((link) => text(link) === 'Explorar formación' && link.attrs.href === '#formacion'));
  const intro = one(all(hero, node => 'data-hero-intro' in node.attrs), 'hero intro');
  const community = one(byTag(intro, 'a').filter(link => text(link) === 'Conocer la comunidad'), 'hero community CTA');
  assert.equal(community.attrs.href, 'https://linktr.ee/web3chile');
  assert.equal(community.attrs.target, '_blank');
  assert.equal(community.attrs.rel, 'noopener noreferrer');
});

test('landing has one global decorative wave canvas and only the footer offers its pause control', () => {
  const hero = one(byId('inicio'), 'one hero');
  const owner = one(all(document, node => 'data-particle-wave-owner' in node.attrs), 'one explicit global owner');
  const canvas = one(all(document, node => 'data-particle-wave' in node.attrs), 'one original wave canvas');
  assert.ok(byTag(owner, 'canvas').includes(canvas));
  for (const container of [hero, main, ...byTag(document, 'header'), ...byTag(document, 'footer')]) {
    assert.equal(all(container, node => 'data-particle-wave-owner' in node.attrs).length, 0, 'owner outside content landmarks');
    assert.equal(byTag(container, 'canvas').includes(canvas), false);
  }
  assert.equal(canvas.attrs['aria-hidden'], 'true');
  assert.equal(canvas.attrs.role, 'presentation');
  assert.equal(canvas.attrs.tabindex, undefined);
  assert.ok(hero.attrs.class.split(/\s+/).includes('bg-navy'));
  const button = one(all(document, node => 'data-wave-toggle' in node.attrs), 'one wave control');
  assert.ok(byTag(one(byTag(document, 'footer'), 'footer'), 'button').includes(button));
  assert.equal(button.attrs.hidden, '');
  assert.equal(button.attrs.type, 'button');
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.equal(text(button), 'Pausar fondo animado');
  assert.equal(all(hero, node => 'data-wave-toggle' in node.attrs).length, 0);
});

test('formation CTA declared colors meet AA in default, hover and keyboard focus states', (t) => {
  const hero = one(byId('inicio'), 'one hero');
  const cta = one(byTag(hero, 'a').filter((link) => text(link) === 'Explorar formación'), 'formation CTA');
  const classes = cta.attrs.class.split(/\s+/);
  const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  const declarations = Object.fromEntries([...tokens.matchAll(/(--[\w-]+):\s*([^;]+);/g)]
    .map((match) => [match[1], match[2].trim()]));
  const rgb = (value) => {
    while (value.startsWith('var(')) value = declarations[value.slice(4, -1)];
    assert.match(value, /^#[\da-f]{6}$/i, 'supported declared color');
    return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  };
  const color = (utility, background) => {
    const match = utility.match(/^(?:bg|text|ring)-(\[#[\da-f]{6}\]|[a-z-]+)(?:\/(\d+))?$/i);
    assert.ok(match, `supported color utility: ${utility}`);
    const value = match[1].startsWith('[') ? match[1].slice(1, -1) : declarations[`--color-${match[1]}`];
    const channels = rgb(value);
    const alpha = match[2] === undefined ? 1 : Number(match[2]) / 100;
    return channels.map((channel, index) => channel * alpha + (background?.[index] ?? 0) * (1 - alpha));
  };
  const luminance = (channels) => channels.map((channel) => channel <= 0.04045
    ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05)
    / (Math.min(luminance(a), luminance(b)) + 0.05);
  assert.equal(contrast(rgb('#000000'), rgb('#ffffff')), 21, 'WCAG reference pair');
  assert.equal(contrast(rgb('#ffffff'), rgb('#ffffff')), 1, 'identical colors fail');
  const heroBackground = color(one(hero.attrs.class.split(/\s+/).filter((value) => value.startsWith('bg-')), 'hero background'));
  const declared = (kind, state) => {
    const base = classes.filter((value) => value.startsWith(`${kind}-`));
    const overrides = classes.filter((value) => value.startsWith(`${state}:${kind}-`));
    return one(overrides.length ? overrides.map((value) => value.slice(state.length + 1)) : base, `${state} ${kind} color`);
  };
  // This checks declarations linked to built HTML, not computed browser styles or visibility.
  const ratios = ['default', 'hover', 'focus-visible'].map((state) => {
    const background = color(declared('bg', state), heroBackground);
    const foreground = color(declared('text', state), background);
    const ratio = contrast(foreground, background);
    t.diagnostic(`${state}: ${ratio.toFixed(4)}:1 (${declared('text', state)} on ${declared('bg', state)})`);
    return { state, ratio };
  });
  for (const { state, ratio } of ratios) assert.ok(ratio >= 4.5, `${state} text contrast ${ratio.toFixed(4)}:1 must be >= 4.5:1`);
  assert.ok(classes.includes('focus-visible:ring-2'), 'keyboard focus ring retained');
  assert.ok(classes.includes('focus-visible:ring-offset-2'), 'focus ring separated from button');
  const ring = one(classes.filter((value) => /^focus-visible:ring-(?:\[#[\da-f]{6}\]|[a-z]+)$/.test(value)), 'focus ring color');
  const offset = one(classes.filter((value) => /^focus-visible:ring-offset-[a-z]+$/.test(value)), 'focus offset color');
  assert.ok(contrast(color(ring.replace('focus-visible:', '')), color(offset.replace('focus-visible:ring-offset-', 'bg-'))) >= 3,
    'focus ring contrasts with its declared offset');
});

test('two equal server-rendered learning cards have labelled headings and topics', () => {
  const pillars = one(byId('pilares'), 'one learning section');
  assert.equal(byTag(pillars, 'h2').length, 1);
  const cards = byTag(pillars, 'article');
  assert.deepEqual(cards.map((card) => card.attrs.id), ['blockchain', 'ia']);
  assert.equal(cards[0].attrs.class, cards[1].attrs.class, 'equal card treatment');
  for (const card of cards) {
    const heading = one(byTag(card, 'h3'), 'card H3');
    assert.equal(card.attrs['aria-labelledby'], heading.attrs.id);
    assert.match(card.attrs.class, /scroll-mt-/);
    assert.equal(byTag(card, 'li').length, 3);
    assert.ok(byTag(card, 'a').some((link) => link.attrs.href === '#contacto'));
  }
  assert.match(text(cards[0]), /fundamentos/i);
  assert.match(text(cards[0]), /contratos inteligentes/i);
  assert.match(text(cards[0]), /ecosistema/i);
  assert.match(text(cards[1]), /fundamentos/i);
  assert.match(text(cards[1]), /crítico/i);
});

test('desktop, mobile and footer share four links and every fragment resolves once', () => {
  const header = one(byTag(document, 'header'), 'one header');
  const footer = one(byTag(document, 'footer'), 'one footer');
  const navs = byTag(header, 'nav');
  assert.equal(navs.length, 2);
  for (const container of [...navs, footer]) {
    const links = byTag(container, 'a').filter((link) => link.attrs.href?.startsWith('#'));
    assert.deepEqual(links.map((link) => link.attrs.href), destinations);
    assert.deepEqual(links.map(text), labels);
  }
  for (const link of byTag(document, 'a').filter((link) => link.attrs.href?.startsWith('#'))) {
    one(byId(decodeURIComponent(link.attrs.href.slice(1))), `unique destination ${link.attrs.href}`);
  }
  const toggle = one(byId('menu-toggle'), 'mobile toggle');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.ok(toggle.attrs.class.split(/\s+/).includes('hidden'), 'enhancement-only toggle is hidden in SSR');
  const menu = one(byId(toggle.attrs['aria-controls']), 'mobile menu target');
  assert.ok(!menu.attrs.class.split(/\s+/).includes('hidden'), 'SSR mobile links are not hidden');
  assert.ok(menu.attrs.class.split(/\s+/).includes('md:hidden'), 'desktop keeps only its existing navigation');
});

test('homepage has six ordered blocks and exactly the three intended React islands', () => {
  assert.deepEqual(byTag(main, 'section').map((section) => section.attrs.id), ['inicio', 'trayectoria', 'pilares', 'formacion', 'faq', 'contacto']);
  for (const id of ['about', 'objetivos', 'desafios', 'servicios', 'recorrido', 'alianzas', 'equipo', 'galeria', 'testimonios']) {
    assert.equal(byId(id).length, 0, `legacy ${id} not rendered`);
  }
  assert.equal(byTag(document, 'astro-island').length, 3);
  const island = one(byTag(one(byId('inicio'), 'hero'), 'astro-island'), 'one hero island');
  assert.match(island.attrs['component-url'], /WorksWheelShowcase/);
  assert.equal(island.attrs.client, 'load');
  assert.ok(byTag(one(byId('inicio'), 'hero'), 'astro-island').includes(island));
  assert.doesNotMatch(island.attrs.props, /[A-Z]:\\|Users|Desktop|astro:assets|https?:\/\//i);
  assert.equal(byTag(document, 'video').length, 0);
  assert.equal(byTag(document, 'iframe').length, 0);
  const timeline = one(byTag(one(byId('trayectoria'), 'trajectory'), 'astro-island'), 'timeline island');
  assert.match(timeline.attrs['component-url'], /timeline/);
  assert.equal(timeline.attrs.client, 'load');
  assert.doesNotMatch(timeline.attrs.props, /[A-Z]:\\|Users|Desktop|astro:assets|https?:\/\//i);
});

test('formation is informational, FAQ is short and email remains actionable', () => {
  const formation = one(byId('formacion'), 'formation section');
  assert.equal(byTag(formation, 'article').length, 3);
  assert.match(text(formation), /consultar disponibilidad/i);
  assert.doesNotMatch(text(main), /inscripciones abiertas|certificad[oa]|validación curricular|incubación/i);
  const faq = one(byId('faq'), 'FAQ section');
  assert.equal(byTag(faq, 'details').length, 3);
  assert.equal(byTag(faq, 'summary').length, 3);
  const contact = one(byId('contacto'), 'contact section');
  assert.ok(byTag(contact, 'a').some((link) => link.attrs.href === 'mailto:contacto@chiledao.cl'));
  const community = byTag(contact, 'a').filter((link) => link.attrs.href !== 'mailto:contacto@chiledao.cl');
  assert.ok(community.length > 0 && community.length <= 3);
  for (const link of community) {
    assert.match(link.attrs.href, /^https:\/\//);
    assert.match(link.attrs.rel, /noopener/);
  }
});

test('metadata describes education in both subjects', () => {
  const description = one(all(document, (node) => node.tag === 'meta' && node.attrs.name === 'description'), 'description');
  assert.match(description.attrs.content, /educa/i);
  assert.match(description.attrs.content, /blockchain/i);
  assert.match(description.attrs.content, /inteligencia artificial/i);
  assert.equal(text(one(byTag(document, 'title'), 'title')), 'Chile DAO');
  const socialTitle = one(all(document, (node) => node.tag === 'meta' && node.attrs.property === 'og:title'), 'social title');
  assert.equal(socialTitle.attrs.content, 'Chile DAO');
  const socialDescription = one(all(document, (node) => node.tag === 'meta' && node.attrs.property === 'og:description'), 'social description');
  assert.equal(socialDescription.attrs.content, description.attrs.content);
});

test('public text and accessibility metadata use Chile DAO without internal branding', () => {
  // The existing contact domain is not a public wordmark.
  const forbiddenBrand = /\bDNO\b|\bNodo\b|ChileDAO(?!\.cl)/i;
  assert.doesNotMatch(text(document), forbiddenBrand);
  for (const node of all(document, () => true)) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (['alt', 'title', 'content'].includes(name) || name.startsWith('aria-')) {
        assert.doesNotMatch(value, forbiddenBrand, `public ${name}`);
      }
    }
  }
  const header = one(byTag(document, 'header'), 'header');
  const wordmark = one(byTag(header, 'a').filter((link) => link.attrs.href === '/'), 'header wordmark');
  assert.equal(text(wordmark), 'Chile DAO');
  const footer = one(byTag(document, 'footer'), 'footer');
  assert.equal(text(one(byTag(footer, 'h2'), 'footer wordmark')), 'Chile DAO');
});

function imageDimensions(bytes) {
  if (bytes.toString('ascii', 0, 4) === 'RIFF') {
    for (let offset = 12; offset + 8 < bytes.length;) {
      const chunk = bytes.toString('ascii', offset, offset + 4);
      const start = offset + 8;
      if (chunk === 'VP8X') return [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
      if (chunk === 'VP8 ') return [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(start + 1);
        return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      }
      const length = bytes.readUInt32LE(offset + 4);
      offset = start + length + length % 2;
    }
  } else {
    assert.equal(bytes.readUInt16BE(0), 0xffd8, 'JPEG source signature');
    for (let offset = 2; offset + 9 < bytes.length;) {
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  assert.fail('unsupported photograph dimensions');
}

function verifyImageFile(path, format, expectedWidth) {
  assert.match(path, /^\/_astro\/[\w.-]+\.(avif|webp)$/);
  const bytes = readFileSync(new URL(`../dist${path}`, import.meta.url));
  assert.ok(bytes.length > 32, `nonempty image: ${path}`);
  if (format === 'webp') {
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    if (expectedWidth) assert.equal(imageDimensions(bytes)[0], expectedWidth, 'encoded WebP width matches descriptor');
  } else {
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    assert.match(bytes.toString('ascii', 8, 32), /avif|avis/);
  }
}

test('formation retains six distinct responsive workshop photographs', () => {
  const assets = new Set();
  let eager = 0;
  let highPriority = 0;
  for (const [id, expected] of [
    ['formacion', ['block-camp-3', 'polkadot-chiledao', 'polkadot-chiledao-2', 'polkadot-chiledao-4', 'polkadot-chiledao-5', 'vendimiatech-workshop-chiledao']],
  ]) {
    const section = one(byId(id), id);
    const pictures = byTag(section, 'picture');
    assert.equal(pictures.length, expected.length, `${id} photograph count`);
    for (const [index, picture] of pictures.entries()) {
      const asset = expected[index];
      const image = one(byTag(picture, 'img'), `${id} image`);
      assert.match(image.attrs.src, new RegExp(`/${asset}\\.`));
      assets.add(asset);
      const trajectory = asset.startsWith('workshop-polkadot') || asset === 'block-camp-3';
      const original = `../src/assets/images/${trajectory ? 'trayectoria' : 'galeria'}/${asset}.${trajectory ? 'webp' : 'jpg'}`;
      const dimensions = imageDimensions(readFileSync(new URL(original, import.meta.url)));
      assert.deepEqual([Number(image.attrs.width), Number(image.attrs.height)], dimensions);
      assert.match(image.attrs.alt, /participantes|taller|expositor/i);
      assert.doesNotMatch(image.attrs.alt, /\bIA\b|inteligencia artificial/i);
      assert.equal(image.attrs.loading, id === 'inicio' && index === 0 ? 'eager' : 'lazy');
      assert.equal(image.attrs.fetchpriority ?? 'auto', id === 'inicio' && index === 0 ? 'high' : 'auto');
      eager += Number(image.attrs.loading === 'eager');
      highPriority += Number(image.attrs.fetchpriority === 'high');
      verifyImageFile(image.attrs.src, 'webp', dimensions[0]);
      const sources = byTag(picture, 'source');
      assert.deepEqual(sources.map((source) => source.attrs.type), ['image/avif', 'image/webp']);
      for (const node of [image, ...sources]) {
        assert.match(node.attrs.sizes, /\(.*\).*vw/);
        const variants = node.attrs.srcset.split(',').map((entry) => entry.trim().split(/\s+/));
        assert.deepEqual(variants.map(([, width]) => width), ['480w', '800w', '1200w']);
        for (const [path, width] of variants) {
          assert.match(width, /^\d+w$/);
          assert.match(path, new RegExp(`/${asset}\\.`));
          verifyImageFile(path, node.attrs.type === 'image/avif' ? 'avif' : 'webp', Number.parseInt(width, 10));
        }
      }
    }
    assert.equal(byTag(section, 'figcaption').length, expected.length, 'one factual caption per photograph');
  }
  assert.equal(assets.size, 6);
  assert.equal(eager, 0);
  assert.equal(highPriority, 0);
});

test('Polaroid offers six factual SSR prints and native navigation before enhancement', () => {
  const carousels = all(main, (node) => 'data-formation-polaroid' in node.attrs);
  assert.equal(carousels.length, 1);
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(html, /\[data-formation-polaroid\] \{ --formation-height:540px; height:var\(--formation-height\)/,
    'native SSR reserves the same height consumed by enhancement');
  assert.match(html, /\[data-polaroid-fallback\] picture \{[^}]*flex:1; min-height:0/,
    'native artwork absorbs remaining height rather than assuming caption or navigation wrapping');
  const ids = all(document, (node) => node.attrs.id).map((node) => node.attrs.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate IDs');
  for (const carousel of carousels) {
    assert.equal(carousel.attrs.role, 'region');
    assert.ok(carousel.attrs['aria-label']);
    const viewport = one(all(carousel, (node) => 'data-polaroid-fallback' in node.attrs), 'viewport');
    assert.equal(viewport.attrs.tabindex, '0');
    assert.equal(byTag(carousel, 'button').length, 0, 'no inert controls before hydration');
    assert.equal(byTag(carousel, 'a').length, 6, 'real native print links');
    assert.equal(byTag(carousel, 'figure').length, 6);
    assert.equal(byTag(carousel, 'article').length, 0);
  }
});

test('hero consumer removes controls rather than hiding duplicate interactive UI', () => {
  const source = readFileSync(new URL('../src/components/hero/WorksWheelShowcase.tsx', import.meta.url), 'utf8');
  assert.match(source, /showControls={false}/);
  const hero = one(byId('inicio'), 'hero');
  assert.equal(all(hero, node => 'data-work-index' in node.attrs || 'data-works-reset' in node.attrs).length, 0);
  assert.doesNotMatch(text(hero), /Volver al círculo|Ver afiche de archivo/);
});

test('six Timeline media expose honest large local image fallback links', () => {
  const timeline = one(byId('trayectoria'), 'trajectory');
  const links = all(timeline, node => 'data-timeline-image' in node.attrs);
  assert.equal(links.length, 6);
  for (const link of links) {
    assert.equal(link.tag, 'a');
    const image = one(byTag(link, 'img'), 'linked thumbnail');
    assert.ok(link.attrs['aria-label'].includes(image.attrs.alt));
    verifyImageFile(link.attrs.href, 'webp');
    const dimensions = imageDimensions(readFileSync(new URL(`../dist${link.attrs.href}`, import.meta.url)));
    assert.ok(Math.max(...dimensions) <= 1600);
    assert.ok(dimensions[0] <= Number(image.attrs.width) && dimensions[1] <= Number(image.attrs.height));
  }
});

test('Timeline actions are absent from the DOM without removing chronology or image links', () => {
  const timeline = one(byId('trayectoria'), 'trajectory');
  const heading = one(all(timeline, node => (node.attrs.class ?? '').split(/\s+/).includes('timeline-heading')), 'timeline heading');
  assert.equal(byTag(heading, 'button').length, 0, 'image dialog close button is preserved');
  assert.equal(byTag(timeline, 'a').filter(link => link.attrs.href === '#pilares').length, 0);
  assert.equal(all(timeline, node => (node.attrs.class ?? '').split(/\s+/).includes('timeline-actions')).length, 0);
  assert.doesNotMatch(text(timeline), /Leer sin animación|Ver recorrido animado|Continuar al aprendizaje/);
  assert.equal(byTag(one(byTag(timeline, 'ol'), 'chronology'), 'li').length, 7);
  assert.equal(all(timeline, node => 'data-timeline-image' in node.attrs).length, 6);
});

test('serialized archive has eight factual records, original dimensions and local responsive media', () => {
  const island = one(byTag(one(byId('inicio'), 'hero'), 'astro-island'), 'hero island');
  const revive = ([type, value]) => {
    if (type === 1) return value.map(revive);
    if (type === 0 && value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revive(entry)]));
    }
    return value;
  };
  const items = revive(JSON.parse(island.attrs.props).items);
  const ids = ['block-camp', 'bootcamp-avalanche-chiledao', 'buildbuddies-chiledao', 'open-web3-meetup-vol-2', 'ethglobal-tellus-chiledao', 'seminario-usach-chiledao', 'sub0-chiledao', 'vendimiatech-chiledao'];
  assert.deepEqual(items.map(item => item.id), ids);
  for (const item of items) {
    assert.equal(item.archive, true);
    assert.ok(item.title && item.category && item.description && item.alt);
    assert.deepEqual([item.width, item.height], imageDimensions(readFileSync(new URL(`../src/assets/images/works/${item.id}.jpg`, import.meta.url))));
    const widths = [320, 480, 800].filter(width => width <= item.width);
    verifyImageFile(item.image, 'webp', widths.at(-1));
    for (const format of ['avif', 'webp']) {
      const variants = item[format].split(',').map(entry => entry.trim().split(/\s+/));
      assert.deepEqual(variants.map(([, width]) => width), widths.map(width => `${width}w`));
      for (const [path, width] of variants) verifyImageFile(path, format, Number.parseInt(width));
    }
    assert.doesNotMatch(JSON.stringify(item), /https?:\/\/|[A-Z]:\\|price|teacher/i);
  }
  assert.match(items[5].description, /panel invitado, no como organizador/);
  assert.match(items[1].description, /pertenece al archivo/);
  assert.match(items[6].period, /2025/);
  assert.equal(items[7].period, '2026');
  for (const item of items.slice(0, 6)) assert.doesNotMatch(item.period ?? '', /20\d\d/);
});

test('fullscreen hero has one reusable intro within the wheel composition', () => {
  const hero = one(byId('inicio'), 'hero');
  const showcase = one(all(hero, node => 'data-works-showcase' in node.attrs), 'showcase');
  const intro = one(all(showcase, node => 'data-hero-intro' in node.attrs), 'intro inside showcase');
  assert.equal(byTag(intro, 'h1').length, 1);
  assert.equal(byTag(intro, 'a').length, 2);
  const source = readFileSync(new URL('../src/components/hero/HeroScroll.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /lg:grid-cols|max-w-\[var|<h1/);
  assert.match(source, /100svh/);
});

test('hero entrance preserves readable SSR copy and opacity-only photo ownership', () => {
  const hero = one(byId('inicio'), 'hero');
  const heading = one(byTag(hero, 'h1'), 'one unsplit SSR heading');
  assert.equal(text(heading), 'Aprende sobre Blockchain e Inteligencia Artificial');
  const reveals = all(hero, node => 'data-hero-reveal' in node.attrs);
  assert.equal(reveals.length, 2, 'eyebrow and paragraph entrance targets');
  for (const node of [heading, ...reveals]) {
    assert.doesNotMatch(node.attrs.style ?? '', /opacity:\s*0|visibility:\s*hidden|transform:/);
  }
  const wheel = readFileSync(new URL('../src/components/ui/works-wheel.tsx', import.meta.url), 'utf8');
  assert.match(wheel, /data-hero-photo/);
  assert.match(wheel, /face\.style\.transform = `scale/);
  const showcase = readFileSync(new URL('../src/components/hero/WorksWheelShowcase.tsx', import.meta.url), 'utf8');
  assert.match(showcase, /useHeroEntrance/);
  const css = readFileSync(new URL('../src/components/hero/HeroScroll.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /@keyframes hero-photo-fade/);
  assert.match(css, /await image\.decode\(\)/);
  assert.match(css, /duration: 800/);
  assert.doesNotMatch(css, /hero-orbit|--flight-|overflow:visible/);
  const entrance = readFileSync(new URL('../src/components/hero/useHeroEntrance.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entrance, /drawPhoto|orbits|ringScale|ringX|DOMMatrix/);
  assert.doesNotMatch(entrance, /photoAlpha|photoRemaining|data-hero-photo/);
});

test('timeline responsive layout preserves semantic chronology', () => {
  const timeline = one(byId('trayectoria'), 'trajectory');
  const list = one(byTag(timeline, 'ol'), 'one chronology in both modes');
  assert.equal(list.attrs['aria-label'], 'Hitos de Chile DAO');
  assert.equal(byTag(list, 'li').length, 7);
  assert.equal(byTag(list, 'picture').length, 6);
  assert.equal(all(timeline, node => 'data-timeline' in node.attrs)[0].attrs['data-enhanced'], undefined, 'SSR starts readable');
  for (const picture of byTag(list, 'picture')) {
    for (const source of byTag(picture, 'source')) {
      assert.equal(source.attrs.sizes, '(min-width: 1024px) 25vw, calc(100vw - 80px)');
    }
  }
  const source = readFileSync(new URL('../src/components/ui/timeline.tsx', import.meta.url), 'utf8');
  assert.match(source, /desktop: '\(min-width: 1024px\)', mobile: '\(max-width: 1023px\)'/);
  assert.match(source, /const axis = desktop \? 'scaleX' : 'scaleY'/);
  assert.match(source, /gsap\.getProperty\(line, axis\)/, 'reached state uses rendered line axis');
  assert.match(source, /if \(desktop\) entries\.forEach/, 'only desktop splits or hides text');
  assert.match(source, /delete root\.dataset\.mode/, 'mode ownership retires at cleanup');
  assert.match(source, /grid-template-columns: minmax\(0,1fr\)/);
  assert.match(source, /context\.conditions\?\.desktop && !context\.conditions\?\.tall/, 'height eligibility restricts desktop only');
  const mobileStyles = source.split('@media (max-width: 1023px) {')[1].split('@media (prefers-reduced-motion: reduce)')[0];
  assert.match(mobileStyles, /\.timeline-track::before \{ content: ''; position: absolute/);
  assert.match(mobileStyles, /\.milestone-dot \{ display: block/);
  assert.match(mobileStyles, /\.journey-line \{ display: block/);
  assert.doesNotMatch(mobileStyles, /\[data-enhanced\]/, 'static decoration is independent of JavaScript and motion');
});

test('trajectory fallback is chronological with seven milestones and six honest local media', () => {
  const timeline = one(byId('trayectoria'), 'trajectory');
  const list = one(byTag(timeline, 'ol'), 'one chronological list');
  const entries = byTag(list, 'li');
  assert.equal(entries.length, 7);
  assert.deepEqual(entries.map(entry => text(one(byTag(entry, 'h3'), 'milestone heading'))),
    ['BlockCamp', 'Workshop Polkadot', 'Avalanche Bootcamp', 'VendimiaTech', 'Dev3Pack', 'Blockchain Summit Latam', 'Próximo capítulo']);
  assert.deepEqual(entries.map(entry => text(one(all(entry, node => 'data-timeline-period' in node.attrs), 'period'))),
    ['Jul 2025', 'Sep 2025', 'Oct 2025', 'Mar 2026', 'May 2026', 'Ago 2026', 'Futuro']);
  const originals = ['trayectoria/block-camp-3.webp', 'trayectoria/workshop-polkadot-3.webp',
    'trayectoria/bootcamp-avalanche-chiledao.webp', 'trayectoria/vendimiatech-chiledao-2.webp',
    'galeria/dev3pack-chiledao.jpg', 'trayectoria/blockchain-summit-chiledao-2.webp'];
  assert.equal(byTag(list, 'picture').length, 6);
  for (const [index, entry] of entries.slice(0, 6).entries()) {
    const picture = one(byTag(entry, 'picture'), 'milestone media');
    const image = one(byTag(picture, 'img'), 'local image');
    assert.ok(image.attrs.src.includes(`/${originals[index].split('/').at(-1).split('.')[0]}.`), 'curated source media');
    assert.deepEqual([Number(image.attrs.width), Number(image.attrs.height)],
      imageDimensions(readFileSync(new URL(`../src/assets/images/${originals[index]}`, import.meta.url))));
    assert.match(image.attrs.alt, /participantes|taller|Afiche|grupo|trabajo|Logotipo/i);
    verifyImageFile(image.attrs.src, 'webp');
    for (const source of byTag(picture, 'source')) {
      for (const variant of source.attrs.srcset.split(',')) {
        const [path, width] = variant.trim().split(/\s+/);
        verifyImageFile(path, source.attrs.type === 'image/avif' ? 'avif' : 'webp', Number.parseInt(width));
      }
    }
  }
  assert.equal(byTag(entries[6], 'img').length, 0);
  assert.doesNotMatch(text(timeline), /2020|Product Storyline|Modern office|customer journeys/);
  assert.equal(byTag(timeline, 'h2').length, 1);
  const source = readFileSync(new URL('../src/components/ui/timeline.tsx', import.meta.url), 'utf8');
  assert.match(source, /Built using Hyperiux Vault: https:\/\/vault\.hyperiux\.com/);
  assert.doesNotMatch(source, /cdn\.21st|Modern office|Product Storyline|topJourneyData|bottomJourneyData|killAll/);
  assert.match(source, /SplitText\.create/);
  assert.match(source, /autoSplit: true/);
  const dependencies = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies;
  assert.equal(dependencies.gsap, '^3.13.0');
  assert.equal(dependencies.lenis, undefined);
  assert.equal(dependencies['@gsap/react'], undefined);
});

test('all ten authorized repository copies match the inspected SHA-256 values', () => {
  assert.equal(worksAssetCopies.length, 10);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  for (const [, destination, expected] of worksAssetCopies) {
    const bytes = readFileSync(new URL(`../${destination}`, import.meta.url));
    assert.equal(hash(bytes), expected, `copied ${destination}`);
  }
});

test('hero archive paints eight real SSR ring frames with progressive artwork links', () => {
  const hero = one(byId('inicio'), 'hero');
  assert.equal(all(hero, node => 'data-works-fallback' in node.attrs).length, 0, 'no vertical giant-poster replacement branch');
  const frames = all(hero, node => 'data-work-face' in node.attrs);
  assert.equal(frames.length, 8);
  const stage = one(all(hero, node => 'data-works-stage' in node.attrs), 'SSR archive stage');
  assert.equal(stage.attrs.role, 'group');
  assert.equal(stage.attrs.tabindex, undefined, 'unmeasured stage does not replace native link focus');
  assert.match(text(one(byId(stage.attrs['aria-describedby']), 'fallback archive instructions')), /Abre cada imagen/);
  for (const [index, frame] of frames.entries()) {
    assert.equal(byTag(frame, 'picture').length, 1);
    assert.ok(one(byTag(frame, 'a'), 'native artwork link').attrs.href.startsWith('/_astro/'));
    assert.equal(one(byTag(frame, 'a'), 'focusable SSR artwork link').attrs.tabindex, '0');
    assert.equal(one(byTag(frame, 'a'), 'same original image destination').attrs.href,
      one(byTag(frame, 'img'), 'original image').attrs.src);
    assert.match(one(byTag(frame, 'img'), 'factual artwork').attrs.alt, /Afiche/);
    assert.equal(one(byTag(frame, 'img'), 'eager artwork').attrs.loading, 'eager');
    assert.equal(one(byTag(frame, 'img'), 'priority').attrs.fetchpriority, index === 0 ? 'high' : 'auto');
    assert.doesNotMatch(one(byTag(frame, 'a'), 'SSR visible artwork').attrs.style ?? '', /opacity:\s*0/);
  }
  const picture = one(byTag(frames[0], 'picture'), 'first ring picture');
  const image = one(byTag(picture, 'img'), 'first artwork');
  const dimensions = imageDimensions(readFileSync(new URL('../src/assets/images/works/block-camp.jpg', import.meta.url)));
  assert.deepEqual([Number(image.attrs.width), Number(image.attrs.height)], dimensions);
  assert.equal(image.attrs.loading, 'eager');
  assert.equal(image.attrs.fetchpriority, 'high');
  assert.match(image.attrs.alt, /Block Camp/);
  verifyImageFile(image.attrs.src, 'webp', [320, 480, 800].filter(width => width <= dimensions[0]).at(-1));
  for (const source of byTag(picture, 'source')) {
    for (const variant of source.attrs.srcset.split(',')) {
      const [path, width] = variant.trim().split(/\s+/);
      verifyImageFile(path, source.attrs.type === 'image/avif' ? 'avif' : 'webp', Number.parseInt(width));
    }
  }
  const details = one(all(hero, node => 'data-product-details' in node.attrs), 'separate details');
  assert.equal(details.attrs['data-work-id'], 'block-camp');
  assert.match(text(details), /Block Camp.*Formación.*Aprendizaje sobre Blockchain y Web3/);
  assert.match(text(details), /Experiencia en formación y comunidad/);
  assert.match(text(details), /Afiche de archivo; no es una convocatoria vigente/);
  assert.ok(byTag(details, 'a').some(link => text(link) === 'Consultar formación' && link.attrs.href === '#contacto'));
  assert.equal(byTag(hero, 'button').length, 0, 'no inert controls advertised before initialization');
});

test('official wordmarks and minimal alias/tooling setup are integrated', () => {
  for (const tag of ['header', 'footer']) {
    const logo = one(byTag(one(byTag(document, tag), tag), 'img'), `${tag} logo`);
    assert.equal(logo.attrs.src, '/images/brand/chile-dao-light.svg');
    assert.equal(logo.attrs.alt, 'Chile DAO');
    assert.equal(logo.attrs.width, '1000');
    assert.equal(logo.attrs.height, '606');
  }
  for (const variant of ['light', 'dark']) {
    const svg = readFileSync(new URL(`../public/images/brand/chile-dao-${variant}.svg`, import.meta.url), 'utf8');
    assert.match(svg, /viewBox="0 0 1000 606"/);
    assert.doesNotMatch(svg, /\bDNO\b|\bNodo\b/i);
  }
  const config = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.compilerOptions.paths['@/*'], ['./src/*']);
  assert.equal(config.compilerOptions.jsx, 'react-jsx');
  assert.equal(config.compilerOptions.jsxImportSource, 'react');
  const components = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8'));
  assert.equal(components.rsc, false);
  assert.equal(components.tsx, true);
  assert.equal(components.aliases.ui, '@/components/ui');
  assert.equal(components.tailwind.css, 'src/styles/global.css');
});

test('formation themes use exact photo identities without replacing factual alternatives', () => {
  const formation = one(byId('formacion'), 'formation');
  assert.equal(text(one(byTag(formation, 'h2'), 'formation heading')), 'Aprendizaje práctico para personas y equipos');
  assert.deepEqual(byTag(formation, 'h3').map(text), ['Talleres de Blockchain y Web3', 'Bootcamps para desarrollar proyectos Web3', 'Capacitación para equipos']);
  const expected = [
    ['block-camp-3', 'Blockchain en la práctica', 'Explora cómo funciona Blockchain y dónde puede aplicarse.'],
    ['polkadot-chiledao', 'Aprende en comunidad', 'Comparte preguntas y conecta con otras personas interesadas en Web3.'],
    ['polkadot-chiledao-2', 'Conecta con el ecosistema Web3', 'Acércate a una comunidad donde aprender y explorar proyectos.'],
    ['polkadot-chiledao-4', 'Preguntas que abren posibilidades', 'Intercambia perspectivas para comprender las tecnologías descentralizadas.'],
    ['polkadot-chiledao-5', 'Fundamentos para avanzar', 'Comprende Blockchain antes de profundizar en protocolos y proyectos Web3.'],
    ['vendimiatech-workshop-chiledao', 'De las ideas a la práctica', 'Explora el aprendizaje mediante experimentación y prototipos.'],
  ];
  const revive = ([type, value]) => type === 1 ? value.map(revive)
    : type === 0 && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revive(entry)])) : value;
  const island = one(byTag(formation, 'astro-island'), 'formation island');
  const slides = revive(JSON.parse(island.attrs.props).slides);
  assert.equal(slides.length, 6);
  for (const [index, figure] of byTag(formation, 'figure').entries()) {
    const [asset, title, caption] = expected[index];
    const image = one(byTag(figure, 'img'), 'photo');
    assert.ok(image.attrs.src.includes(`/${asset}.`));
    assert.equal(slides[index].title, title, 'enhanced title serialized for the corresponding photo');
    assert.equal(slides[index].caption, caption);
    assert.equal(slides[index].alt, image.attrs.alt);
    assert.ok(text(figure).includes(caption), 'existing SSR fallback exposes marketing caption');
    assert.notEqual(image.attrs.alt, caption);
    assert.doesNotMatch(image.attrs.alt, /Foto \d|Explora|Comparte preguntas|Acércate/);
  }
  const contact = one(byId('contacto'), 'contact');
  assert.equal(text(one(byTag(contact, 'h2'), 'contact heading')), 'Da el siguiente paso en tu aprendizaje.');
  assert.ok(byTag(contact, 'a').some(link => text(link) === 'Consultar talleres y capacitación' && link.attrs.href === 'mailto:contacto@chiledao.cl'));
  assert.ok(byTag(contact, 'a').some(link => text(link) === 'Conocer la comunidad' && link.attrs.href === 'https://linktr.ee/web3chile'));
});

test('Timeline captions are separate media fields and small wheel frames have no opaque plate', () => {
  const source = readFileSync(new URL('../src/components/ui/timeline.tsx', import.meta.url), 'utf8');
  assert.match(source, /caption: string/);
  assert.match(source, /item\.media\.caption/);
  assert.doesNotMatch(source, /: item\.media\.alt/);
  const wheel = readFileSync(new URL('../src/components/ui/works-wheel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(wheel, /size-full overflow-hidden rounded-lg bg-navy-soft shadow-lg/);
  assert.match(wheel, /data-work-face/);
});
