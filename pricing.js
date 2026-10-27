/**
 * DeepSeek API token prices, in CNY per 1,000,000 tokens.
 *
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * Peak hours are 09:00-12:00 and 14:00-18:00 Beijing time (UTC+8),
 * Monday-Friday, excluding Chinese public holidays; every other instant is
 * off-peak. Chinese public holidays are not modelled here.
 *
 * `input` is the cache-miss input price. DeepSeek does not publish a separate
 * cache-write price, so a reported cache-write token is charged at that same
 * cache-miss rate.
 *
 * A new model is priced only when it has a rate card. An unknown model is
 * reported as an estimate (Flash rates) and named in the client tooltip, so a
 * missing card is visible instead of silently treated as exact.
 */

const FLASH = {
  peak: { input: 2, cacheRead: 0.04, output: 8 },
  offPeak: { input: 1, cacheRead: 0.02, output: 4 },
};

const V4_PRO = {
  peak: { input: 9, cacheRead: 0.3, output: 27 },
  offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
};

/** Exact ids that resolve without a pattern probe. */
export const DEFAULT_MODELS = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4.1-flash': FLASH,
  'deepseek-v4.1-flash-1017': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-v4-pro': V4_PRO,
};

/** A model with no card is priced at Flash rates and marked estimated. */
export const FALLBACK_MODEL = 'deepseek-flash';

/** Family patterns for ids that are not listed exactly. */
const ROUTES = [
  { pattern: /^deepseek-v4-pro(?:$|[-._])/i, base: 'deepseek-v4-pro' },
  { pattern: /^deepseek-(?:v4(?:[._]1)?-flash|flash)(?:$|[-._])/i, base: 'deepseek-flash' },
];

/**
 * Validate one peak/off-peak rate card.
 * @param {unknown} value
 * @returns {{ input: number, cacheRead: number, output: number } | null}
 */
function normalizeRates(value) {
  if (typeof value !== 'object' || value === null) return null;
  const { input, cacheRead, output } = value;
  for (const amount of [input, cacheRead, output]) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  }
  return { input, cacheRead, output };
}

/**
 * Validate one model card.
 * @param {unknown} value
 * @returns {{ peak: { input: number, cacheRead: number, output: number }, offPeak: { input: number, cacheRead: number, output: number } } | null}
 */
export function normalizeModelCard(value) {
  if (typeof value !== 'object' || value === null) return null;
  const peak = normalizeRates(value.peak);
  const offPeak = normalizeRates(value.offPeak);
  if (peak === null || offPeak === null) return null;
  return { peak, offPeak };
}

/**
 * Reject model ids that would mutate a plain object's prototype.
 * @param {string} id
 * @returns {boolean}
 */
export function isUnsafeModelId(id) {
  return id === '__proto__' || id === 'constructor' || id === 'prototype';
}

/**
 * Merge built-in cards with an override table.
 * @param {unknown} overrides
 * @returns {{ models: Record<string, { peak: { input: number, cacheRead: number, output: number }, offPeak: { input: number, cacheRead: number, output: number } }>, invalid: string[] }}
 */
export function normalizeModels(overrides) {
  const models = { ...DEFAULT_MODELS };
  const invalid = [];
  if (typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)) {
    for (const id of Object.keys(overrides).sort()) {
      if (isUnsafeModelId(id)) {
        invalid.push(id);
        continue;
      }
      const card = normalizeModelCard(overrides[id]);
      if (card === null) {
        invalid.push(id);
        continue;
      }
      models[id] = card;
    }
  }
  return { models, invalid };
}

/**
 * Resolve the rate card for one exact model id.
 * @param {ReturnType<typeof normalizeModels>['models']} models
 * @param {string} model
 * @returns {{ peak: { input: number, cacheRead: number, output: number }, offPeak: { input: number, cacheRead: number, output: number }, estimated: boolean }}
 */
export function priceFor(models, model) {
  if (typeof model === 'string' && model.length > 0 && Object.hasOwn(models, model)) {
    return { ...models[model], estimated: false };
  }
  for (const route of ROUTES) {
    if (route.pattern.test(model)) {
      return { ...(models[route.base] ?? DEFAULT_MODELS[route.base]), estimated: false };
    }
  }
  return { ...(models[FALLBACK_MODEL] ?? FLASH), estimated: true };
}

/**
 * Deterministic fingerprint of the effective rate table. It becomes part of
 * the projection stateVersion, so editing a price invalidates persisted
 * checkpoints and every session reprices on its next read.
 * @param {ReturnType<typeof normalizeModels>['models']} models
 * @returns {number}
 */
export function pricingFingerprint(models) {
  const text = JSON.stringify(models);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Whether one event timestamp falls in DeepSeek's peak-price window.
 * @param {number} timeMs - epoch milliseconds of the recorded sample.
 * @returns {boolean}
 */
export function isPeakTime(timeMs) {
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}
