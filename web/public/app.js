const els = {
  statusLine: document.getElementById('statusLine'),
  filters: document.querySelectorAll('[data-filter]'),
  query: document.getElementById('query'),
  limit: document.getElementById('limit'),
  logs: document.getElementById('logs'),
  logCount: document.getElementById('logCount'),
  commandModal: document.getElementById('commandModal'),
  openCommandModal: document.getElementById('openCommandModal'),
  closeCommandModal: document.getElementById('closeCommandModal'),
  command: document.getElementById('command'),
  token: document.getElementById('token'),
  sendCommand: document.getElementById('sendCommand'),
  commandResult: document.getElementById('commandResult')
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

function renderStatus(status) {
  const bot = status.bot.ready ? `Bot: ${status.bot.tag}` : 'Bot: offline';
  const bds = `BDS: ${status.bds.state} (${status.bds.message || 'no message'})`;
  els.statusLine.textContent = `${bot} | ${bds} | Logs: ${status.logs.count}/${status.logs.max}`;
}

function renderLogs(logs) {
  els.logCount.textContent = `${logs.length} shown`;
  els.logs.innerHTML = logs.map((log) => {
    const payload = log.payload ? JSON.stringify(log.payload, null, 2) : '';
    return `
      <article class="log ${escapeHtml(log.level)}">
        <div class="meta">
          <span>${escapeHtml(new Date(log.time).toLocaleString())}</span>
          <span>${escapeHtml(log.level)}</span>
          <span>${escapeHtml(log.category)}</span>
          <span>${escapeHtml(log.source)}</span>
          ${log.event ? `<span>${escapeHtml(log.event)}</span>` : ''}
        </div>
        <div class="message">${escapeHtml(log.message)}</div>
        ${payload ? `<details><summary>Payload</summary><pre class="payload">${escapeHtml(payload)}</pre></details>` : ''}
      </article>
    `;
  }).join('');
}

function getFilterValue(name) {
  return [...document.querySelectorAll(`[data-filter="${name}"] input:checked`)]
    .map((input) => input.value)
    .join(',');
}

async function refreshStatus() {
  const { status } = await fetchJson('/web/api/status');
  renderStatus(status);
}

async function refreshLogs() {
  const params = new URLSearchParams({
    category: getFilterValue('category'),
    source: getFilterValue('source'),
    level: getFilterValue('level'),
    q: els.query.value,
    limit: els.limit.value || '250'
  });
  const { logs } = await fetchJson(`/web/api/logs?${params}`);
  renderLogs(logs);
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshLogs()]).catch((err) => {
    els.statusLine.textContent = err.message;
  });
}

async function sendServerCommand() {
  const command = els.command.value.trim();
  if (!command) return;
  els.commandResult.textContent = 'Sending...';

  try {
    const result = await fetchJson('/web/api/server-command', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(els.token.value ? { 'x-admin-token': els.token.value } : {})
      },
      body: JSON.stringify({ command })
    });
    els.commandResult.textContent = JSON.stringify(result, null, 2);
    await refreshAll();
  } catch (err) {
    els.commandResult.textContent = err.message;
  }
}

async function sendAction(action) {
  els.commandResult.textContent = `${action}...`;
  try {
    const result = await fetchJson('/web/api/server-action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(els.token.value ? { 'x-admin-token': els.token.value } : {})
      },
      body: JSON.stringify({ action })
    });
    els.commandResult.textContent = JSON.stringify(result, null, 2);
    await refreshAll();
  } catch (err) {
    els.commandResult.textContent = err.message;
  }
}

for (const group of els.filters) {
  group.addEventListener('input', () => refreshLogs().catch(console.error));
}

for (const el of [els.query, els.limit]) {
  el.addEventListener('input', () => refreshLogs().catch(console.error));
}

els.openCommandModal.addEventListener('click', () => {
  els.commandModal.showModal();
  els.command.focus();
});

els.closeCommandModal.addEventListener('click', () => {
  els.commandModal.close();
});

els.sendCommand.addEventListener('click', sendServerCommand);
els.command.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendServerCommand();
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => sendAction(button.dataset.action));
});

refreshAll();
setInterval(refreshAll, 3000);
