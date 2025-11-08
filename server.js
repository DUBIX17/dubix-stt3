// server.js
import express from "express";
import { WebSocket } from "ws";
import { Buffer } from "buffer";
import path from "path";

const app = express();
app.use(express.static(path.join(process.cwd(), "public")));

// === CONFIG ===
const WS_TARGET_URL = process.env.WS_URL || "wss://dubix-stt-proxy.onrender.com/ws";
const PORT = process.env.PORT || 3000;

// Only keep the *latest* WS response
let lastWsResponse = null;
let clearTimeoutHandle = null;

// === WebSocket setup & reconnect ===
let ws = null;
function connectWS() {
  console.log("[WS] Connecting to", WS_TARGET_URL);
  ws = new WebSocket(WS_TARGET_URL);
  ws.binaryType = "arraybuffer";

  ws.on("open", () => console.log("[WS] Connected"));

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const txt = data.toString();
        lastWsResponse = txt; // overwrite previous
        console.log("[WS] Received JSON response (len:", txt.length + ")");

        // Reset the 1s clear timer whenever a new response arrives
        if (clearTimeoutHandle) clearTimeout(clearTimeoutHandle);
        clearTimeoutHandle = setTimeout(() => {
          if (lastWsResponse) {
            console.log("[CLEANUP] Clearing last WS response");
            lastWsResponse = null;
          }
        }, 1000);

      } catch (err) {
        console.warn("[WS] Failed to parse incoming message:", err.message);
      }
    } else {
      console.log("[WS] Ignored binary message from upstream (not expected)");
    }
  });

  ws.on("close", (code) => {
    console.log(`[WS] Closed (${code}) - reconnecting in 2s`);
    setTimeout(connectWS, 2000);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err?.message || err);
  });
}
connectWS();

// === POST /stream ===
app.post("/stream", (req, res) => {
  const clientId = req.headers["x-client-id"] || req.query.clientId || null;
  const chunks = [];
  let totalBytes = 0;

  req.on("data", (chunk) => {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    totalBytes += buf.length;
  });

  req.on("end", () => {
    const body = Buffer.concat(chunks, totalBytes);
    if (!body || body.length === 0) {
      console.log("[HTTP] /stream received empty body");
      return res.status(400).send("Empty body");
    }

    console.log(`[HTTP] /stream received ${body.length} bytes${clientId ? " for clientId="+clientId : ""}`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(body, { binary: true }, (err) => {
        if (err) console.error("[WS] send error:", err.message || err);
      });
      res.status(200).json({ ok: true, bytes: body.length, clientId });
    } else {
      console.log("[HTTP] WebSocket not connected");
      res.status(503).send("WebSocket not connected");
    }
  });

  req.on("error", (err) => {
    console.error("[HTTP] request error:", err.message || err);
    res.status(500).send("Request error");
  });
});

// === GET /poll ===
app.get("/poll", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (lastWsResponse) {
    const out = [lastWsResponse];
    lastWsResponse = null; // clear after serving
    res.status(200).send(JSON.stringify(out));
  } else {
    res.status(200).send("[]");
  }
});

// === Health ===
app.get("/health", (req, res) => {
  res.json({ ok: true, wsConnected: ws && ws.readyState === WebSocket.OPEN });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (WS -> ${WS_TARGET_URL})`);
});