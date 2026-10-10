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
    title: "Talleres de Blockchain y Web3",
    description:
      "Comprende los fundamentos de Blockchain y explora sus aplicaciones mediante aprendizaje práctico. Un punto de partida para acercarte a Web3 y plantear tus primeras preguntas.",
  },
  {
    code: "tx_02",
    category: "educación",
    title: "Bootcamps para desarrollar proyectos Web3",
    description:
      "Profundiza en contratos inteligentes, protocolos y gobernanza on-chain con un enfoque de proyecto. Conversemos sobre tu experiencia y el alcance que necesitas explorar.",
  },
  {
    code: "tx_03",
    category: "educación",
    title: "Capacitación para equipos",
    description:
      "Fortalece los conocimientos de tu equipo sobre Blockchain, Web3 y tecnologías emergentes para comprender sus posibilidades con criterio. Consulta un enfoque de formación según las necesidades de tu organización.",
  },
];
