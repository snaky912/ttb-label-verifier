/**
 * TTB Label Verification prototype — HTTP server.
 *
 * Deliberately small: static files, one verification endpoint, one health
 * endpoint. There is no database and nothing is written to disk. Marcus
 * Williams asked for a prototype that does not create new PII or
 * retention obligations, so an uploaded image lives in memory for the
 * duration of one request and is then discarded.
 */

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyLabel } from './src/core/verify.js';
import { extractLabel } from './src/extract/anthropic.js';
import { GOVERNMENT_WARNING } from './src/core/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

/** In-memory only: nothing touches the filesystem. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error(`Unsupported image type: ${file.mimetype}`), ok);
  },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// The browser imports the rules engine directly, so the interface shows
// the exact statutory warning text the server checks against — one source
// of truth. Only the pure, secret-free core is exposed; `src/extract`
// (which talks to the model) is never served.
app.use('/src/core', express.static(path.join(__dirname, 'src/core'), { maxAge: '1h' }));
app.use('/samples', express.static(path.join(__dirname, 'samples'), { maxAge: '1h' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    modelConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    warningTextLength: GOVERNMENT_WARNING.length,
  });
});

/** The rules the engine applies, exposed so the UI can show them verbatim. */
app.get('/api/rules', (_req, res) => {
  res.json({ governmentWarning: GOVERNMENT_WARNING });
});

/**
 * POST /api/verify
 * multipart/form-data: `image` (file) + `application` (JSON string)
 *
 * One label per request. Batching is done by the client firing several of
 * these concurrently, which keeps the server stateless and lets results
 * stream back to the agent as each finishes rather than waiting for the
 * slowest label in a batch of three hundred.
 */
app.post('/api/verify', upload.single('image'), async (req, res) => {
  const started = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No label image was uploaded.' });
    }

    let application = {};
    if (req.body.application) {
      try {
        application = JSON.parse(req.body.application);
      } catch {
        return res.status(400).json({ error: 'The application data was not valid JSON.' });
      }
    }

    const { extraction, timing } = await extractLabel(req.file.buffer, req.file.mimetype);
    const result = verifyLabel({ application, extracted: extraction });

    res.json({
      ...result,
      extracted: extraction,
      timing: { ...timing, totalMs: Date.now() - started },
    });
  } catch (err) {
    console.error('verify failed:', err);
    res.status(500).json({
      error: 'The label could not be checked. Please try again.',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

/** Multer and other middleware errors arrive here as plain English. */
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That image is larger than 12 MB. Please use a smaller file.' });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'The request could not be processed.' });
  }
  res.status(404).json({ error: 'Not found.' });
});

app.listen(PORT, () => {
  console.log(`TTB Label Verification prototype listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set — /api/verify will return read errors.');
  }
});
