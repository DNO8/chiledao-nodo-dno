import { getImage } from 'astro:assets';
import blockCamp from '../assets/images/trayectoria/block-camp-3.webp';
import polkadot from '../assets/images/trayectoria/workshop-polkadot-3.webp';
import avalanche from '../assets/images/trayectoria/bootcamp-avalanche-chiledao.webp';
import vendimia from '../assets/images/trayectoria/vendimiatech-chiledao-2.webp';
import dev3pack from '../assets/images/galeria/dev3pack-chiledao.jpg';
import summit from '../assets/images/trayectoria/blockchain-summit-chiledao-2.webp';
import { trayectoria } from '../data/trayectoria';

// Curated media roles are distinct from milestone dates. Never infer a date
// or identify a photograph from an asset filename. Only public URLs cross SSR.
export async function getTimelineItems() {
  const media = [
    { source: blockCamp, alt: 'Participantes de BlockCamp con materiales impresos', caption: 'Aprender los fundamentos de Blockchain para explorar proyectos Web3.', kind: 'photo' },
    { source: polkadot, alt: 'Participantes del taller Polkadot trabajando con computadores', caption: 'Explorar protocolos Web3: del contrato inteligente a la gobernanza on-chain.', kind: 'photo' },
    { source: avalanche, alt: 'Afiche de archivo del Avalanche Bootcamp de Chile DAO', caption: 'Profundizar en protocolos Web3 con un enfoque de proyecto.', kind: 'poster' },
    { source: vendimia, alt: 'Grupo de participantes de VendimiaTech', caption: 'Explorar ideas mediante experimentación y prototipos en comunidad.', kind: 'photo' },
    { source: dev3pack, alt: 'Sesión de trabajo de Dev3Pack', caption: 'Conectar con una comunidad internacional para explorar proyectos Web3.', kind: 'photo' },
    { source: summit, alt: 'Logotipo de Blockchain Summit Latam', caption: 'Conocer el ecosistema Blockchain y sus espacios de encuentro.', kind: 'logo' },
  ] as const;
  return Promise.all(trayectoria.map(async (item, index) => {
    const record = media[index];
    const base = { id: `milestone-${index}`, period: item.period, title: item.title,
      content: item.description, future: item.period === 'Futuro' };
    if (!record) return { ...base, media: null };
    const src = record.source;
    const fullWidth = Math.min(src.width, 1600, Math.floor(1600 * src.width / src.height));
    const full = await getImage({ src, width: fullWidth, format: 'webp' });
    const widths = [320, 480, 800].filter(width => width <= src.width);
    const variants = await Promise.all(widths.map(async width => {
      const [webp, avif] = await Promise.all([
        getImage({ src, width, format: 'webp' }), getImage({ src, width, format: 'avif' }),
      ]);
      return { width, webp: webp.src, avif: avif.src };
    }));
    return { ...base, media: { image: variants.at(-1)!.webp, alt: record.alt,
      caption: record.caption, kind: record.kind, width: src.width, height: src.height,
      fullSrc: full.src, fullWidth, fullHeight: Math.round(src.height * fullWidth / src.width),
      webp: variants.map(value => `${value.webp} ${value.width}w`).join(', '),
      avif: variants.map(value => `${value.avif} ${value.width}w`).join(', ') } };
  }));
}
