/** Round to 2 decimals (cents/shares display precision). Shared by the sizing modules. */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
