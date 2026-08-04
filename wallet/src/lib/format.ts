import type { Stroops } from "./client";

export const STROOPS_PER_XLM = 10_000_000n;
export const DECIMALS = 7;

/** "1240.5" -> 12405000000n. Throws on anything that is not a clean amount. */
export function parseAmount(input: string): Stroops {
  const trimmed = input.trim();
  // Accept both separators: pt-BR keyboards produce a comma.
  const normalised = trimmed.replace(",", ".");
  if (
    !/^\d*(\.\d*)?$/.test(normalised) ||
    normalised === "" ||
    normalised === "."
  ) {
    throw new Error("Use apenas dígitos e um separador decimal.");
  }
  const [whole, frac = ""] = normalised.split(".");
  if (frac.length > DECIMALS) {
    throw new Error(`XLM tem ${DECIMALS} casas decimais.`);
  }
  return (
    BigInt(whole || "0") * STROOPS_PER_XLM +
    BigInt(frac.padEnd(DECIMALS, "0") || "0")
  );
}

/** 12405000000n -> "1,240.5000000" */
export function formatAmount(
  amount: Stroops,
  opts: { decimals?: number; group?: boolean } = {},
): string {
  const { decimals = DECIMALS, group = true } = opts;
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(DECIMALS, "0");
  // pt-BR: dot groups thousands, comma separates decimals.
  const wholeStr = group
    ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")
    : whole.toString();
  const fracStr = decimals > 0 ? `,${frac.slice(0, decimals)}` : "";
  return `${negative ? "-" : ""}${wholeStr}${fracStr}`;
}

/** Splits an amount so the UI can de-emphasise the fractional tail. */
export function splitAmount(amount: Stroops): { whole: string; frac: string } {
  const formatted = formatAmount(amount);
  const [whole, frac = ""] = formatted.split(",");
  return { whole, frac };
}

export function truncateAddress(address: string, edge = 5): string {
  if (address.length <= edge * 2 + 3) return address;
  return `${address.slice(0, edge)}…${address.slice(-edge)}`;
}

/** Rough shape check for a Stellar public key — enough to guard a form. */
export function isStellarAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value.trim());
}

export function formatCount(n: number): string {
  return n.toLocaleString("pt-BR");
}

export function formatLedger(n: number): string {
  return n.toLocaleString("pt-BR");
}
