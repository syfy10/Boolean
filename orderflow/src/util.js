export function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return value > 0 ? hi : lo;
  return Math.min(hi, Math.max(lo, value));
}

export function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
