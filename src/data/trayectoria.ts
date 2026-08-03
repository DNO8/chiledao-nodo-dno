export interface TrayectoriaItem {
  period: string;
  title: string;
  description: string;
  images: string[];
}

export const trayectoria: TrayectoriaItem[] = [
  {
    period: "Jul 2025",
    title: "BlockCamp",
    description: "Encuentro práctico de aprendizaje sobre blockchain y sus aplicaciones.",
    images: ["block-camp-3", "block-camp", "block-camp-2"],
  },
  {
    period: "Sep 2025",
    title: "Workshop Polkadot",
    description: "Taller práctico para aprender a construir sobre el ecosistema Polkadot.",
    images: ["workshop-polkadot-3", "workshop-polkadot", "workshop-polkadot-2"],
  },
  {
    period: "Oct 2025",
    title: "Avalanche Bootcamp",
    description: "Bootcamp intensivo de formación en Avalanche y aplicaciones descentralizadas.",
    images: ["bootcamp-avalanche-chiledao-2", "bootcamp-avalanche-chiledao", "bootcamp-avalanche-chiledao-3"],
  },
  {
    period: "Mar 2026",
    title: "VendimiaTech",
    description: "Colaboración conjunta que une tecnología, comunidad e identidad local.",
    images: ["vendimiatech-chiledao-2", "vendimiatech-chiledao", "vendimiatech-chiledao-3"],
  },
  {
    period: "May 2026",
    title: "Dev3Pack",
    description: "Sede local de un hackathon global, conectando a Chile con la comunidad internacional.",
    images: ["dev3pack-hackathon-chiledao", "dev3pack-hackathon-chiledao-2", "dev3pack-hackathon-chiledao-3"],
  },
  {
    period: "Ago 2026",
    title: "Blockchain Summit Latam",
    description: "Presencia en la cumbre latinoamericana de blockchain para conectar el ecosistema chileno con la región.",
    images: ["blockchain-summit-chiledao-2", "blockchain-summit-chiledao", "blockchain-summit-chiledao-3"],
  },
  {
    period: "Futuro",
    title: "Próximo capítulo",
    description: "Estamos abiertos a nuevas colaboraciones: sigamos promoviendo el ecosistema Web3 y blockchain en Chile y sus regiones.",
    images: [],
  },
];
