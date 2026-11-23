import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cdp, fingerprint, iconNames, isExtraPassing, isViteHtml } from "./runtime_probe";

type Socket = Bun.ServerWebSocket<undefined>;

// A WebSocket server that passes each received message to `onMessage`.
function server(onMessage: (ws: Socket, data: string | Buffer) => void) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: { message: onMessage },
  });
}

const LOST = /CDP connection (closed|failed)/;

test("a pending call rejects when the connection drops", async () => {
  using srv = server((ws) => ws.close());
  const session = cdp(`ws://127.0.0.1:${srv.port}`);
  await expect(session.send("Runtime.evaluate")).rejects.toThrow(LOST);
  await expect(session.send("Page.enable")).rejects.toThrow(LOST);
});

test("a call without a reply times out", async () => {
  using srv = server(() => {});
  // A real 50 ms deadline: the timer races live WebSocket I/O, which fake timers would not drive.
  const session = cdp(`ws://127.0.0.1:${srv.port}`, 50);
  await expect(session.send("Runtime.evaluate")).rejects.toThrow("Runtime.evaluate: no CDP reply within 50 ms");
  session.close();
});

test("a call to an unreachable endpoint rejects", async () => {
  const srv = server(() => {});
  const port = srv.port;
  srv.stop(true);
  await expect(cdp(`ws://127.0.0.1:${port}`).send("Page.enable")).rejects.toThrow(LOST);
});

test("replies resolve their own calls, in any order", async () => {
  const received: { ws: Socket; id: number; method: string }[] = [];
  using srv = server((ws, data) => {
    received.push({ ws, ...JSON.parse(String(data)) });
    if (received.length < 2) return;
    // Answer the second call first.
    for (const { ws: sock, id, method } of received.toReversed())
      sock.send(JSON.stringify(method === "B" ? { id, result: { name: "B" } } : { id, error: { message: "nope" } }));
  });
  const session = cdp(`ws://127.0.0.1:${srv.port}`);
  const a = session.send("A").then(() => "resolved", (e: Error) => e.message);
  const b = session.send<{ name: string }>("B");
  expect((await b).name).toBe("B");
  expect(await a).toBe("A: nope");
  session.close();
});

test("fingerprint keeps string literals and long property names, not names inside strings", () => {
  const src = String.raw`function(e){const{onChange:t,checked:n}=e;return(0,a.jsx)(o.Zt,{className:"Toggle \"on\"",label:'.notAProp',tip:` +
    "`x${n}`" + String.raw`,id:e.id,children:e.childrenContainerWidth})}`;
  expect(fingerprint(src)).toEqual({
    strings: ['.notAProp', "Toggle \\\"on\\\"", "x${n}"],
    names: ["checked", "children", "childrenContainerWidth", "className", "jsx", "label", "onChange", "tip"],
  });
});

test("Steam icon names are sorted and directional names use the shared source rule", () => {
  const Arrow = Function('return function({direction:e}){switch(e){case"up":return null;default:return null}}')();
  expect(iconNames({ Spinner: () => null, Arrow })).toEqual({
    names: ["Arrow", "Spinner"],
    directional: ["Arrow"],
  });
});

test("ES-module client detection matches decky-loader's script[type=module][src*=library.js]", () => {
  expect(isViteHtml('<script type="module" src="/library.js?contenthash=CVZWwsCP"></script>')).toBe(true);
  expect(isViteHtml('<script crossorigin src="/library.js" type="module"></script>')).toBe(true);
  expect(isViteHtml('<script defer="defer" src="/library.js"></script>')).toBe(false);
  expect(isViteHtml('<script type="module" src="/other.js"></script><script src="/library.js"></script>')).toBe(false);
  expect(isExtraPassing("CalloutMessage", 0, true)).toBe(true);
  expect(isExtraPassing("CalloutMessage", 0, false)).toBe(false);
  expect(isExtraPassing("CalloutMessage", 2, true)).toBe(false);
  expect(isExtraPassing("ToggleRow", 0, true)).toBe(false);
});

test("a missing @decky/ui package fails before any bundle is checked; an empty path skips its format", async () => {
  // Project convention (AGENTS.md): $TMPDIR, else /var/tmp/omp-1000, created on first use.
  const base = process.env.TMPDIR || "/var/tmp/omp-1000";
  await mkdir(base, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(join(base, "probe-test-"));
  try {
    await Bun.write(join(tmp, "ui/package.json"), "{}");
    // A bundle without Webpack or module scripts: the probe would boot it as a Webpack client.
    await Bun.write(join(tmp, "bundle/index.html"), "<html></html>");
    const run = (webpack: string, esm: string) => Bun.spawnSync(["bun", join(import.meta.dir, "runtime_probe.ts"),
      "--bundle-dir", join(tmp, "bundle"), "--decky-ui-webpack", webpack, "--decky-ui-esm", esm], { env: { ...process.env, TMPDIR: tmp } });
    for (const [webpack, esm] of [[join(tmp, "lost"), join(tmp, "ui")], [join(tmp, "ui"), join(tmp, "lost")]]) {
      const result = run(webpack, esm);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(`no @decky/ui package at ${join(tmp, "lost")}`);
    }
    const skipped = run("", join(tmp, "ui"));
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout.toString()).toContain("skipped, no @decky/ui package for Webpack clients");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
