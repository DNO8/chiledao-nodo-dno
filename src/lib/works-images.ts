import { getImage } from 'astro:assets';
import blockCamp from '../assets/images/works/block-camp.jpg';
import bootcamp from '../assets/images/works/bootcamp-avalanche-chiledao.jpg';
import buddies from '../assets/images/works/buildbuddies-chiledao.jpg';
import meetup from '../assets/images/works/open-web3-meetup-vol-2.jpg';
import cowork from '../assets/images/works/ethglobal-tellus-chiledao.jpg';
import seminar from '../assets/images/works/seminario-usach-chiledao.jpg';
import sub0 from '../assets/images/works/sub0-chiledao.jpg';
import vendimia from '../assets/images/works/vendimiatech-chiledao.jpg';
import { works } from '../data/works';

// Server-only optimization. The island receives URLs and intrinsic dimensions,
// never ImageMetadata, filesystem paths, or the Astro image service.
export async function getWorksWithImages() {
  const sources = [blockCamp, bootcamp, buddies, meetup, cowork, seminar, sub0, vendimia];
  return Promise.all(works.map(async (work, index) => {
    const src = sources[index];
    const widths = [320, 480, 800].filter(width => width <= src.width);
    const variants = await Promise.all(widths.map(async width => {
      const [webp, avif] = await Promise.all([
        getImage({ src, width, format: 'webp' }),
        getImage({ src, width, format: 'avif' }),
      ]);
      return { width, webp: webp.src, avif: avif.src };
    }));
    return {
      ...work,
      image: variants.at(-1)!.webp,
      width: src.width,
      height: src.height,
      webp: variants.map(value => `${value.webp} ${value.width}w`).join(', '),
      avif: variants.map(value => `${value.avif} ${value.width}w`).join(', '),
    };
  }));
}
