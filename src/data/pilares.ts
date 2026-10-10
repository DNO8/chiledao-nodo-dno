export interface Pilar {
  id: string;
  code: string;
  title: string;
  description: string;
  topics: string[];
}

export const pilares: Pilar[] = [
  {
    id: "blockchain",
    code: "01 · Blockchain",
    title: "Blockchain",
    description:
      "Comprende cómo funcionan las redes descentralizadas y qué posibilidades abren para personas y organizaciones.",
    topics: [
      "Fundamentos de blockchain y Web3",
      "Contratos inteligentes y sus aplicaciones",
      "Protocolos y ecosistema: Avalanche, Stellar y Polkadot",
    ],
  },
  {
    id: "ia",
    code: "02 · Inteligencia Artificial",
    title: "Inteligencia Artificial",
    description:
      "Explora la inteligencia artificial desde una mirada educativa: comprender sus capacidades es tan importante como reconocer sus límites.",
    topics: [
      "Fundamentos de inteligencia artificial",
      "Usos útiles en el trabajo y el aprendizaje",
      "Pensamiento crítico: límites y evaluación de resultados",
    ],
  },
];
