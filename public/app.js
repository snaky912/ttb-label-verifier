/**
 * Server-backed entry point.
 *
 * Supplies `mountApp` with a `verifyOne` that posts the image to this
 * app's own /api/verify endpoint. The browser never holds an API key.
 */

import { mountApp } from './ui.js';
import { downscaleImage } from './downscale.js';

async function verifyOne(file, application, signal) {
  // Shrink before upload. A phone photo is often 4-8 MB; the model reads
  // a 1600px-wide image just as well, and the smaller payload is a large
  // part of hitting the five-second target on agency bandwidth.
  const prepared = await downscaleImage(file, 1600);

  const form = new FormData();
  form.append('image', prepared, file.name);
  form.append('application', JSON.stringify(application));

  const res = await fetch('/api/verify', { method: 'POST', body: form, signal });
  if (!res.ok) {
    let message = `Server returned ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch { /* keep the status message */ }
    throw new Error(message);
  }
  return res.json();
}

mountApp({ root: document.getElementById('app'), verifyOne });
