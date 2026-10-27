/**
 * Host half of the session-cost bundle.
 *
 * Registers one `sessionCost` projection unit on `ctx.sessionProjections`.
 * Every provider usage sample (a settled `assistant/message` or a failed
 * `assistant/attempt`) is priced with the published DeepSeek CNY rate for its
 * exact model and the peak/off-peak window of its recorded time. A retried
 * attempt contributes its own usage; a settlement that repeats the same step's
 * usage replaces that step's earlier contribution instead of double counting.
 *
 * The rate table is model-addressed. A card for an exact id is stored in
 * `$DSH_HOME/storages/session-cost/pricing.json` and edited by the Settings
 * page; an id without a card is priced at Flash rates, marked `estimated`, and
 * named in the client tooltip. The effective table's fingerprint is part of
 * `stateVersion`, so changing a price invalidates the persisted projection
 * checkpoints and every session reprices on its next read.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MODELS,
  isPeakTime,
  isUnsafeModelId,
  normalizeModelCard,
  normalizeModels,
  priceFor,
  pricingFingerprint,
} from './pricing.js';

export const name = 'session-cost';

/** Without the projection registry there is nowhere to publish the value. */
export const inject = ['sessionProjections'];

/**
 * Bump this when the fold or the view shape changes. The lower six digits of
 * `stateVersion` are the effective pricing fingerprint, so a price edit is a
 * cache-invalidating change too.
 */
const SEMANTICS_VERSION = 1;
const MICRO = 1_000_000;

/** @param {unknown} value @param {string} path @returns {void} */
function nonNegativeNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`session-cost ${path} must be a non-negative finite number`);
  }
}

/** @param {unknown} value @param {string} path @returns {void} */
function stringValue(value, path) {
  if (typeof value !== 'string') throw new Error(`session-cost ${path} must be a string`);
}

/** @param {unknown} value @param {string} path @returns {void} */
function booleanValue(value, path) {
  if (typeof value !== 'boolean') throw new Error(`session-cost ${path} must be a boolean`);
}

/** @param {unknown} value @param {string} path @returns {void} */
function stringArray(value, path) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`session-cost ${path} must be an array of strings`);
  }
}

/**
 * Minimal schema object understood by the projection registry (it only calls
 * `parse`). Keeping it dependency-free avoids adding zod to the profile.
 * @param {Record<string, (value: unknown, path: string) => void>} fields
 */
function objectSchema(fields) {
  return {
    parse(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('session-cost projection value must be an object');
      }
      for (const [key, check] of Object.entries(fields)) check(value[key], key);
      return value;
    },
  };
}

/**
 * Accept `null` or one object validated by `schema`.
 * @param {{ parse(value: unknown): unknown }} schema
 * @returns {(value: unknown, path: string) => void}
 */
function nullableObject(schema) {
  return (value, path) => {
    if (value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`session-cost ${path} must be an object or null`);
    }
    schema.parse(value);
  };
}

const bucketsSchema = objectSchema({
  uncachedInputTokens: nonNegativeNumber,
  cacheReadTokens: nonNegativeNumber,
  cacheWriteTokens: nonNegativeNumber,
  outputTokens: nonNegativeNumber,
});

const costsSchema = objectSchema({
  costCny: nonNegativeNumber,
  peakCostCny: nonNegativeNumber,
  offPeakCostCny: nonNegativeNumber,
  inputCostCny: nonNegativeNumber,
  cacheReadCostCny: nonNegativeNumber,
  cacheWriteCostCny: nonNegativeNumber,
  outputCostCny: nonNegativeNumber,
});

const lastSchema = objectSchema({
  turn: nonNegativeNumber,
  step: nonNegativeNumber,
  buckets: (value, path) => {
    if (value === null) throw new Error(`session-cost ${path} must not be null`);
    bucketsSchema.parse(value);
  },
  costs: (value, path) => {
    if (value === null) throw new Error(`session-cost ${path} must not be null`);
    costsSchema.parse(value);
  },
  estimated: booleanValue,
});

const totalFields = {
  costCny: nonNegativeNumber,
  peakCostCny: nonNegativeNumber,
  offPeakCostCny: nonNegativeNumber,
  inputCostCny: nonNegativeNumber,
  cacheReadCostCny: nonNegativeNumber,
  cacheWriteCostCny: nonNegativeNumber,
  outputCostCny: nonNegativeNumber,
  uncachedInputTokens: nonNegativeNumber,
  cacheReadTokens: nonNegativeNumber,
  cacheWriteTokens: nonNegativeNumber,
  outputTokens: nonNegativeNumber,
  requests: nonNegativeNumber,
  estimatedRequests: nonNegativeNumber,
};

const stateSchema = objectSchema({
  ...totalFields,
  currentModel: stringValue,
  lastModel: stringValue,
  lastPeak: booleanValue,
  unknownModels: stringArray,
  last: nullableObject(lastSchema),
});

const viewSchema = objectSchema({
  ...totalFields,
  lastModel: stringValue,
  lastPeak: booleanValue,
  unknownModels: stringArray,
});

/** Count provider tokens defensively; malformed fields contribute nothing. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** @returns {Record<string, number>} */
function zeroBuckets() {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
}

/** @returns {Record<string, number>} */
function zeroCosts() {
  return {
    costCny: 0,
    peakCostCny: 0,
    offPeakCostCny: 0,
    inputCostCny: 0,
    cacheReadCostCny: 0,
    cacheWriteCostCny: 0,
    outputCostCny: 0,
  };
}

/** @returns {Record<string, unknown>} */
function emptyState() {
  return {
    ...zeroCosts(),
    ...zeroBuckets(),
    requests: 0,
    estimatedRequests: 0,
    currentModel: '',
    lastModel: '',
    lastPeak: false,
    unknownModels: [],
    last: null,
  };
}

/** The usage one settlement or attempt reports, if any. */
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type !== 'chunk' || record.chunk?.type !== 'usage') continue;
    return record.chunk.usage;
  }
  return undefined;
}

/**
 * Price one usage sample under its model and recorded time.
 * @returns {{ buckets: Record<string, number>, costs: Record<string, number>, estimated: boolean, model: string, peak: boolean } | null}
 */
function contribution(usage, model, time, models) {
  const buckets = {
    uncachedInputTokens: tokenCount(usage.inputTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
    outputTokens: tokenCount(usage.outputTokens),
  };
  const total = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens;
  if (total === 0) return null;

  const price = priceFor(models, model);
  const peak = isPeakTime(time);
  const rate = peak ? price.peak : price.offPeak;
  const inputCostCny = (buckets.uncachedInputTokens * rate.input) / MICRO;
  const cacheReadCostCny = (buckets.cacheReadTokens * rate.cacheRead) / MICRO;
  // DeepSeek has no separate cache-write price; charge it at cache-miss input.
  const cacheWriteCostCny = (buckets.cacheWriteTokens * rate.input) / MICRO;
  const outputCostCny = (buckets.outputTokens * rate.output) / MICRO;
  const costCny = inputCostCny + cacheReadCostCny + cacheWriteCostCny + outputCostCny;

  return {
    buckets,
    costs: {
      costCny,
      peakCostCny: peak ? costCny : 0,
      offPeakCostCny: peak ? 0 : costCny,
      inputCostCny,
      cacheReadCostCny,
      cacheWriteCostCny,
      outputCostCny,
    },
    estimated: price.estimated,
    model,
    peak,
  };
}

/** Subtract one previous contribution so a repeated step can be repriced. */
function without(state, previous) {
  return {
    ...state,
    costCny: Math.max(0, state.costCny - previous.costs.costCny),
    peakCostCny: Math.max(0, state.peakCostCny - previous.costs.peakCostCny),
    offPeakCostCny: Math.max(0, state.offPeakCostCny - previous.costs.offPeakCostCny),
    inputCostCny: Math.max(0, state.inputCostCny - previous.costs.inputCostCny),
    cacheReadCostCny: Math.max(0, state.cacheReadCostCny - previous.costs.cacheReadCostCny),
    cacheWriteCostCny: Math.max(0, state.cacheWriteCostCny - previous.costs.cacheWriteCostCny),
    outputCostCny: Math.max(0, state.outputCostCny - previous.costs.outputCostCny),
    uncachedInputTokens: Math.max(0, state.uncachedInputTokens - previous.buckets.uncachedInputTokens),
    cacheReadTokens: Math.max(0, state.cacheReadTokens - previous.buckets.cacheReadTokens),
    cacheWriteTokens: Math.max(0, state.cacheWriteTokens - previous.buckets.cacheWriteTokens),
    outputTokens: Math.max(0, state.outputTokens - previous.buckets.outputTokens),
    requests: Math.max(0, state.requests - 1),
    estimatedRequests: Math.max(0, state.estimatedRequests - (previous.estimated ? 1 : 0)),
  };
}

/**
 * Build one projection unit bound to an effective rate table.
 * @param {ReturnType<typeof normalizeModels>['models']} models
 * @param {(model: string) => void} [onUnknown] - called when an unpriced model contributes.
 */
export function createDefinition(models, onUnknown = () => {}) {
  const stateVersion = SEMANTICS_VERSION * 1_000_000 + (pricingFingerprint(models) % 1_000_000);

  return {
    key: 'sessionCost',
    stateVersion,
    stateSchema,
    init: emptyState,
    apply(state, event) {
      if (event.type === 'request/context') {
        const model = event.data?.model;
        return typeof model === 'string' && model !== state.currentModel ? { ...state, currentModel: model } : state;
      }
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model;
        return typeof model === 'string' && model !== state.currentModel ? { ...state, currentModel: model } : state;
      }
      if (event.type === 'llm/retry-started') {
        const last = state.last;
        if (last === null || last.turn !== event.data?.turn || last.step !== event.data?.step) return state;
        return { ...state, last: null };
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;

      const usage = usageOf(event);
      if (usage === undefined) return state;

      const source = event.data?.message?.source;
      const model = event.type === 'assistant/message' && typeof source?.model === 'string'
        ? source.model
        : state.currentModel;
      const next = contribution(usage, model, event.time, models);
      if (next === null) return state;

      const turn = event.data?.turn;
      const step = event.data?.step;
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step
        ? state.last
        : null;

      const sameBuckets = previous !== null
        && previous.buckets.uncachedInputTokens === next.buckets.uncachedInputTokens
        && previous.buckets.cacheReadTokens === next.buckets.cacheReadTokens
        && previous.buckets.cacheWriteTokens === next.buckets.cacheWriteTokens
        && previous.buckets.outputTokens === next.buckets.outputTokens;
      if (sameBuckets && previous.estimated === next.estimated && previous.costs.costCny === next.costs.costCny) {
        return state;
      }

      const base = previous === null ? state : without(state, previous);
      if (next.estimated && next.model.length > 0) {
        try {
          onUnknown(next.model);
        } catch {
          // A diagnostic callback must never break the durable fold.
        }
      }
      const unknownModels = next.estimated && next.model.length > 0 && !base.unknownModels.includes(next.model)
        ? [...base.unknownModels, next.model].slice(0, 12)
        : base.unknownModels;

      return {
        ...base,
        costCny: base.costCny + next.costs.costCny,
        peakCostCny: base.peakCostCny + next.costs.peakCostCny,
        offPeakCostCny: base.offPeakCostCny + next.costs.offPeakCostCny,
        inputCostCny: base.inputCostCny + next.costs.inputCostCny,
        cacheReadCostCny: base.cacheReadCostCny + next.costs.cacheReadCostCny,
        cacheWriteCostCny: base.cacheWriteCostCny + next.costs.cacheWriteCostCny,
        outputCostCny: base.outputCostCny + next.costs.outputCostCny,
        uncachedInputTokens: base.uncachedInputTokens + next.buckets.uncachedInputTokens,
        cacheReadTokens: base.cacheReadTokens + next.buckets.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + next.buckets.cacheWriteTokens,
        outputTokens: base.outputTokens + next.buckets.outputTokens,
        requests: base.requests + 1,
        estimatedRequests: base.estimatedRequests + (next.estimated ? 1 : 0),
        currentModel: next.model || base.currentModel,
        lastModel: next.model,
        lastPeak: next.peak,
        unknownModels,
        last: {
          turn,
          step,
          buckets: next.buckets,
          costs: next.costs,
          estimated: next.estimated,
        },
      };
    },
    wire: {
      viewSchema,
      view: (state) => ({
        costCny: state.costCny,
        peakCostCny: state.peakCostCny,
        offPeakCostCny: state.offPeakCostCny,
        inputCostCny: state.inputCostCny,
        cacheReadCostCny: state.cacheReadCostCny,
        cacheWriteCostCny: state.cacheWriteCostCny,
        outputCostCny: state.outputCostCny,
        uncachedInputTokens: state.uncachedInputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        outputTokens: state.outputTokens,
        requests: state.requests,
        estimatedRequests: state.estimatedRequests,
        lastModel: state.lastModel,
        lastPeak: state.lastPeak,
        unknownModels: state.unknownModels,
      }),
    },
  };
}

/** Default unit used by tests and by a composition without overrides. */
export const sessionCostProjectionDefinition = createDefinition(DEFAULT_MODELS);

/**
 * @returns {string} the plugin-owned price document.
 */
function priceDocumentPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'session-cost', 'pricing.json');
}

/**
 * Keep only valid, safe model cards.
 * @param {unknown} raw
 * @returns {Record<string, { peak: { input: number, cacheRead: number, output: number }, offPeak: { input: number, cacheRead: number, output: number } }>}
 */
function sanitizeOverrides(raw) {
  const clean = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return clean;
  for (const [id, card] of Object.entries(raw)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200 || isUnsafeModelId(id)) continue;
    const normalized = normalizeModelCard(card);
    if (normalized !== null) clean[id] = normalized;
  }
  return clean;
}

/**
 * Read the persisted override table; a missing or malformed document is empty.
 * @param {string} file
 * @returns {Record<string, { peak: { input: number, cacheRead: number, output: number }, offPeak: { input: number, cacheRead: number, output: number } }>}
 */
function loadOverrides(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return sanitizeOverrides(parsed?.models);
  } catch {
    return {};
  }
}

/**
 * Atomically replace the persisted override table.
 * @param {string} file
 * @param {ReturnType<typeof sanitizeOverrides>} models
 */
async function saveOverrides(file, models) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/**
 * Read one bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit
 */
async function readJson(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const file = priceDocumentPath();
  let overrides = loadOverrides(file);
  let effective = normalizeModels(overrides).models;
  const seen = new Set();
  let disposeProjection = null;
  let writeQueue = Promise.resolve();

  /**
   * Install one projection generation for a new override table.
   * @param {ReturnType<typeof sanitizeOverrides>} next
   */
  function activate(next) {
    const { models, invalid } = normalizeModels(next);
    for (const id of invalid) {
      ctx.logger?.warn?.(`session-cost: ignoring invalid price card for model ${JSON.stringify(id)}`);
    }
    disposeProjection?.();
    disposeProjection = null;
    disposeProjection = ctx.sessionProjections.register(createDefinition(models, (model) => {
      if (seen.size < 50) seen.add(model);
    }));
    overrides = next;
    effective = models;
  }

  activate(overrides);

  ctx.inject(['webServer'], (child) => {
    const server = child.webServer;
    const send = (response, status, data) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(JSON.stringify(data));
    };

    async function handle(request, response) {
      try {
        const remote = request.socket.remoteAddress;
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!loopback || request.headers['x-dsh-session-cost'] !== '1') {
          send(response, 403, { error: 'forbidden' });
          return;
        }
        const origin = request.headers.origin;
        if (origin !== undefined) {
          let allowed = false;
          try {
            const requested = new URL(origin);
            const served = new URL(server.getOrigin());
            const host = requested.hostname;
            allowed = requested.protocol === served.protocol
              && requested.port === served.port
              && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
          } catch {
            allowed = false;
          }
          if (!allowed) {
            send(response, 403, { error: 'forbidden' });
            return;
          }
        }
        const snapshot = () => ({
          models: effective,
          custom: Object.keys(overrides),
          seen: [...seen],
          revision: pricingFingerprint(effective),
        });

        if (request.method === 'GET') {
          send(response, 200, snapshot());
          return;
        }
        if (request.method !== 'PUT') {
          send(response, 405, { error: 'method-not-allowed' });
          return;
        }

        const body = await readJson(request, 64 * 1024);
        const next = { ...overrides };
        if (body.models !== undefined) {
          if (typeof body.models !== 'object' || body.models === null || Array.isArray(body.models)) {
            send(response, 400, { error: 'invalid-models' });
            return;
          }
          for (const [id, card] of Object.entries(body.models)) {
            if (typeof id !== 'string' || id.length === 0 || id.length > 200 || isUnsafeModelId(id)) {
              send(response, 400, { error: 'invalid-id', id });
              return;
            }
            const normalized = normalizeModelCard(card);
            if (normalized === null) {
              send(response, 400, { error: 'invalid-card', id });
              return;
            }
            next[id] = normalized;
          }
        }
        if (body.remove !== undefined) {
          if (typeof body.remove !== 'string' || isUnsafeModelId(body.remove)) {
            send(response, 400, { error: 'invalid-id', id: body.remove });
            return;
          }
          delete next[body.remove];
        }

        writeQueue = writeQueue.catch(() => {}).then(() => saveOverrides(file, next));
        await writeQueue;
        activate(next);
        send(response, 200, snapshot());
      } catch (error) {
        ctx.logger?.warn?.('session-cost: pricing request failed', error);
        send(response, 500, { error: error?.message ?? String(error) });
      }
    }

    child.effect(() => server.register({
      kind: 'exact',
      path: '/plugins/session-cost/pricing',
      handler: (request, response) => { void handle(request, response); },
    }), 'session-cost: pricing route');
  });
}
