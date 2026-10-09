const $ = id => document.getElementById(id);
let token = '', config, selected, jobs = [], renderingKey = '', approval, busy = false;
let sessionGeneration = 0;
const requests = new Set();
function notice(message = '') { $('notice').textContent = message; }
async function api(path, options = {}) {
  const generation = sessionGeneration;
  const controller = new AbortController(); requests.add(controller);
  try {
    const response = await fetch(`/api${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    const data = await response.json();
    if (generation !== sessionGeneration) throw new Error('Session closed.');
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } finally { requests.delete(controller); }
}
function element(tag, text, className) { const e = document.createElement(tag); e.textContent = text; if (className) e.className = className; return e; }
function button(text, handler, primary = false) { const b = element('button', text, primary ? 'primary' : ''); b.type = 'button'; b.onclick = () => act(handler); return b; }
async function act(fn) { if (busy) return; const generation = sessionGeneration; busy = true; notice(); try { await fn(); } catch (e) { if (generation === sessionGeneration) notice(e.message); } finally { if (generation === sessionGeneration) busy = false; } }
$('login').onsubmit = event => { event.preventDefault(); act(async () => {
  token = $('token').value.trim(); config = await api('/config'); $('token').value = '';
  $('connect').hidden = true; $('workspace').hidden = false; $('disconnect').hidden = false;
  $('typed').hidden = !config.textTestEnabled;
  $('connection').textContent = `${config.sendingEnabled ? `Mail sender: ${config.sender}` : 'Draft mode · sending disabled'}${config.aiConfigured ? '' : ' · OpenAI key missing'}`;
  await refresh();
}); };
$('disconnect').onclick = () => {
  sessionGeneration++; for (const request of requests) request.abort(); requests.clear(); busy = false;
  token = ''; jobs = []; selected = null; config = null; renderingKey = ''; approval = null; typedAttempt = null;
  $('confirmation').close(); for (const id of ['confirm-from','confirm-to','confirm-subject','confirm-body']) $(id).textContent = '';
  $('request').value = ''; $('workspace').hidden = true; $('connect').hidden = false; $('disconnect').hidden = true;
  $('detail').replaceChildren(); $('jobs').replaceChildren(); notice();
};
let typedAttempt;
$('typed').onsubmit = event => { event.preventDefault(); act(async () => {
  const text = $('request').value.trim();
  if (!typedAttempt || typedAttempt.text !== text) typedAttempt = { text, id: crypto.randomUUID() };
  const job = await api('/jobs/text', { method: 'POST', headers: { 'X-Request-ID': typedAttempt.id }, body: JSON.stringify({ text }) });
  selected = job.id; typedAttempt = null; $('request').value = ''; renderingKey = ''; await refresh();
}); };
async function refresh() {
  if (!token) return;
  const result = await api('/jobs');
  if (!token) return;
  jobs = result;
  if (!jobs.some(j => j.id === selected)) { selected = jobs[0]?.id; renderingKey = ''; }
  const list = $('jobs'); list.replaceChildren();
  for (const j of jobs) {
    const b = button(`${j.draft?.subject || (j.source === 'text' ? 'Typed test' : 'Watch recording')} · ${j.status}`, async () => { selected = j.id; renderingKey = ''; render(); });
    b.className = `job${j.id === selected ? ' selected' : ''}`; list.append(b);
  }
  render();
}
function render() {
  const job = jobs.find(j => j.id === selected);
  if (!job) { $('detail').replaceChildren(element('p', 'No requests in this session. Record on your Watch or use the typed test.', 'empty')); renderingKey = ''; return; }
  const key = JSON.stringify([job.id, job.version, job.status, job.send.status, job.error]);
  if (key === renderingKey) return;
  renderingKey = key;
  const area = $('detail'); area.replaceChildren();
  area.append(element('div', `${job.source === 'text' ? 'TYPED TEST' : 'WATCH AUDIO'} / ${job.status.toUpperCase()}`, 'eyebrow'));
  area.append(element('p', job.send.message, 'status'));
  if (job.error) area.append(element('p', job.error));
  if (!job.draft) {
    area.append(element('p', job.status === 'expired' ? 'Content cleared or expired.' : job.status === 'error' ? 'Resolve the issue above, then record or type a new request.' : 'The backend will update this request as processing completes.'));
    if (job.status === 'error') area.append(button('Clear content', async () => { await api(`/jobs/${job.id}`, { method:'DELETE' }); renderingKey = ''; await refresh(); }));
    return;
  }
  const draft = job.draft;
  area.append(element('p', `From: ${job.sender || 'Not configured'}`, 'fine'));
  const fields = {};
  for (const [name, label] of [['recipientEmail','To'], ['subject','Subject'], ['body','Message']]) {
    const lab = element('label', label); lab.htmlFor = `edit-${name}`;
    const input = document.createElement(name === 'body' ? 'textarea' : 'input'); input.id = `edit-${name}`;
    input.value = draft[name] || ''; input.disabled = job.send.status !== 'not_sent';
    if (name === 'body') { input.rows = 9; input.maxLength = 10000; } else input.maxLength = name === 'subject' ? 200 : 254;
    fields[name] = input; area.append(lab, input);
  }
  area.append(element('p', `Recipient: ${draft.recipientName || 'unspecified'} · ${job.recipientSource.replaceAll('_',' ')}`, 'fine'));
  const actions = element('div', '', 'actions');
  async function save() {
    const edited = { ...draft, recipientEmail: fields.recipientEmail.value.trim() || null, subject: fields.subject.value, body: fields.body.value };
    if (JSON.stringify(edited) === JSON.stringify(draft)) return job;
    return api(`/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ version: job.version, draft: edited }) });
  }
  if (job.send.status === 'not_sent') {
    actions.append(button('Save edits', async () => { await save(); renderingKey = ''; await refresh(); }));
    if (config.sendingEnabled) actions.append(button('Review & send', async () => {
      const saved = await save();
      approval = { ...(await api(`/jobs/${job.id}/approval`, { method:'POST', body:JSON.stringify({ version:saved.version }) })), id:job.id };
      $('confirm-from').textContent = `From: ${approval.sender}`; $('confirm-to').textContent = `To: ${approval.draft.recipientEmail}`;
      $('confirm-subject').textContent = approval.draft.subject; $('confirm-body').textContent = approval.draft.body;
      $('confirmation').showModal();
    }, true));
  }
  actions.append(button('Copy draft', async () => {
    await navigator.clipboard.writeText(`To: ${fields.recipientEmail.value}\nSubject: ${fields.subject.value}\n\n${fields.body.value}`); notice('Copied.');
  }));
  actions.append(button('Clear content', async () => { await api(`/jobs/${job.id}`, { method:'DELETE' }); renderingKey = ''; await refresh(); }));
  area.append(actions);
  const details = document.createElement('details'); details.append(element('summary','Original request'), element('pre',job.transcript || '')); area.append(details);
}
$('cancel-send').onclick = () => { approval = null; $('confirmation').close(); };
$('send').onclick = () => act(async () => {
  if (!approval) return;
  const snapshot = approval; approval = null; $('confirmation').close();
  try { await api(`/jobs/${snapshot.id}/send`, { method:'POST', body:JSON.stringify({ version:snapshot.version, approvalToken:snapshot.token }) }); }
  catch (error) { notice(`${error.message} Refresh the request status before doing anything else; do not create a duplicate email.`); }
  renderingKey = ''; await refresh();
});
setInterval(() => { if (token && !busy && !document.hidden) { const generation = sessionGeneration; refresh().catch(error => { if (generation === sessionGeneration) notice(error.message); }); } }, 2500);
