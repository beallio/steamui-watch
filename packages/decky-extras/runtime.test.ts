import { expect, test } from "bun:test";
import { createExtrasRuntime } from "./runtime";

const CACHE_KEY = "beallio:decky-extras:v1";
const componentNames = ["RadioButton"];

function definitions(revision: number, text: string) {
  return {
    schema: 1,
    revision,
    components: {
      RadioButton: { title: "Radio button", description: "", find: [[{ text }]] },
    },
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function fakeTimers() {
  let id = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  const delays: number[] = [];
  return {
    delays,
    set(callback: () => void, delay: number) {
      const token = ++id;
      delays.push(delay);
      pending.set(token, { callback, delay });
      return token;
    },
    fire(delay: number) {
      for (const [token, timer] of pending) {
        if (timer.delay === delay) {
          pending.delete(token);
          timer.callback();
          return true;
        }
      }
      return false;
    },
    clear(token: unknown) { pending.delete(token as number); },
  };
}

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CACHE_KEY, initial);
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

test("newer bundled definitions beat old cache and stale downloads", async () => {
  const timers = fakeTimers();
  const bundledComponent = { render() { return "bundled"; } };
  const cachedComponent = { render() { return "cached"; } };
  const storage = memoryStorage(JSON.stringify(definitions(2, "cached")));
  const runtime = createExtrasRuntime({
    bundled: definitions(3, "bundled"),
    names: componentNames,
    modules: () => new Map([["ui", { bundledComponent, cachedComponent }]]),
    fetch: async () => response(definitions(2, "cached")),
    storage: () => storage,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  expect(runtime.get("RadioButton")).toBe(bundledComponent);
  expect(await runtime.refresh()).toBe(false);
  expect(runtime.get("RadioButton")).toBe(bundledComponent);
  expect(storage.values.get(CACHE_KEY)).toBe(JSON.stringify(definitions(2, "cached")));
  runtime.dispose();
});

test("invalid and same-revision changed downloads keep last-good cache and retry in one minute", async () => {
  const cachedComponent = { render() { return "cached"; } };
  const cached = JSON.stringify(definitions(2, "cached"));
  const storage = memoryStorage(cached);
  const timers = fakeTimers();
  let attempt = 0;
  const runtime = createExtrasRuntime({
    bundled: definitions(1, "bundled"),
    names: componentNames,
    modules: () => new Map([["ui", { cachedComponent }]]),
    fetch: async () => {
      attempt++;
      if (attempt === 1) return response(null, 503);
      if (attempt === 2) return response(definitions(2, "changed"));
      return response({ ...definitions(3, "invalid"), schema: 2 });
    },
    storage: () => storage,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const unsubscribe = runtime.subscribe(() => {});

  expect(runtime.get("RadioButton")).toBe(cachedComponent);
  expect(await runtime.refresh()).toBe(false);
  expect(storage.values.get(CACHE_KEY)).toBe(cached);
  expect(timers.delays).toContain(60_000);
  expect(await runtime.refresh()).toBe(false);
  expect(await runtime.refresh()).toBe(false);
  expect(storage.values.get(CACHE_KEY)).toBe(cached);
  unsubscribe();
  runtime.dispose();
});

test("valid newer data replaces the cache", async () => {
  const available = { render() { return "available"; } };
  const updated = definitions(2, "available");
  const storage = memoryStorage();
  const timers = fakeTimers();
  const runtime = createExtrasRuntime({
    bundled: definitions(1, "not-present"),
    names: componentNames,
    modules: () => new Map([["ui", { available }]]),
    fetch: async () => response(updated),
    storage: () => storage,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  expect(await runtime.refresh()).toBe(true);
  expect(runtime.get("RadioButton")).toBe(available);
  expect(JSON.parse(storage.values.get(CACHE_KEY)!)).toEqual(updated);
  runtime.dispose();
});

test("ambiguous updates preserve a downloaded working finder across reloads", async () => {
  const working = { render() { return "working"; } };
  const ambiguousA = { render() { return "shared"; } };
  const ambiguousB = { render() { return "shared"; } };
  const timers = fakeTimers();
  const cached = JSON.stringify(definitions(2, "working"));
  const storage = memoryStorage(cached);
  const options = {
    bundled: definitions(1, "not-present"),
    names: componentNames,
    modules: () => new Map([["ui", { working, ambiguousA, ambiguousB }]]),
    fetch: async () => response(definitions(3, "shared")),
    storage: () => storage,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  };
  const runtime = createExtrasRuntime(options);
  expect(runtime.get("RadioButton")).toBe(working);
  expect(await runtime.refresh()).toBe(false);
  expect(storage.values.get(CACHE_KEY)).toBe(cached);
  runtime.dispose();
  const reloaded = createExtrasRuntime(options);
  expect(reloaded.get("RadioButton")).toBe(working);
  reloaded.dispose();
});

test("unavailable storage does not prevent an in-memory recovery", async () => {
  const available = { render() { return "available"; } };
  const timers = fakeTimers();
  const runtime = createExtrasRuntime({
    bundled: definitions(1, "not-present"),
    names: componentNames,
    modules: () => new Map([["ui", { available }]]),
    fetch: async () => response(definitions(2, "available")),
    storage: () => { throw new Error("storage blocked"); },
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  expect(runtime.get("RadioButton")).toBeNull();
  expect(await runtime.refresh()).toBe(true);
  expect(runtime.get("RadioButton")).toBe(available);
  runtime.dispose();
});

test("mounted subscribers observe delayed recovery and successful refresh is hourly", async () => {
  let resolveResponse: (value: Response) => void = () => {};
  let fetches = 0;
  const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  const recovered = { render() { return "recovered"; } };
  const timers = fakeTimers();
  const runtime = createExtrasRuntime({
    bundled: definitions(1, "not-present"),
    names: componentNames,
    modules: () => new Map([["ui", { recovered }]]),
    fetch: () => { fetches++; return pending; },
    storage: () => null,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const observed: unknown[] = [];
  expect(runtime.get("RadioButton")).toBeNull();
  expect(fetches).toBe(0);
  const unsubscribe = runtime.subscribe(() => observed.push(runtime.get("RadioButton")));

  expect(fetches).toBe(1);
  expect(runtime.get("RadioButton")).toBeNull();
  resolveResponse(response(definitions(2, "recovered")));
  expect(await runtime.refresh()).toBe(true);
  expect(runtime.get("RadioButton")).toBe(recovered);
  expect(observed).toContain(recovered);
  expect(timers.delays).toContain(60 * 60 * 1000);
  unsubscribe();
  runtime.dispose();
});

test("refresh requests share one flight and streamed responses are capped at 64 KiB", async () => {
  let resolveResponse: (value: Response) => void = () => {};
  let fetches = 0;
  const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  const storage = memoryStorage(JSON.stringify(definitions(1, "bundled")));
  const timers = fakeTimers();
  const runtime = createExtrasRuntime({
    bundled: definitions(1, "bundled"),
    names: componentNames,
    modules: () => new Map([["ui", { render() { return "bundled"; } }]]),
    fetch: () => { fetches++; return pending; },
    storage: () => storage,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  const first = runtime.refresh();
  const second = runtime.refresh();
  expect(second).toBe(first);
  expect(fetches).toBe(1);
  resolveResponse(response(definitions(1, "bundled")));
  expect(await first).toBe(true);
  runtime.dispose();

  const limited = createExtrasRuntime({
    bundled: definitions(1, "bundled"),
    names: componentNames,
    modules: () => [],
    fetch: async () => new Response(new Uint8Array(64 * 1024 + 1)),
    storage: () => storage,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  expect(await limited.refresh()).toBe(false);
  expect(storage.values.get(CACHE_KEY)).toBe(JSON.stringify(definitions(1, "bundled")));
  limited.dispose();
});

test("request timeout aborts its bounded fetch", () => {
  let signal: AbortSignal | undefined;
  const timers = fakeTimers();
  const runtime = createExtrasRuntime({
    bundled: definitions(1, "not-present"),
    names: componentNames,
    modules: () => [],
    fetch: (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    },
    storage: () => null,
    now: () => 100_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const unsubscribe = runtime.subscribe(() => {});

  expect(timers.fire(10_000)).toBe(true);
  expect(signal?.aborted).toBe(true);
  unsubscribe();
  runtime.dispose();
});
