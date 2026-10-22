import { matchExtras, parseManifest, type Manifest } from "./match";

export const EXTRAS_URL = "https://beallio.github.io/steamui-watch/decky-extras.json";
const CACHE_KEY = "beallio:decky-extras:v1";
const MAX_MANIFEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_MS = 60_000;
const REFRESH_MS = 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type TimerToken = unknown;

type RuntimeOptions = {
  bundled: unknown;
  names: readonly string[];
  modules: () => Iterable<readonly [unknown, unknown]>;
  fetch?: typeof fetch;
  storage?: () => StorageLike | null;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerToken;
  clearTimer?: (timer: TimerToken) => void;
};

export function createExtrasRuntime(options: RuntimeOptions) {
  const bundled = parseManifest(options.bundled);
  const fetcher = options.fetch ?? globalThis.fetch;
  const getStorage = options.storage ?? (() => {
    try { return typeof window === "undefined" ? null : window.localStorage; }
    catch { return null; }
  });
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));

  let manifest: Manifest = bundled;
  let moduleEntries: Array<readonly [unknown, unknown]> = [];
  let resolutions = new Map<string, unknown>();
  let initialized = false;
  let disposed = false;
  let attempted = false;
  let nextRefreshAt = 0;
  let inFlight: Promise<boolean> | null = null;
  let refreshTimer: TimerToken;
  let refreshTimerActive = false;
  let requestTimer: TimerToken;
  let requestTimerActive = false;
  let requestController: AbortController | null = null;
  const subscribers = new Set<() => void>();

  const equalManifest = (a: Manifest, b: Manifest) => JSON.stringify(a) === JSON.stringify(b);

  function cachedManifest(): Manifest | null {
    try {
      const raw = getStorage()?.getItem(CACHE_KEY);
      if (!raw || raw.length > MAX_MANIFEST_BYTES || new TextEncoder().encode(raw).byteLength > MAX_MANIFEST_BYTES) return null;
      return parseManifest(JSON.parse(raw));
    } catch { return null; }
  }

  function computeResolutions(next: Manifest, previous: Map<string, unknown>, rejectLost = false): Map<string, unknown> {
    const matches = matchExtras(moduleEntries, next);
    const result = new Map<string, unknown>();
    for (const name of options.names) {
      const hits = matches[name];
      if (hits?.length === 1) result.set(name, hits[0]);
      else if (previous.has(name)) {
        if (rejectLost) throw new Error(`Extras update loses the working ${name} finder`);
        result.set(name, previous.get(name));
      }
    }
    return result;
  }

  function initialize() {
    if (initialized || disposed) return;
    initialized = true;
    try { moduleEntries = Array.from(options.modules()); }
    catch { moduleEntries = []; }

    const baseline = computeResolutions(bundled, new Map());
    const cached = cachedManifest();
    if (cached && cached.revision > bundled.revision) {
      try {
        resolutions = computeResolutions(cached, baseline);
        manifest = cached;
        return;
      } catch { /* Keep the bundled definitions and resolutions. */ }
    }
    resolutions = baseline;
  }

  function notify() {
    for (const subscriber of subscribers) {
      try { subscriber(); } catch { /* A consumer callback cannot invalidate accepted definitions. */ }
    }
  }

  function clearScheduledRefresh() {
    if (!refreshTimerActive) return;
    clearTimer(refreshTimer);
    refreshTimerActive = false;
  }

  function scheduleRefresh() {
    if (disposed || !subscribers.size || refreshTimerActive || inFlight) return;
    const delay = Math.max(0, nextRefreshAt - now());
    refreshTimerActive = true;
    refreshTimer = setTimer(() => {
      refreshTimerActive = false;
      if (subscribers.size && !disposed) void refresh();
    }, delay);
  }

  function start() {
    if (disposed) return;
    initialize();
    if (inFlight) return;
    if (!attempted || now() >= nextRefreshAt) void refresh();
    else scheduleRefresh();
  }

  async function download() {
    const controller = new AbortController();
    requestController = controller;
    requestTimerActive = true;
    requestTimer = setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(EXTRAS_URL, { cache: "no-cache", signal: controller.signal });
      if (!response.ok) throw new Error(`Extras download returned HTTP ${response.status}`);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_MANIFEST_BYTES) throw new Error("Extras manifest exceeds 64 KiB");
      if (!response.body) throw new Error("Extras response has no readable body");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const text: string[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MANIFEST_BYTES) throw new Error("Extras manifest exceeds 64 KiB");
        text.push(decoder.decode(value, { stream: true }));
      }
      if (controller.signal.aborted || disposed) throw new Error("Extras request was aborted");
      text.push(decoder.decode());
      const candidate = parseManifest(JSON.parse(text.join("")));
      if (candidate.revision < manifest.revision) throw new Error("Extras manifest revision is stale");
      if (candidate.revision === manifest.revision && !equalManifest(candidate, manifest)) {
        throw new Error("Extras manifest changed without a revision bump");
      }
      if (candidate.revision > manifest.revision) {
        const nextResolutions = computeResolutions(candidate, resolutions, true);
        manifest = candidate;
        resolutions = nextResolutions;
        try { getStorage()?.setItem(CACHE_KEY, JSON.stringify(candidate)); }
        catch { /* Storage is optional; the in-memory definitions remain usable. */ }
        notify();
      }
    } catch (error) {
      try { void reader?.cancel().catch(() => {}); } catch { /* The stream may already be closed. */ }
      throw error;
    } finally {
      if (requestTimerActive) clearTimer(requestTimer);
      requestTimerActive = false;
      if (requestController === controller) requestController = null;
    }
  }

  function refresh(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    initialize();
    if (inFlight) return inFlight;
    clearScheduledRefresh();
    attempted = true;
    const request = download().then(
      () => { nextRefreshAt = now() + REFRESH_MS; return true; },
      () => { nextRefreshAt = now() + RETRY_MS; return false; },
    ).finally(() => {
      inFlight = null;
      if (subscribers.size) scheduleRefresh();
    });
    inFlight = request;
    return request;
  }

  return {
    get(name: string): unknown | null {
      initialize();
      return resolutions.get(name) ?? null;
    },
    start,
    refresh,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      subscribers.add(listener);
      initialize();
      listener();
      start();
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) clearScheduledRefresh();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduledRefresh();
      subscribers.clear();
      if (requestTimerActive) clearTimer(requestTimer);
      requestTimerActive = false;
      requestController?.abort();
    },
  };
}
