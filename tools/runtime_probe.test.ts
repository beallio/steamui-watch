import { expect, test } from "bun:test";
import { cdp, fingerprint } from "./runtime_probe";

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
