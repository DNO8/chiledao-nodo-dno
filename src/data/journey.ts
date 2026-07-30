export interface JourneySlide {
  region: string;
  eyebrow: string;
  heading: string;
  description: string;
  image: string;
}

export const journey: JourneySlide[] = [
  {
    region: "Atacama",
    eyebrow: "Explorar",
    heading: "La innovación comienza con una pregunta.",
    description:
      "Exploramos nuevas tecnologías y desafíos reales para abrir posibilidades donde antes no las había.",
    image: "avalanche-workshop-chiledao",
  },
  {
    region: "Rapa Nui",
    eyebrow: "Compartir",
    heading: "El conocimiento crece cuando se comparte.",
    description:
      "Construimos comunidad, identidad y colaboración respetuosa con los territorios.",
    image: "dev3pack-chiledao",
  },
  {
    region: "Zona Central",
    eyebrow: "Conectar",
    heading: "Las soluciones nacen cuando conectamos capacidades.",
    description:
      "Acercamos talento, universidades, pymes, instituciones y comunidades para crear valor en conjunto.",
    image: "polkadot-chiledao-grupal-6",
  },
  {
    region: "Sur",
    eyebrow: "Crear",
    heading: "Transformamos conocimiento en acción.",
    description:
      "Formación, experimentación y prototipos convierten las ideas en soluciones que se pueden probar.",
    image: "polkadot-chiledao-grupal-7",
  },
  {
    region: "Patagonia",
    eyebrow: "Descentralizar",
    heading: "El talento no depende de la distancia.",
    description:
      "Impulsamos oportunidades y redes más allá de los centros tradicionales de innovación.",
    image: "vendimiatech-grupal-2",
  },
  {
    region: "Antártica",
    eyebrow: "Proyectar",
    heading: "Cooperamos para enfrentar los desafíos del futuro.",
    description:
      "Ciencia, sostenibilidad y tecnología orientadas a un futuro que se construye con mirada de largo plazo.",
    image: "vendimiatech-workshop-chiledao",
  },
];
