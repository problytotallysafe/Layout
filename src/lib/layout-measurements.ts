const FRACTION_EPSILON = 1e-9;

function reduceFraction(numerator: number, denominator: number) {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : Math.abs(a);
  const divisor = gcd(numerator, denominator) || 1;
  return [numerator / divisor, denominator / divisor] as const;
}

export function formatLength(inches: number) {
  const sign = inches < 0 ? "-" : "";
  const eighths = Math.max(0, Math.round(Math.abs(inches) * 8));
  const feet = Math.floor(eighths / 96);
  const remainder = eighths % 96;
  const wholeInches = Math.floor(remainder / 8);
  const fraction = remainder % 8;
  let fractionLabel = "";
  if (fraction) {
    const [numerator, denominator] = reduceFraction(fraction, 8);
    fractionLabel = ` ${numerator}/${denominator}`;
  }
  return `${sign}${feet}′ ${wholeInches}${fractionLabel}″`;
}

function parseInchesPart(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/"/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ");
  if (!cleaned) return 0;

  const mixed = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    if (!Number.isFinite(whole) || denominator <= 0) return null;
    const fraction = numerator / denominator;
    return whole < 0 ? whole - fraction : whole + fraction;
  }

  const fraction = cleaned.match(/^([+-]?\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator <= 0) return null;
    return numerator / denominator;
  }

  const decimal = Number(cleaned);
  return Number.isFinite(decimal) ? decimal : null;
}

export function parseLength(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[′’]/g, "'")
    .replace(/[″”]/g, '"')
    .replace(/feet|foot|ft\.?/g, "'")
    .replace(/inches|inch|in\.?/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;

  const feetIndex = normalized.indexOf("'");
  if (feetIndex < 0) return parseInchesPart(normalized);

  const feetRaw = normalized.slice(0, feetIndex).trim();
  const feet = Number(feetRaw);
  if (!Number.isFinite(feet)) return null;

  const inches = parseInchesPart(normalized.slice(feetIndex + 1));
  if (inches == null) return null;

  const result = feet * 12 + (feet < 0 ? -Math.abs(inches) : inches);
  return Math.abs(result) < FRACTION_EPSILON ? 0 : result;
}
