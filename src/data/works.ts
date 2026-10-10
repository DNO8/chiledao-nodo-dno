export interface Work {
  id: string;
  title: string;
  category: string;
  period?: string;
  description: string;
  alt: string;
  archive: true;
}

// Dates describe the supplied artwork, not verified attendance or availability.
export const works: Work[] = [
  {
    id: 'block-camp', title: 'Block Camp', category: 'Formación',
    period: '14, 15 y 18 de julio · año no indicado',
    description: 'Aprendizaje sobre Blockchain y Web3 para construir un proyecto.',
    alt: 'Afiche de Block Camp sobre aprendizaje de Blockchain y Web3.', archive: true,
  },
  {
    id: 'bootcamp-avalanche-chiledao', title: 'Bootcamp Blockchain — Avalanche', category: 'Bootcamp',
    period: '6 al 14 de octubre · año no indicado',
    description: 'Bootcamp online de Blockchain, camino al Hackathon Web3 Chile. La inscripción del afiche pertenece al archivo; consulta próximas actividades.',
    alt: 'Afiche del Bootcamp Blockchain con Avalanche y Chile DAO.', archive: true,
  },
  {
    id: 'buildbuddies-chiledao', title: 'Build Buddies', category: 'Encuentro comunitario',
    description: 'Encuentro en Santiago presentado en una gráfica con Chile DAO y Meta Pool.',
    alt: 'Afiche de Build Buddies en Santiago con Chile DAO y Meta Pool.', archive: true,
  },
  {
    id: 'open-web3-meetup-vol-2', title: 'Open Web3 Meetup · Vol. 2', category: 'Meetup',
    period: '10 de agosto · año no indicado',
    description: 'Encuentro sobre Web3 anunciado en el Parque Padre Hurtado.',
    alt: 'Afiche de Open Web3 Meetup volumen dos en el Parque Padre Hurtado.', archive: true,
  },
  {
    id: 'ethglobal-tellus-chiledao', title: 'Cowork con ETHGlobal', category: 'Cowork',
    description: 'Propuesta de cowork en Santiago con ETHGlobal, Chile DAO y Tellus Cooperative.',
    alt: 'Afiche de cowork con ETHGlobal, Chile DAO y Tellus Cooperative en Santiago.', archive: true,
  },
  {
    id: 'seminario-usach-chiledao', title: 'IA y tecnologías disruptivas', category: 'Seminario',
    period: '8 de julio · año no indicado',
    description: 'Seminario sobre innovación, negocios y futuro. Chile DAO aparece como panel invitado, no como organizador.',
    alt: 'Afiche del seminario IA y tecnologías disruptivas con Chile DAO como panel invitado.', archive: true,
  },
  {
    id: 'sub0-chiledao', title: 'sub0 · Builder Party Chile', category: 'Encuentro',
    period: '11 de noviembre de 2025',
    description: 'Encuentro para builders anunciado como Builder Party Chile de sub0.',
    alt: 'Afiche de sub0 Builder Party Chile del 11 de noviembre de 2025.', archive: true,
  },
  {
    id: 'vendimiatech-chiledao', title: 'Crypto Vendimia · Hackathon', category: 'Hackathon',
    period: '2026',
    description: 'Hackathon sobre aplicaciones, experimentación con IA y emprendimiento tecnológico.',
    alt: 'Afiche de Crypto Vendimia Hackathon 2026 sobre IA y emprendimiento tecnológico.', archive: true,
  },
];
