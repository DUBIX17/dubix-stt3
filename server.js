import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import https from 'https';
import http from 'http';

const app = express();
const PORT = process.env.PORT || 10000;
const SILENCE_MS = parseInt(process.env.SILENCE_MS || '1200', 10);
const DG_MODEL = process.env.DG_MODEL || 'nova-3';
const DG_LANG = process.env.DG_LANG || 'en';

// === Create server (Render already terminates SSL) ===
let server;
if (fs.existsSync('cert.pem') && fs.existsSync('key.pem')) {
  const options = {
    cert: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem'),
  };
  server = https.createServer(options, app);
  console.log('Running HTTPS (local SSL) server');
} else {
  server = http.createServer(app);
  console.log('Running HTTP (Render-managed HTTPS)');
}

server.listen(PORT, () => console.log(`Server listening on :${PORT}`));

// === Memory stores ===
const sessions = new Map();      // active streaming sessions
const transcripts = new Map();   // saved transcripts for GET access

// === RMS calculation ===
function calcRMS(buffer) {
  let sumSq = 0;
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

// === Stream endpoint ===
// clients POST raw 16-bit PCM chunks repeatedly
app.post('/stream', express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req, res) => {
  const id = req.query.id || 'default';
  const sampleRate = parseInt(req.query.sample_rate || '16000', 10);

  if (!sessions.has(id)) {
    sessions.set(id, {
      audio: [],
      lastHeard: Date.now(),
      startedTalking: false,
      rmsActiveTime: 0,
      sampleRate,
    });
  }

  const session = sessions.get(id);
  const chunk = Buffer.from(req.body);
  const rms = calcRMS(chunk);
  const now = Date.now();

  // Consider audio "active" if RMS > 0.02
  if (rms > 0.02) {
    session.lastHeard = now;
    session.audio.push(chunk);
    session.startedTalking = true;
    session.rmsActiveTime += chunk.length / (sampleRate * 2) * 1000; // ms duration
  } else {
    // Before 2s active audio, keep recording
    if (!session.startedTalking || session.rmsActiveTime < 2000) {
      session.audio.push(chunk);
      session.lastHeard = now;
    }
  }

  // If silence detected and at least 2s active audio heard
  if (session.startedTalking && now - session.lastHeard > SILENCE_MS) {
    console.log(`[${id}] Silence detected -> finalizing`);
    finalizeAndTranscribe(id);
  }

  res.json({ ok: true, rms });
});

// === GET transcript ===
app.get('/transcript', (req, res) => {
  const id = req.query.id || 'default';
  const transcript = transcripts.get(id);
  if (!transcript) {
    return res.json({ transcript: '', ready: false });
  }
  res.json({ transcript, ready: true });
});

// === Manual finalize trigger (optional) ===
app.get('/finalize', (req, res) => {
  const id = req.query.id || 'default';
  if (!sessions.has(id)) return res.status(404).send('No active session');
  finalizeAndTranscribe(id);
  res.send('Finalizing...');
});

// === Finalization and Deepgram transcription ===
async function finalizeAndTranscribe(id) {
  const session = sessions.get(id);
  if (!session) return;

  sessions.delete(id);
  if (!session.audio.length) return console.log(`[${id}] No audio to process`);

  const tmpFile = path.join(tmpdir(), `audio_${id}_${Date.now()}.raw`);
  fs.writeFileSync(tmpFile, Buffer.concat(session.audio));

  try {
    const fileData = fs.readFileSync(tmpFile);

    const resp = await fetch(
      `https://api.deepgram.com/v1/listen?model=${DG_MODEL}&language=${DG_LANG}&encoding=linear16&sample_rate=${session.sampleRate}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/octet-stream'
        },
        body: fileData
      }
    );

    const json = await resp.json();
    const transcript = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

    console.log(`[${id}] Transcript:`, transcript);

    // Store transcript for retrieval
    transcripts.set(id, transcript);

    // Auto-clear after 5 seconds
    setTimeout(() => transcripts.delete(id), 5000);

  } catch (err) {
    console.error(`[${id}] Deepgram error:`, err);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
