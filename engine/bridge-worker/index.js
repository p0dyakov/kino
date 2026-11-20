// kinostream peer bridge — GET /connect?to=ip:port upgrades to WebSocket and
// pipes the stream to a raw TCP socket via cloudflare:sockets.
// client speaks plain bytes: ws payload <-> tcp stream, both directions.
import { connect } from "cloudflare:sockets";

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/connect")
      return new Response("ks-bridge\n", { status: 200 });

    const to = url.searchParams.get("to") ?? "";
    const m = to.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/);
    if (!m) return new Response("bad ?to=", { status: 400 });
    const host = m[1], port = +m[2];
    if (!port || port > 65535) return new Response("bad port", { status: 400 });
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("ws required", { status: 426 });

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    let sock, writer;
    try {
      sock = connect({ hostname: host, port });
      writer = sock.writable.getWriter();
      sock.opened.catch((e) => {
        try { server.close(1011, String(e).slice(0, 120)); } catch {}
      });
    } catch (e) {
      server.close(1011, "connect fail");
      return new Response(null, { status: 101, webSocket: client });
    }

    // tcp -> ws
    (async () => {
      try {
        const reader = sock.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || server.readyState !== 1) break;
          if (value?.byteLength) server.send(value);
        }
      } catch {}
      try { server.close(1000); } catch {}
    })();

    // ws -> tcp
    server.addEventListener("message", (ev) => {
      try {
        const data = typeof ev.data === "string"
          ? new TextEncoder().encode(ev.data)
          : new Uint8Array(ev.data);
        writer.write(data).catch(() => { try { server.close(1011); } catch {} });
      } catch {
        try { server.close(1011); } catch {}
      }
    });
    server.addEventListener("close", () => { try { sock.close(); } catch {} });

    return new Response(null, { status: 101, webSocket: client });
  },
};
