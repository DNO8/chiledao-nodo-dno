export interface Site {
  orgName: string;
  legalStatus: string;
  statusDescription: string;
  tagline: string;
  contactEmail: string;
  externalUrls: { label: string; url: string }[];
}

export const site: Site = {
  orgName: "ChileDAO",
  legalStatus: "PRECOOPERATIVA",
  statusDescription:
    "Comunidad tecnológica en proceso de conformación cooperativa, sin fines de lucro y de participación abierta.",
  tagline:
    "ChileDAO educa, incuba y articula comunidad para conectar el talento chileno con la Web3.",
  contactEmail: "contacto@chiledao.cl",
  externalUrls: [
    { label: "Email", url: "mailto:contacto@chiledao.cl" },
    { label: "Linktree", url: "https://linktr.ee/web3chile" },
    { label: "Discord landing", url: "discord.gg/8Axk28NzWB" },
    { label: "Discord participa", url: "https://discord.gg/sUpWey4U" },
    {
      label: "WhatsApp group",
      url: "https://chat.whatsapp.com/IU38ZwHD8MIFMrB11WbNxt",
    },
    {
      label: "MBA USACH article",
      url: "https://www.mbausach.cl/2026/07/15/inteligencia-artificial-innovacion-y-networking-marcaron-el-seminario-de-tecnologias-disruptivas-organizado-por-el-mba-usach/",
    },
    {
      label: "Sketchfab embed",
      url: "https://sketchfab.com/models/24a944c2999d4e9aaee4a36e5bb0588b/embed",
    },
  ],
};
