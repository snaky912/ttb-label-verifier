/**
 * The agent-facing interface.
 *
 * Transport-agnostic on purpose: `mountApp` receives a `verifyOne`
 * function and never learns whether verification happened on a server or
 * in the browser. That is what lets the hosted demo and the self-hosted
 * build run the same interface and the same rules engine.
 */

import { GOVERNMENT_WARNING } from '../src/core/rules.js';

const VERDICT_COPY = {
  pass: { word: 'Passed', mark: '✔', cls: 'v-pass', head: 'This label passed every check.' },
  review: { word: 'Review', mark: '⚠', cls: 'v-review', head: 'An agent needs to look at this one.' },
  fail: { word: 'Problem', mark: '✖', cls: 'v-fail', head: 'This label has a problem.' },
};

/** Sarah Chen's requirement: usable results inside about five seconds. */
const LATENCY_BUDGET_MS = 5000;

/** How many labels to check at once in batch mode. */
const BATCH_CONCURRENCY = 4;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

const APPLICATION_FIELDS = [
  { id: 'brandName', label: 'Brand name', placeholder: 'OLD TOM DISTILLERY', required: true },
  { id: 'classType', label: 'Class / type', placeholder: 'Kentucky Straight Bourbon Whiskey', required: true },
  { id: 'alcoholContent', label: 'Alcohol content', placeholder: '45% Alc./Vol.', required: true },
  { id: 'netContents', label: 'Net contents', placeholder: '750 mL', required: true },
  { id: 'bottlerAddress', label: 'Bottler / producer name and address', placeholder: 'Distilled and Bottled by ...', required: false, wide: true },
  { id: 'countryOfOrigin', label: 'Country of origin (imports only)', placeholder: 'Product of Scotland', required: false, wide: true },
];

const SAMPLE_APPLICATION = {
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContent: '45% Alc./Vol.',
  netContents: '750 mL',
  bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
  countryOfOrigin: '',
};

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root
 * @param {(file: File, application: object, signal: AbortSignal) => Promise<object>} opts.verifyOne
 * @param {string} [opts.unavailableMessage]  Shown instead of the app when verification cannot run.
 */
export function mountApp({ root, verifyOne, unavailableMessage = '' }) {
  if (unavailableMessage) {
    root.append(h('div', { class: 'msg msg-error', role: 'alert' }, unavailableMessage));
    return;
  }

  const state = {
    mode: 'single',
    singleFile: null,
    batchFiles: [],
    batchApplications: new Map(), // filename -> application record
    running: false,
    abort: null,
  };

  const modeSingleBtn = h('button', {
    class: 'mode-btn', type: 'button', 'aria-pressed': 'true',
    onclick: () => setMode('single'),
  }, 'Check one label');

  const modeBatchBtn = h('button', {
    class: 'mode-btn', type: 'button', 'aria-pressed': 'false',
    onclick: () => setMode('batch'),
  }, 'Check many labels');

  const singlePanel = h('div', { id: 'panel-single' });
  const batchPanel = h('div', { id: 'panel-batch', class: 'hidden' });

  root.append(
    h('div', { class: 'modes', role: 'group', 'aria-label': 'What would you like to do?' }, modeSingleBtn, modeBatchBtn),
    singlePanel,
    batchPanel,
    rulesDisclosure(),
  );

  function setMode(mode) {
    state.mode = mode;
    modeSingleBtn.setAttribute('aria-pressed', String(mode === 'single'));
    modeBatchBtn.setAttribute('aria-pressed', String(mode === 'batch'));
    singlePanel.classList.toggle('hidden', mode !== 'single');
    batchPanel.classList.toggle('hidden', mode !== 'batch');
  }

  buildSingle(singlePanel);
  buildBatch(batchPanel);

  // ------------------------------------------------------------------
  // Single-label mode
  // ------------------------------------------------------------------
  function buildSingle(panel) {
    const inputs = new Map();

    const formGrid = h('div', { class: 'grid' },
      APPLICATION_FIELDS.map((f) => {
        const input = h('input', {
          type: 'text', id: `app-${f.id}`, name: f.id,
          placeholder: f.placeholder,
          autocomplete: 'off',
          'aria-describedby': f.required ? undefined : `hint-${f.id}`,
        });
        inputs.set(f.id, input);
        return h('div', { class: 'field', style: f.wide ? 'grid-column: 1 / -1' : '' },
          h('label', { for: `app-${f.id}` }, f.label, f.required ? '' : ' (optional)'),
          input,
          f.required ? null : h('span', { class: 'note', id: `hint-${f.id}` }, 'Leave blank if it does not apply.'),
        );
      }),
    );

    const applyExample = () => {
      for (const [id, input] of inputs) input.value = SAMPLE_APPLICATION[id] ?? '';
    };

    // Open in a working state rather than as an empty shell: an agent
    // seeing the form already filled understands what belongs in each box
    // without being told, and can clear it in one click.
    applyExample();

    const fillSample = h('button', {
      class: 'btn btn-secondary', type: 'button',
      onclick: () => {
        applyExample();
        announce('Example application details filled in.');
      },
    }, 'Fill in the example again');

    const clearForm = h('button', {
      class: 'btn btn-secondary', type: 'button',
      onclick: () => {
        for (const [, input] of inputs) input.value = '';
        inputs.get('brandName')?.focus();
        announce('Application details cleared.');
      },
    }, 'Clear these boxes');

    const fileInput = h('input', {
      type: 'file', id: 'single-file', accept: 'image/png,image/jpeg,image/webp,image/gif',
      class: 'sr-only',
      onchange: (e) => setSingleFile(e.target.files[0]),
    });

    const preview = h('div', { class: 'preview' });
    const dropZone = h('div', { class: 'drop' },
      h('p', {}, 'Drag the label picture here, or choose a file from your computer.'),
      h('label', { class: 'btn btn-secondary', for: 'single-file', style: 'display:inline-block' }, 'Choose a label picture'),
      fileInput,
      preview,
    );
    wireDropZone(dropZone, (files) => setSingleFile(files[0]));

    const checkBtn = h('button', {
      class: 'btn btn-primary', type: 'button', disabled: true,
      onclick: runSingle,
    }, 'Check this label');

    const printBtn = h('button', {
      class: 'btn btn-secondary hidden', type: 'button',
      onclick: () => window.print(),
    }, 'Print this result');

    const resultsBox = h('div', { id: 'single-results', 'aria-live': 'polite' });

    panel.append(
      step(1, 'What the application says', 'Type what the applicant declared. The tool compares this against the picture. An example is filled in to start with.', formGrid, h('div', { class: 'btn-row' }, clearForm, fillSample)),
      step(2, 'The label picture', 'A photograph or scan. An angled or slightly glared picture is fine.', dropZone),
      h('div', { class: 'btn-row' }, checkBtn, printBtn),
      resultsBox,
    );

    function setSingleFile(file) {
      if (!file) return;
      state.singleFile = file;
      preview.replaceChildren(
        h('img', { alt: `Label picture: ${file.name}`, src: URL.createObjectURL(file) }),
        h('div', { class: 'filename' }, h('strong', {}, file.name), h('br'), `${Math.round(file.size / 1024)} KB`),
      );
      checkBtn.disabled = false;
      announce(`Selected ${file.name}.`);
    }

    async function runSingle() {
      if (!state.singleFile || state.running) return;
      const application = {};
      for (const [id, input] of inputs) application[id] = input.value.trim();

      state.running = true;
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking…';
      printBtn.classList.add('hidden');
      resultsBox.replaceChildren(h('div', { class: 'msg msg-info' }, 'Reading the label… this usually takes a few seconds.'));

      const ctl = new AbortController();
      state.abort = ctl;
      const started = performance.now();
      try {
        const result = await verifyOne(state.singleFile, application, ctl.signal);
        const elapsed = Math.round(performance.now() - started);
        resultsBox.replaceChildren(renderResult(result, elapsed));
        printBtn.classList.remove('hidden');
        announce(`${VERDICT_COPY[result.verdict].word}. ${result.summary}`);
      } catch (err) {
        resultsBox.replaceChildren(
          h('div', { class: 'msg msg-error', role: 'alert' },
            h('strong', {}, 'The label could not be checked. '),
            friendlyError(err)),
        );
      } finally {
        state.running = false;
        state.abort = null;
        checkBtn.disabled = false;
        checkBtn.textContent = 'Check this label';
      }
    }
  }

  // ------------------------------------------------------------------
  // Batch mode — Janet's 300-label import drop
  // ------------------------------------------------------------------
  function buildBatch(panel) {
    const fileInput = h('input', {
      type: 'file', id: 'batch-files', multiple: true,
      accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'sr-only',
      onchange: (e) => addBatchFiles([...e.target.files]),
    });

    const csvInput = h('input', {
      type: 'file', id: 'batch-csv', accept: '.csv,text/csv', class: 'sr-only',
      onchange: (e) => loadCsv(e.target.files[0]),
    });

    const fileList = h('p', { class: 'filename' }, 'No pictures chosen yet.');
    const dropZone = h('div', { class: 'drop' },
      h('p', {}, 'Drag a whole folder of label pictures here, or choose them from your computer.'),
      h('label', { class: 'btn btn-secondary', for: 'batch-files', style: 'display:inline-block' }, 'Choose label pictures'),
      fileInput,
      h('div', { style: 'margin-top:16px' }, fileList),
    );
    wireDropZone(dropZone, (files) => addBatchFiles(files));

    const csvStatus = h('p', { class: 'note' }, 'No application spreadsheet loaded. Without one, the tool still checks the health warning and reports what each label says.');

    const csvBox = h('div', {},
      h('div', { class: 'btn-row' },
        h('label', { class: 'btn btn-secondary', for: 'batch-csv', style: 'display:inline-block' }, 'Choose a spreadsheet (CSV)'),
        csvInput,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: downloadTemplate }, 'Download a blank spreadsheet'),
      ),
      csvStatus,
    );

    const runBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onclick: runBatch }, 'Check all labels');
    const stopBtn = h('button', { class: 'btn btn-secondary hidden', type: 'button', onclick: () => state.abort?.abort() }, 'Stop');
    const exportBtn = h('button', { class: 'btn btn-secondary hidden', type: 'button', onclick: exportResults }, 'Download results (CSV)');

    const progress = h('progress', { class: 'hidden', max: 100, value: 0 });
    const progressText = h('p', { class: 'note', 'aria-live': 'polite' }, '');
    const summaryBox = h('div', { class: 'batch-summary hidden' });
    const tableBody = h('tbody');
    const tableWrap = h('div', { class: 'hidden table-scroll' },
      h('table', { class: 'batch' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Label picture'),
          h('th', { scope: 'col' }, 'Result'),
          h('th', { scope: 'col' }, 'What was found'),
          h('th', { scope: 'col' }, 'Time'),
        )),
        tableBody,
      ),
    );

    panel.append(
      step(1, 'The label pictures', 'Choose as many as you like. They are checked several at a time and results appear as each one finishes.', dropZone),
      step(2, 'The application details (optional)', 'A spreadsheet with one row per label, matched by file name. Download the blank one if you need the column headings.', csvBox),
      h('div', { class: 'btn-row' }, runBtn, stopBtn, exportBtn),
      progress, progressText, summaryBox, tableWrap,
    );

    let results = [];

    function addBatchFiles(files) {
      const images = files.filter((f) => f.type.startsWith('image/'));
      state.batchFiles = [...state.batchFiles, ...images];
      fileList.replaceChildren(
        h('strong', {}, `${state.batchFiles.length} picture${state.batchFiles.length === 1 ? '' : 's'} ready`),
        state.batchFiles.length ? h('br') : null,
        state.batchFiles.length ? state.batchFiles.slice(0, 6).map((f) => f.name).join(', ') + (state.batchFiles.length > 6 ? `, and ${state.batchFiles.length - 6} more` : '') : '',
      );
      runBtn.disabled = state.batchFiles.length === 0;
      announce(`${state.batchFiles.length} pictures ready to check.`);
    }

    async function loadCsv(file) {
      if (!file) return;
      try {
        const rows = parseCsv(await file.text());
        state.batchApplications = new Map();
        for (const row of rows) {
          const key = (row.file || row.filename || row.image || '').trim().toLowerCase();
          if (key) state.batchApplications.set(key, row);
        }
        csvStatus.textContent = `Loaded ${state.batchApplications.size} application row${state.batchApplications.size === 1 ? '' : 's'} from ${file.name}. Rows are matched to pictures by file name.`;
      } catch (err) {
        csvStatus.textContent = `That spreadsheet could not be read: ${err.message}`;
      }
    }

    async function runBatch() {
      if (state.running || !state.batchFiles.length) return;
      state.running = true;
      results = [];
      tableBody.replaceChildren();
      tableWrap.classList.remove('hidden');
      summaryBox.classList.remove('hidden');
      progress.classList.remove('hidden');
      progress.value = 0;
      progress.max = state.batchFiles.length;
      runBtn.disabled = true;
      stopBtn.classList.remove('hidden');
      exportBtn.classList.add('hidden');

      const ctl = new AbortController();
      state.abort = ctl;

      let done = 0;
      const queue = [...state.batchFiles];
      const startedAll = performance.now();

      const worker = async () => {
        while (queue.length && !ctl.signal.aborted) {
          const file = queue.shift();
          const application = state.batchApplications.get(file.name.toLowerCase()) || {};
          const started = performance.now();
          let row;
          try {
            const result = await verifyOne(file, application, ctl.signal);
            row = { file: file.name, result, ms: Math.round(performance.now() - started) };
          } catch (err) {
            row = { file: file.name, error: friendlyError(err), ms: Math.round(performance.now() - started) };
          }
          results.push(row);
          tableBody.append(batchRow(row));
          done++;
          progress.value = done;
          progressText.textContent = `Checked ${done} of ${state.batchFiles.length}.`;
          renderSummary();
        }
      };

      await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, state.batchFiles.length) }, worker));

      const totalSec = ((performance.now() - startedAll) / 1000).toFixed(1);
      progressText.textContent = ctl.signal.aborted
        ? `Stopped after ${done} of ${state.batchFiles.length}.`
        : `Finished ${done} label${done === 1 ? '' : 's'} in ${totalSec} seconds.`;
      state.running = false;
      state.abort = null;
      runBtn.disabled = false;
      stopBtn.classList.add('hidden');
      if (results.length) exportBtn.classList.remove('hidden');
      announce(progressText.textContent);
    }

    function renderSummary() {
      const counts = { pass: 0, review: 0, fail: 0, error: 0 };
      for (const r of results) {
        if (r.error) counts.error++;
        else counts[r.result.verdict]++;
      }
      summaryBox.replaceChildren(
        stat('Passed', counts.pass, 'v-pass'),
        stat('To review', counts.review, 'v-review'),
        stat('Problems', counts.fail, 'v-fail'),
        counts.error ? stat('Could not read', counts.error, '') : null,
      );
    }

    function batchRow(row) {
      if (row.error) {
        return h('tr', {},
          h('td', { class: 'row-file' }, row.file),
          h('td', {}, h('span', { class: 'tag' }, 'Error')),
          h('td', {}, row.error),
          h('td', {}, `${row.ms} ms`),
        );
      }
      const copy = VERDICT_COPY[row.result.verdict];
      const problems = row.result.fields.filter((f) => f.verdict !== 'pass');
      return h('tr', {},
        h('td', { class: 'row-file' }, row.file),
        h('td', {}, h('span', { class: `tag ${copy.cls}` }, `${copy.mark} ${copy.word}`)),
        h('td', {},
          problems.length
            ? h('ul', { style: 'margin:0; padding-left:20px' }, problems.map((f) => h('li', {}, `${f.label}: ${f.message}`)))
            : 'Everything matched.',
        ),
        h('td', { class: row.ms > LATENCY_BUDGET_MS ? 'timing over-budget' : '' }, `${(row.ms / 1000).toFixed(1)} s`),
      );
    }

    function exportResults() {
      const cols = ['file', 'verdict', 'summary', 'brandName', 'classType', 'alcoholContent', 'netContents', 'governmentWarning', 'elapsedMs'];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [cols.join(',')];
      for (const r of results) {
        if (r.error) {
          lines.push([q(r.file), q('error'), q(r.error), '', '', '', '', '', q(r.ms)].join(','));
          continue;
        }
        const byId = Object.fromEntries(r.result.fields.map((f) => [f.id, f]));
        lines.push([
          q(r.file), q(r.result.verdict), q(r.result.summary),
          q(byId.brandName?.verdict), q(byId.classType?.verdict),
          q(byId.alcoholContent?.verdict), q(byId.netContents?.verdict),
          q(byId.governmentWarning?.verdict), q(r.ms),
        ].join(','));
      }
      downloadText('label-check-results.csv', lines.join('\n') + '\n');
    }

    function downloadTemplate() {
      downloadText(
        'label-applications-template.csv',
        'file,brandName,classType,alcoholContent,netContents,bottlerAddress,countryOfOrigin\n' +
        '01-compliant.png,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,"Distilled and Bottled by Old Tom Distillery, Bardstown, KY",\n',
      );
    }
  }

  // ------------------------------------------------------------------
  // Rendering helpers
  // ------------------------------------------------------------------
  function renderResult(result, elapsedMs) {
    const copy = VERDICT_COPY[result.verdict];
    const frag = document.createDocumentFragment();

    frag.append(
      h('div', { class: `verdict-banner ${copy.cls}`, role: 'status' },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, copy.mark),
        h('div', {},
          h('h3', {}, copy.head),
          h('p', {}, result.summary),
        ),
      ),
    );

    const list = h('ul', { class: 'checks' });
    for (const f of result.fields) list.append(renderCheck(f));
    frag.append(list);

    const overBudget = elapsedMs > LATENCY_BUDGET_MS;
    frag.append(
      h('p', { class: `timing ${overBudget ? 'over-budget' : ''}` },
        'Checked in ', h('strong', {}, `${(elapsedMs / 1000).toFixed(1)} seconds`),
        overBudget ? ' — slower than the five-second target.' : ' — within the five-second target.',
      ),
    );

    const quality = result.meta?.imageQuality;
    if (quality && (quality.issues?.length || quality.legible === false)) {
      frag.append(
        h('div', { class: 'msg msg-info' },
          h('strong', {}, 'About the picture: '),
          quality.legible === false ? 'parts of this label could not be read clearly. ' : '',
          quality.issues?.length ? `Noted ${quality.issues.join(', ')}. ` : '',
          quality.note || '',
        ),
      );
    }

    return frag;
  }

  function renderCheck(f) {
    const copy = VERDICT_COPY[f.verdict];
    const li = h('li', { class: `check ${copy.cls}` },
      h('div', { class: 'check-head' },
        h('h4', { class: 'check-title' }, f.label),
        h('span', { class: `tag ${copy.cls}` }, `${copy.mark} ${copy.word}`),
      ),
      h('p', { class: 'check-msg' }, f.message),
    );

    if (f.id !== 'governmentWarning' && (f.applicationValue || f.labelValue)) {
      li.append(
        h('dl', { class: 'values' },
          h('dt', {}, 'Application'), h('dd', {}, f.applicationValue || '—'),
          h('dt', {}, 'On the label'), h('dd', {}, f.labelValue || '—'),
        ),
      );
    }

    if (f.id === 'governmentWarning' && f.detail?.diff) {
      li.append(renderDiff(f.detail.diff));
    } else if (f.id === 'governmentWarning' && f.labelValue) {
      li.append(h('div', { class: 'diff' }, h('span', { class: 'legend' }, 'Warning text found on the label:'), f.labelValue));
    }

    return li;
  }

  function renderDiff(parts) {
    const box = h('div', { class: 'diff' },
      h('span', { class: 'legend' },
        'Required wording compared with the label. ',
        h('del', {}, 'Struck through'), ' is required but missing; ',
        h('ins', {}, 'underlined'), ' is on the label but not in the required text.',
      ),
    );
    for (const p of parts) {
      if (p.type === 'same') box.append(document.createTextNode(p.value));
      else if (p.type === 'removed') box.append(h('del', {}, p.value));
      else box.append(h('ins', {}, p.value));
    }
    return box;
  }

  function rulesDisclosure() {
    return h('details', { class: 'rules' },
      h('summary', {}, 'What exact wording is the health warning checked against?'),
      h('p', { style: 'font-size:16px' }, 'Every label is compared against this text, word for word (27 CFR 16.21). "GOVERNMENT WARNING:" must also appear in capital letters.'),
      h('blockquote', {}, GOVERNMENT_WARNING),
    );
  }

  function step(n, title, hint, ...content) {
    return h('section', { class: 'step' },
      h('h2', {}, h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(n)), title),
      h('p', { class: 'hint' }, hint),
      ...content,
    );
  }

  function stat(label, n, cls) {
    return h('div', { class: `stat ${cls}` }, h('span', { class: 'n' }, String(n)), h('span', { class: 'k' }, label));
  }

  function announce(message) {
    let live = document.getElementById('live-region');
    if (!live) {
      live = h('div', { id: 'live-region', class: 'sr-only', 'aria-live': 'polite' });
      document.body.append(live);
    }
    live.textContent = message;
  }
}

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function wireDropZone(zone, onFiles) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { stop(e); zone.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { stop(e); zone.classList.remove('is-over'); }));
  zone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}

/** Minimal RFC-4180-ish CSV reader: quoted fields, embedded commas, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  const keys = header.map((k) => k.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function friendlyError(err) {
  const code = err?.code || '';
  const map = {
    not_granted: 'This page has not been allowed to use Claude. Allow it and try again.',
    rate_limited: 'Too many labels at once. Wait a moment and try again.',
    session_expired: 'Your session has expired. Sign in again and retry.',
    image_rejected: 'That picture could not be used. Try a JPEG or PNG under 20 MB.',
    images_unavailable: 'This browser session cannot send pictures for reading.',
    cancelled: 'Checking was stopped.',
    invalid_json: 'The label was read but the answer came back malformed. Try again.',
  };
  return map[code] || err?.message || 'Something went wrong. Please try again.';
}
