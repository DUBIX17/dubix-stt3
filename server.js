// server.js
import express from "express";
import { WebSocket } from "ws";
import { Buffer } from "buffer"; // explicit Buffer import for clarity
import path from "path";

const app = express();
app.use(express.static(path.join(process.cwd(), "public")));

// === CONFIG ===
const WS_TARGET_URL = process.env.WS_URL || "wss://dubix-stt-proxy.onrender.com/ws";
const PORT = process.env.PORT || 3000;

let lastWsResponses = []; // array of JSON strings (or parsed objects if you prefer)

// === WebSocket setup & reconnect ===
let ws = null;
function connectWS() {
  console.log("[WS] Connecting to", WS_TARGET_URL);
  ws = new WebSocket(WS_TARGET_URL);
  ws.binaryType = "arraybuffer";

  ws.on("open", () => console.log("[WS] Connected"));
  ws.on("message", (data, isBinary) => {
    // Responses from upstream are JSON-only as per your spec -> parse and store
    if (!isBinary) {
      try {
        const txt = data.toString();
        // store raw JSON string (or JSON.parse(txt) if you want objects)
        lastWsResponses.push(txt);
        console.log("[WS] Received JSON response (len:", txt.length + ")");
      } catch (err) {
        console.warn("[WS] Failed to parse incoming message:", err.message);
      }
    } else {
      // ignore binary messages from upstream (per spec there shouldn't be any)
      console.log("[WS] Ignored binary message from upstream (not expected)");
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] Closed (${code}) - reconnecting in 2s`);
    setTimeout(connectWS, 2000);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err?.message || err);
    // ws will emit close which triggers reconnect
  });
}
connectWS();

// === POST /stream (collect binary manually) ===
app.post("/stream", (req, res) => {
  const clientId = req.headers["x-client-id"] || req.query.clientId || null;
  const chunks = [];
  let totalBytes = 0;

  req.on("data", (chunk) => {
    // chunk will be a Buffer or Uint8Array — normalize to Buffer
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
      try {
        // Send raw binary to upstream websocket
        ws.send(body, { binary: true }, (err) => {
          if (err) {
            console.error("[WS] send error:", err.message || err);
          }
        });
        // return success to uploader
        res.status(200).json({ ok: true, bytes: body.length, clientId });
      } catch (err) {
        console.error("[WS] send exception:", err);
        res.status(500).send("WebSocket send failed");
      }
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

// === GET /poll (returns array of JSON strings, then clears) ===
app.get("/poll", (req, res) => {
  const clientId = req.query.clientId || "global";
  // If you want per-client filtering, implement here (e.g., messages include clientId)
  const out = lastWsResponses.slice(); // copy
  // clear after serving
  lastWsResponses = [];
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(JSON.stringify(out));
});

// Clear responses every 3 seconds (as requested)
setInterval(() => {
  if (lastWsResponses.length > 0) {
    console.log("[CLEANUP] Clearing", lastWsResponses.length, "stored WS response(s)");
    lastWsResponses = [];
  }
}, 5000);

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, wsConnected: ws && ws.readyState === WebSocket.OPEN });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (WS -> ${WS_TARGET_URL})`);
});
