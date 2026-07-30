export interface Testimonio {
  id: string;
  label: string;
  hasShort: boolean;
}

export const testimonios: Testimonio[] = [
  { id: "testimonio1", label: "Testimonio 1", hasShort: false },
  { id: "testimonio2", label: "Testimonio 2", hasShort: true },
  { id: "testimonio3", label: "Testimonio 3", hasShort: true },
];
