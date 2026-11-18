export const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chaos playground · ai-sdk-resilience</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101512;
      --panel: #18211c;
      --panel-2: #121a16;
      --line: #314239;
      --ink: #e8f4ec;
      --muted: #8ea497;
      --signal: #dff25a;
      --danger: #ff6a45;
      --warn: #ffc14a;
      --info: #8ec8ff;
      --ok: #9be7a8;
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(1200px 500px at 10% -10%, rgba(223, 242, 90, 0.08), transparent 55%),
        var(--bg);
      color: var(--ink);
      font-family: Inter, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header, main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 28px 0 8px; display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; }
    h1 { font-size: clamp(32px, 5vw, 52px); line-height: 0.95; margin: 0; letter-spacing: -0.04em; }
    h1 span { color: var(--signal); }
    .lede { max-width: 46ch; color: var(--muted); margin: 10px 0 0; }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 12px;
      font-family: "JetBrains Mono", "Cascadia Mono", ui-monospace, monospace;
      font-size: 12px;
      color: var(--signal);
      white-space: nowrap;
    }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 22px; }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .card header, .run { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .name { font-weight: 650; letter-spacing: -0.02em; }
    .model { color: var(--muted); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; }
    .lamp { width: 12px; height: 12px; border-radius: 99px; background: var(--ok); box-shadow: 0 0 0 4px rgba(155, 231, 168, 0.15); }
    .lamp.open { background: var(--danger); box-shadow: 0 0 0 4px rgba(255, 106, 69, 0.16); }
    .lamp.half-open { background: var(--warn); box-shadow: 0 0 0 4px rgba(255, 193, 74, 0.16); }
    label { display: grid; gap: 6px; margin-top: 14px; font-size: 13px; color: var(--muted); }
    label strong { color: var(--ink); font-weight: 600; }
    input[type="range"] { width: 100%; accent-color: var(--signal); height: 28px; }
    .run {
      margin-top: 12px;
      display: grid;
      grid-template-columns: 1.1fr 1fr auto;
      gap: 12px;
      align-items: end;
    }
    button {
      background: var(--signal);
      color: #14200f;
      border: 0;
      border-radius: 14px;
      min-height: 48px;
      padding: 0 18px;
      font-weight: 750;
      letter-spacing: -0.02em;
      cursor: pointer;
    }
    button:disabled { opacity: 0.55; cursor: progress; }
    .check { display: flex; align-items: center; gap: 8px; min-height: 48px; color: var(--ink); }
    .stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-top: 12px; }
    .stat { background: var(--panel-2); border-radius: 14px; padding: 12px; border: 1px solid var(--line); }
    .stat b { display: block; font-size: 22px; letter-spacing: -0.04em; }
    .stat span { color: var(--muted); font-size: 12px; }
    .timeline { margin: 12px 0 40px; display: grid; gap: 8px; }
    .empty, .error {
      border: 1px dashed var(--line);
      border-radius: 16px;
      padding: 22px;
      color: var(--muted);
    }
    .error { border-style: solid; border-color: var(--danger); color: var(--ink); }
    .row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: start; padding: 10px 12px; border-radius: 14px; background: var(--panel-2); }
    .row time { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 11px;
      border-radius: 999px;
      padding: 4px 8px;
      background: #243028;
      color: var(--ink);
    }
    .chip.ok { background: #243816; color: var(--signal); }
    .chip.bad { background: #3a201b; color: #ffb2a2; }
    .chip.warn { background: #3a3016; color: var(--warn); }
    .chip.info { background: #173044; color: var(--info); }
    footer { width: min(1120px, calc(100% - 32px)); margin: 0 auto 28px; color: var(--muted); font-size: 13px; }
    @media (max-width: 800px) {
      header { flex-direction: column; align-items: flex-start; }
      .grid, .run, .stats { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Chaos <span>playground</span></h1>
      <p class="lede">Three mock providers, one resilient model. Turn up the failure rate and watch retries, hedges, failovers, and circuit breakers on a single timeline.</p>
    </div>
    <div class="pill">mock providers only · no API keys</div>
  </header>
  <main>
    <section class="grid" id="providers"></section>
    <section class="panel run">
      <label>Batch size <strong id="batch-out">8</strong>
        <input id="batch" type="range" min="4" max="12" value="8" />
      </label>
      <label class="check"><input id="hedge" type="checkbox" checked /> Hedge after the primary gets slow</label>
      <button id="run" type="button">Run batch</button>
    </section>
    <section class="stats" id="stats" hidden>
      <div class="stat"><b id="s-rate">–</b><span>success</span></div>
      <div class="stat"><b id="s-p95">–</b><span>p95 ms</span></div>
      <div class="stat"><b id="s-retry">–</b><span>retries</span></div>
      <div class="stat"><b id="s-fall">–</b><span>failovers</span></div>
      <div class="stat"><b id="s-hedge">–</b><span>hedges</span></div>
      <div class="stat"><b id="s-open">–</b><span>breaker opens</span></div>
    </section>
    <section class="timeline" id="timeline">
      <div class="empty" id="empty">Run a batch to see the trace. Sliders change the next batch, not the one already in flight.</div>
    </section>
  </main>
  <footer>The worker calls <code>createResilientModel</code> from this repo. Every provider below is an in-process fake.</footer>
  <script>
    const providers = [
      { provider: 'openai', modelId: 'gpt-5.1', failure: 0.62, latency: 90 },
      { provider: 'anthropic', modelId: 'claude-sonnet', failure: 0.18, latency: 70 },
      { provider: 'google', modelId: 'gemini-flash', failure: 0.05, latency: 55 },
    ];
    const root = document.querySelector('#providers');
    for (const item of providers) {
      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = \`
        <header>
          <div><div class="name">\${item.provider}</div><div class="model">\${item.modelId}</div></div>
          <div class="lamp" data-lamp="\${item.provider}:\${item.modelId}" title="breaker closed"></div>
        </header>
        <label>Failure rate <strong data-out="failure">\${Math.round(item.failure * 100)}%</strong>
          <input data-key="failure" type="range" min="0" max="90" value="\${Math.round(item.failure * 100)}" />
        </label>
        <label>Latency <strong data-out="latency">\${item.latency} ms</strong>
          <input data-key="latency" type="range" min="20" max="400" value="\${item.latency}" />
        </label>\`;
      card.querySelectorAll('input').forEach((input) => {
        input.addEventListener('input', () => {
          const key = input.dataset.key;
          const out = card.querySelector('[data-out="' + key + '"]');
          out.textContent = key === 'failure' ? input.value + '%' : input.value + ' ms';
          item[key] = key === 'failure' ? Number(input.value) / 100 : Number(input.value);
        });
      });
      root.append(card);
    }
    const batch = document.querySelector('#batch');
    const batchOut = document.querySelector('#batch-out');
    batch.addEventListener('input', () => { batchOut.textContent = batch.value; });
    const button = document.querySelector('#run');
    const timeline = document.querySelector('#timeline');
    const stats = document.querySelector('#stats');

    function chip(text, kind) {
      const el = document.createElement('span');
      el.className = 'chip' + (kind ? ' ' + kind : '');
      el.textContent = text;
      return el;
    }
    function kindFor(event) {
      if (event.type === 'attempt-success') return 'ok';
      if (event.type === 'attempt-failure' || event.type === 'skip') return 'bad';
      if (event.type === 'retry' || (event.type === 'breaker' && event.to === 'half-open')) return 'warn';
      if (event.type === 'fallback' || event.type === 'hedge-start' || event.type === 'stream-failover') return 'info';
      if (event.type === 'breaker' && event.to === 'open') return 'bad';
      if (event.type === 'breaker' && event.to === 'closed') return 'ok';
      return '';
    }
    function label(event) {
      if (event.type === 'attempt-start') return event.modelId + ' try ' + event.attempt;
      if (event.type === 'attempt-success') return event.modelId + ' ok ' + event.latencyMs + 'ms';
      if (event.type === 'attempt-failure') return event.modelId + ' ' + event.classification + (event.status ? ' ' + event.status : '');
      if (event.type === 'retry') return 'retry ' + event.delayMs + 'ms';
      if (event.type === 'fallback') return event.from.modelId + ' → ' + event.to.modelId;
      if (event.type === 'hedge-start') return 'hedge ' + event.modelId;
      if (event.type === 'hedge-cancel') return 'cancel ' + event.modelId;
      if (event.type === 'breaker') return event.key.split(':')[0] + ' ' + event.to;
      if (event.type === 'skip') return 'skip ' + event.modelId;
      if (event.type === 'usage') return 'usage ' + (event.reported.outputTokens ?? 0);
      return event.type;
    }
    function paintLamps(snapshot) {
      document.querySelectorAll('[data-lamp]').forEach((lamp) => {
        lamp.className = 'lamp';
        const found = (snapshot || []).find((item) => item.key === lamp.dataset.lamp);
        if (!found) return;
        if (found.state !== 'closed') lamp.classList.add(found.state);
        lamp.title = 'breaker ' + found.state;
      });
    }
    const rows = new Map();
    function rowFor(index) {
      let row = rows.get(index);
      if (row) return row;
      row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<time>req ' + String(index + 1).padStart(2, '0') + '</time>';
      const chips = document.createElement('div');
      chips.className = 'chips';
      row.append(chips);
      timeline.append(row);
      rows.set(index, chips);
      return chips;
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Running…';
      timeline.innerHTML = '';
      rows.clear();
      stats.hidden = false;
      const body = {
        batchSize: Number(batch.value),
        hedge: document.querySelector('#hedge').checked,
        providers: providers.map((item) => ({
          provider: item.provider,
          modelId: item.modelId,
          failureRate: item.failure,
          latencyMs: item.latency,
        })),
      };
      try {
        const response = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok || !response.body) throw new Error('Playground request failed (' + response.status + ')');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === 'trace') {
              rowFor(event.request).append(chip(label(event.event), kindFor(event.event)));
              paintLamps(event.breakers);
            } else if (event.type === 'result') {
              rowFor(event.request).append(chip(event.ok ? event.latencyMs + 'ms' : event.error, event.ok ? 'ok' : 'bad'));
            } else if (event.type === 'summary') {
              document.querySelector('#s-rate').textContent = Math.round(event.successRate * 100) + '%';
              document.querySelector('#s-p95').textContent = String(event.p95Ms);
              document.querySelector('#s-retry').textContent = String(event.retries);
              document.querySelector('#s-fall').textContent = String(event.failovers);
              document.querySelector('#s-hedge').textContent = String(event.hedges);
              document.querySelector('#s-open').textContent = String(event.breakerOpens);
            } else if (event.type === 'error') {
              throw new Error(event.message);
            }
          }
        }
      } catch (error) {
        const banner = document.createElement('div');
        banner.className = 'error';
        banner.textContent = error instanceof Error ? error.message : 'The batch failed.';
        timeline.prepend(banner);
      } finally {
        button.disabled = false;
        button.textContent = 'Run batch';
      }
    });
  </script>
</body>
</html>`;
