export interface Servicio {
  code: string;
  category: string;
  title: string;
  description: string;
  link?: string;
}

export const servicios: Servicio[] = [
  {
    code: "tx_01",
    category: "educación",
    title: "Programas y talleres",
    description:
      "Formación práctica en blockchain, gestión de proyectos Web3 y habilidades digitales, diseñada junto a expertos de la industria para todos los niveles.",
  },
  {
    code: "tx_02",
    category: "incubación",
    title: "Incubación de proyectos",
    description:
      "Mentoría, recursos y un entorno colaborativo para transformar ideas en proyectos reales dentro del ecosistema digital chileno.",
  },
  {
    code: "tx_03",
    category: "alianzas",
    title: "Colaboración institucional",
    description:
      "Alianzas estratégicas con organizaciones que buscan innovar, capacitar a sus equipos y adoptar tecnologías emergentes con respaldo.",
  },
  {
    code: "tx_01.1",
    category: "educación",
    title: "Ejecución de Torneos de Innovación Abierta",
    description:
      "Se ha estructurado un modelo de gobernanza compartida para la planificación y ejecución llave en mano de tres hitos competitivos de alcance nacional: la Hackathon Web3 Chile (junto a Campus On Chain), la Hackathon Vendimia Tech Chile (junto a Open Beauchef y Vendimia Tech) y la Hackathon Dev3Pack Chile (junto a la USACH y Dev3Pack).",
  },
  {
    code: "tx_02.1",
    category: "incubación",
    title: "Nodo Zero",
    description:
      "Empresa desarrolladora de Software en WEB 3.0 que consolida alianzas y educación en universidades, hoy con foco en potenciar el MBA de USACH con eventos colababorativos como fue el seminario de tecnologias disruptivas 2026.",
    link: "https://www.mbausach.cl/2026/07/15/inteligencia-artificial-innovacion-y-networking-marcaron-el-seminario-de-tecnologias-disruptivas-organizado-por-el-mba-usach/",
  },
  {
    code: "tx_03.1",
    category: "alianzas",
    title: "Validación Curricular Mutua y Respaldo de Idoneidad Pedagógica",
    description:
      "Se han establecido mesas de trabajo técnico con las autoridades de la USACH y la Universidad de Chile (Open Beauchef) para el desarrollo de acuerdos de validación curricular mutua. Bajo esta articulación, los comités académicos de los aliados respaldan e indexan la idoneidad técnica de los cursos virtuales de inteligencia artificial y los bootcamps dictados por la Precooperativa.",
  },
  {
    code: "tx_01.2",
    category: "educación",
    title: "Capacitación en Protocolos Web3",
    description:
      "Lideramos programas de formación técnica especializada en arquitecturas de alto rendimiento como Avalanche, Stellar y Polkadot. Desarrollamos rutas de aprendizaje desde el despliegue de smart contracts hasta la gobernanza on-chain, creando las competencias necesarias para que tu organización participe activamente en la economía descentralizada.",
  },
  {
    code: "tx_02.2",
    category: "incubación",
    title: "Aceleración de Proyectos Tech",
    description:
      "¿Tienes una solución en fase de prototipo? Conectamos tu proyecto con nuestra red de nodos y mentores para validar, auditar y escalar tu desarrollo dentro de la economía digital.",
  },
  {
    code: "tx_03.2",
    category: "alianzas",
    title: "Partnerships de Innovación Abierta",
    description:
      "¿Buscas una alianza estratégica? Conversemos sobre cómo articular una hackathon o un evento de vinculación tecnológica que posicione a tu institución en la vanguardia del ecosistema Web3.",
  },
];
