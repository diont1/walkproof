/* WalkProof demo SPA — local IndexedDB, no backend / Stripe / GPS */
(function () {
  'use strict';

  const DB_NAME = 'walkproof-demo-v3';
  const DB_VER = 1;
  const SESSION_KEY = 'wp_demo_session_v3';
  const COMPANY = 'Acme Building Services';
  const SITE = 'Tower B, floors 2–4';
  const SEED_AREAS = [
    "Men's restroom 2",
    "Women's restroom 3",
    'Lobby/entry',
    'Break room',
    'Floors 2–4',
    'Trash rooms'
  ];
  const USERS = [
    { id: 'u-insp', email: 'inspector@demo.walkproof', password: 'demo', name: 'Alex Inspector', role: 'inspector' },
    { id: 'u-sup', email: 'supervisor@demo.walkproof', password: 'demo', name: 'Sam Supervisor', role: 'supervisor' }
  ];

  const app = document.getElementById('app');
  let db = null;
  let session = null;
  let view = 'login';
  let walkId = null;
  let areaId = null;
  let errMsg = '';
  let objectUrls = [];

  function uid(p) { return p + '-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmt(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }); }
    catch (_) { return String(ts); }
  }
  function overall(walk) {
    const scored = (walk.areas || []).filter((a) => typeof a.score === 'number');
    if (!scored.length) return null;
    return Math.round(scored.reduce((s, a) => s + a.score, 0) / scored.length);
  }
  function badge(status) {
    if (status === 'done') return '<span class="badge badge-done">Done</span>';
    if (status === 'pending_attest') return '<span class="badge badge-pending">Pending attest</span>';
    return '<span class="badge badge-active">In progress</span>';
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('walks')) d.createObjectStore('walks', { keyPath: 'id' });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }
  function store(mode) { return db.transaction('walks', mode).objectStore('walks'); }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function listWalks() {
    const all = await reqP(store('readonly').getAll());
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async function getWalk(id) { return reqP(store('readonly').get(id)); }
  async function putWalk(w) { w.updatedAt = Date.now(); await reqP(store('readwrite').put(w)); return w; }
  async function delWalk(id) { await reqP(store('readwrite').delete(id)); }

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s) return null;
      return USERS.find((u) => u.email === s.email) ? s : null;
    } catch (_) { return null; }
  }
  function saveSession(u) {
    session = { email: u.email, name: u.name, role: u.role, id: u.id };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function clearSession() { session = null; localStorage.removeItem(SESSION_KEY); }

  function revoke() { objectUrls.forEach((u) => URL.revokeObjectURL(u)); objectUrls = []; }

  function shell(bodyHtml) {
    const user = session
      ? `<div class="chip"><strong>${esc(session.name)}</strong>${esc(session.role)} · ${esc(session.email)}</div>
         <button type="button" class="btn btn-sec btn-sm" data-act="logout">Log out</button>`
      : '';
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">WalkProof<span>demo</span></div>
        ${user}
      </header>
      <div class="wrap">${bodyHtml}</div>
      <footer class="foot">WalkProof demo for <strong>Acme Building Services</strong>. Not a licensed inspection. Does not certify clean, safe, or code-compliant. Local browser storage only — $0, no GPS, no Stripe.</footer>`;
    wire();
  }

  function wire() {
    app.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', onAct);
    });
    const login = app.querySelector('#login-form');
    if (login) login.addEventListener('submit', onLogin);
    const custom = app.querySelector('#custom-form');
    if (custom) custom.addEventListener('submit', onCustom);
    const range = app.querySelector('#area-score');
    if (range) range.addEventListener('input', () => {
      const v = app.querySelector('#area-score-val');
      if (v) v.textContent = range.value;
    });
    const photo = app.querySelector('#photo-input');
    if (photo) photo.addEventListener('change', onPhotos);
  }

  async function onAct(e) {
    const act = e.currentTarget.getAttribute('data-act');
    const id = e.currentTarget.getAttribute('data-id');
    if (act === 'logout') { clearSession(); walkId = null; areaId = null; return render(); }
    if (act === 'start') return startWalk();
    if (act === 'open') { walkId = id; areaId = null; return render(); }
    if (act === 'discard') {
      if (!confirm('Discard this walk?')) return;
      await delWalk(id); return render();
    }
    if (act === 'home') { walkId = null; areaId = null; return render(); }
    if (act === 'open-area') { areaId = id; return render(); }
    if (act === 'back-walk') { areaId = null; return render(); }
    if (act === 'save-area') return saveArea();
    if (act === 'submit') return submitWalk();
    if (act === 'attest') return attestWalk();
    if (act === 'pdf') return downloadPdf();
    if (act === 'rm-photo') return removePhoto(id);
  }

  async function onLogin(e) {
    e.preventDefault();
    errMsg = '';
    const email = app.querySelector('#email').value;
    const password = app.querySelector('#password').value;
    const u = USERS.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase() && x.password === password);
    if (!u) { errMsg = 'Invalid demo login. Use the seeded accounts below.'; return render(); }
    saveSession(u);
    view = 'home';
    render();
  }

  async function startWalk() {
    const now = Date.now();
    const walk = {
      id: uid('walk'),
      company: COMPANY,
      site: SITE,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      inspectorId: session.id,
      inspectorName: session.name,
      areas: SEED_AREAS.map((name) => ({ id: uid('area'), name, custom: false, notes: '', score: null, photos: [] })),
      attest: null
    };
    await putWalk(walk);
    walkId = walk.id;
    areaId = null;
    render();
  }

  async function onCustom(e) {
    e.preventDefault();
    const walk = await getWalk(walkId);
    if (!walk || walk.status !== 'in_progress') return;
    if (walk.areas.some((a) => a.custom)) { alert('Demo allows one custom item per walk.'); return; }
    const name = (app.querySelector('#custom-name').value || '').trim();
    if (!name) return;
    walk.areas.push({ id: uid('area'), name, custom: true, notes: '', score: null, photos: [] });
    await putWalk(walk);
    render();
  }

  async function saveArea() {
    const walk = await getWalk(walkId);
    const area = walk.areas.find((a) => a.id === areaId);
    area.notes = (app.querySelector('#area-notes').value || '').trim();
    area.score = Number(app.querySelector('#area-score').value);
    await putWalk(walk);
    areaId = null;
    render();
  }

  async function onPhotos(e) {
    const walk = await getWalk(walkId);
    const area = walk.areas.find((a) => a.id === areaId);
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      if ((area.photos || []).length >= 3) break;
      if (!f.type.startsWith('image/')) continue;
      area.photos = area.photos || [];
      area.photos.push(await compress(f));
    }
    await putWalk(walk);
    render();
  }

  async function removePhoto(idx) {
    const walk = await getWalk(walkId);
    const area = walk.areas.find((a) => a.id === areaId);
    area.photos.splice(Number(idx), 1);
    await putWalk(walk);
    render();
  }

  function compress(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 1280;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: c.toDataURL('image/jpeg', 0.8), addedAt: Date.now() });
        };
        img.onerror = () => resolve({ dataUrl: reader.result, addedAt: Date.now() });
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function submitWalk() {
    const walk = await getWalk(walkId);
    const missing = walk.areas.filter((a) => typeof a.score !== 'number');
    if (missing.length && !confirm(missing.length + ' area(s) unscored. Submit anyway? Average uses scored areas only.')) return;
    walk.status = 'pending_attest';
    walk.completedAt = Date.now();
    await putWalk(walk);
    alert('Submitted. Status: pending attest. Log out and sign in as supervisor to attest.');
    walkId = null;
    render();
  }

  async function attestWalk() {
    const walk = await getWalk(walkId);
    const name = (app.querySelector('#attest-name').value || '').trim();
    if (!name) { alert('Enter your name to attest.'); return; }
    walk.attest = { name, at: Date.now(), by: session.id };
    walk.status = 'done';
    await putWalk(walk);
    render();
  }

  async function downloadPdf() {
    const walk = await getWalk(walkId);
    const ns = window.jspdf;
    if (!ns || !ns.jsPDF) { alert('jsPDF missing (vendor/jspdf.umd.min.js)'); return; }
    const { jsPDF } = ns;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const m = 48;
    let y = m;
    const ensure = (n) => { if (y + n > pageH - m) { doc.addPage(); y = m; } };
    doc.setFillColor(31, 107, 69); doc.rect(0, 0, pageW, 56, 'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(18);
    doc.text('WalkProof', m, 28);
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    doc.text('Walkthrough report (demo)', m, 44);
    y = 76;
    doc.setTextColor(22,61,43); doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text(walk.company || COMPANY, m, y); y += 18;
    doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(90,99,92);
    doc.text('Site: ' + walk.site, m, y); y += 14;
    doc.text('Inspector: ' + (walk.inspectorName || '—'), m, y); y += 14;
    doc.text('Started: ' + fmt(walk.createdAt), m, y); y += 14;
    if (walk.completedAt) { doc.text('Completed: ' + fmt(walk.completedAt), m, y); y += 14; }
    const ov = overall(walk);
    y += 8; ensure(40);
    doc.setFillColor(232,240,235); doc.roundedRect(m, y, pageW - m*2, 36, 4, 4, 'F');
    doc.setTextColor(22,61,43); doc.setFont('helvetica','bold'); doc.setFontSize(12);
    doc.text('Overall score: ' + (ov == null ? '—' : ov + ' / 100') + ' (average of area scores)', m + 12, y + 23);
    y += 52;
    doc.setFont('helvetica','bold'); doc.text('Areas', m, y); y += 16;
    for (const area of walk.areas || []) {
      ensure(70);
      doc.setDrawColor(216,221,216); doc.line(m, y, pageW - m, y); y += 14;
      doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(22,61,43);
      const sc = typeof area.score === 'number' ? area.score + '/100' : '—';
      doc.text(area.name + (area.custom ? ' (custom)' : ''), m, y);
      doc.text(sc, pageW - m, y, { align: 'right' }); y += 14;
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(90,99,92);
      const notes = (area.notes || '').trim() || 'No notes.';
      const lines = doc.splitTextToSize(notes, pageW - m*2);
      ensure(lines.length * 12 + 8); doc.text(lines, m, y); y += lines.length * 12 + 4;
      const photos = area.photos || [];
      doc.text('Photos: ' + photos.length, m, y); y += 10;
      let x = m;
      for (const p of photos.slice(0, 3)) {
        ensure(80);
        try { doc.addImage(p.dataUrl, 'JPEG', x, y, 90, 68); } catch (_) {}
        x += 98;
      }
      if (photos.length) y += 78;
      y += 6;
    }
    ensure(90); y += 8;
    doc.setDrawColor(31,107,69); doc.line(m, y, pageW - m, y); y += 18;
    doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(22,61,43);
    doc.text('Supervisor attest', m, y); y += 16;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(90,99,92);
    if (walk.attest && walk.attest.name) {
      doc.text('Attested by: ' + walk.attest.name, m, y); y += 14;
      doc.text('At: ' + fmt(walk.attest.at), m, y); y += 14;
      doc.text('Status: done', m, y);
    } else {
      doc.text('Status: pending attest — not yet attested.', m, y);
    }
    y += 28; ensure(40);
    doc.setFontSize(8); doc.setTextColor(120,120,120);
    doc.text(doc.splitTextToSize('WalkProof demo report. Not a licensed inspection. Does not certify clean, safe, or code-compliant.', pageW - m*2), m, y);
    const fname = 'WalkProof_' + String(walk.site || 'site').replace(/[^\w\-]+/g, '_').slice(0, 40) + '_' + walk.id + '.pdf';
    doc.save(fname);
  }

  async function renderLogin() {
    shell(`
      <section class="card">
        <h1>Sign in</h1>
        <p class="lede">Local demo only — accounts live in this browser (IndexedDB). No backend.</p>
        ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
        <form id="login-form">
          <div class="field"><label for="email">Email</label>
            <input id="email" type="email" required value="inspector@demo.walkproof" autocomplete="username"></div>
          <div class="field"><label for="password">Password</label>
            <input id="password" type="password" required value="demo" autocomplete="current-password"></div>
          <button class="btn" type="submit">Sign in</button>
        </form>
        <div class="hint"><strong>Demo logins</strong> (password <code>demo</code>)<br>
          Inspector: <code>inspector@demo.walkproof</code><br>
          Supervisor: <code>supervisor@demo.walkproof</code></div>
      </section>`);
  }

  async function renderHome() {
    const isSup = session.role === 'supervisor';
    const walks = await listWalks();
    const filtered = isSup ? walks.filter((w) => w.status === 'pending_attest' || w.status === 'done') : walks;
    let list = '';
    if (!filtered.length) {
      list = `<li class="muted">${isSup ? 'No walks pending attest yet. Have an inspector complete one first.' : 'No walks yet.'}</li>`;
    } else {
      list = filtered.map((w) => {
        const ov = overall(w);
        return `<li class="item">
          <h3>${esc(w.site)}</h3>
          <div class="meta">${badge(w.status)} · ${esc(w.inspectorName || '')} · ${fmt(w.updatedAt)}${ov != null ? ' · score ' + ov : ''}</div>
          <div class="row">
            <button type="button" class="btn btn-sec" data-act="open" data-id="${esc(w.id)}">${isSup ? 'Open / attest' : 'Open'}</button>
            ${(!isSup && w.status === 'in_progress') ? `<button type="button" class="btn btn-sec" data-act="discard" data-id="${esc(w.id)}">Discard</button>` : '<span></span>'}
          </div>
        </li>`;
      }).join('');
    }
    shell(`
      <section class="card">
        <h1>${isSup ? 'Supervisor desk' : 'Inspector walks'}</h1>
        <p class="lede">${isSup ? 'Open completed walks to attest.' : 'Start or continue a walk for'} <strong>${esc(SITE)}</strong>.</p>
        ${isSup ? '' : '<button type="button" class="btn" data-act="start">Start walk — Tower B</button>'}
      </section>
      <ul class="list">${list}</ul>`);
  }

  async function renderWalk() {
    const walk = await getWalk(walkId);
    if (!walk) { walkId = null; return render(); }
    if (session.role === 'supervisor' || walk.status !== 'in_progress') return renderReview(walk);
    if (areaId) return renderArea(walk);
    const ov = overall(walk);
    const areas = walk.areas.map((a) => {
      const n = (a.photos || []).length;
      return `<li class="area" data-act="open-area" data-id="${esc(a.id)}">
        <div><div class="name">${esc(a.name)}${a.custom ? ' <span class="muted">(custom)</span>' : ''}</div>
        <div class="sub">${typeof a.score === 'number' ? 'Scored' : 'Not scored'} · ${n} photo${n===1?'':'s'}${a.notes ? ' · notes' : ''}</div></div>
        <div class="sc">${typeof a.score === 'number' ? a.score : '—'}</div></li>`;
    }).join('');
    shell(`
      <section class="card">
        <h1>${esc(walk.site)}</h1>
        <p class="muted">${badge(walk.status)} · ${esc(walk.company)}<br>Inspector: ${esc(walk.inspectorName)} · ${fmt(walk.createdAt)}</p>
        <div class="score-big"><div class="num">${ov == null ? '—' : ov}</div><div class="lbl">Overall score (average of area scores)</div></div>
        <h2>Checklist areas</h2>
        <ul class="list">${areas}</ul>
      </section>
      <section class="card">
        <h2>Add custom item</h2>
        <p class="muted">Demo allows one custom area per walk.</p>
        <form id="custom-form">
          <div class="field"><label for="custom-name">Area name</label>
            <input id="custom-name" maxlength="80" placeholder="e.g. Loading dock"></div>
          <button class="btn btn-sec" type="submit">Add custom area</button>
        </form>
      </section>
      <div class="row stack">
        <button type="button" class="btn btn-sec" data-act="home">Back to list</button>
        <button type="button" class="btn" data-act="submit">Submit for attest</button>
      </div>`);
  }

  async function renderArea(walk) {
    const area = walk.areas.find((a) => a.id === areaId);
    if (!area) { areaId = null; return render(); }
    const score = typeof area.score === 'number' ? area.score : 80;
    const photos = area.photos || [];
    const thumbs = photos.map((p, i) => `<div class="thumb"><img src="${p.dataUrl}" alt="Photo ${i+1}"><button type="button" class="x" data-act="rm-photo" data-id="${i}" aria-label="Remove">×</button></div>`).join('');
    shell(`
      <section class="card">
        <h1>${esc(area.name)}${area.custom ? ' (custom)' : ''}</h1>
        <div class="field"><label for="area-notes">Notes</label>
          <textarea id="area-notes">${esc(area.notes || '')}</textarea></div>
        <div class="field"><label for="area-score">Score (0–100)</label>
          <input class="range" id="area-score" type="range" min="0" max="100" value="${score}">
          <div class="rval"><span>0</span><strong id="area-score-val">${score}</strong><span>100</span></div></div>
        <div class="field"><label>Photos (1–3)</label>
          <p class="muted">${photos.length} / 3 · capture=environment</p>
          <div class="photos">${thumbs}</div>
          <label class="btn btn-sec filebtn">Add photo
            <input id="photo-input" type="file" accept="image/*" capture="environment" multiple ${photos.length >= 3 ? 'disabled' : ''}>
          </label>
        </div>
        <div class="row" style="margin-top:1rem">
          <button type="button" class="btn btn-sec" data-act="back-walk">Back</button>
          <button type="button" class="btn" data-act="save-area">Save area</button>
        </div>
      </section>`);
  }

  async function renderReview(walk) {
    const ov = overall(walk);
    const canAttest = session.role === 'supervisor' && walk.status === 'pending_attest';
    const areas = walk.areas.map((a) => {
      const n = (a.photos || []).length;
      return `<li class="area" style="cursor:default"><div><div class="name">${esc(a.name)}</div>
        <div class="sub">${n} photo${n===1?'':'s'}${a.notes ? ' · ' + esc(a.notes.slice(0,80)) : ''}</div></div>
        <div class="sc">${typeof a.score === 'number' ? a.score : '—'}</div></li>`;
    }).join('');
    let attestHtml = '';
    if (walk.attest && walk.attest.name) {
      attestHtml = `<p><strong>${esc(walk.attest.name)}</strong><br><span class="muted">${fmt(walk.attest.at)}</span></p><p class="muted">Status: done</p>`;
    } else if (canAttest) {
      attestHtml = `<p class="muted">Confirm you reviewed this walk. Attest records your name and timestamp locally.</p>
        <div class="field"><label for="attest-name">Your name</label>
          <input id="attest-name" type="text" value="${esc(session.name)}"></div>
        <button type="button" class="btn" data-act="attest">Attest walk</button>`;
    } else {
      attestHtml = `<p class="muted">Status: pending attest. Sign in as supervisor to attest.</p>`;
    }
    shell(`
      <section class="card">
        <h1>${esc(walk.site)}</h1>
        <p class="muted">${badge(walk.status)} · ${esc(walk.company)}<br>Inspector: ${esc(walk.inspectorName)} · completed ${fmt(walk.completedAt || walk.updatedAt)}</p>
        <div class="score-big"><div class="num">${ov == null ? '—' : ov}</div><div class="lbl">Overall score (average of area scores)</div></div>
        <ul class="list">${areas}</ul>
      </section>
      <section class="card attest ${walk.status === 'done' ? 'done' : ''}">
        <h2>Supervisor attest</h2>
        ${attestHtml}
      </section>
      <section class="card stack">
        <button type="button" class="btn" data-act="pdf">Download PDF report</button>
        <button type="button" class="btn btn-sec" data-act="home">Back to list</button>
      </section>`);
  }

  async function render() {
    revoke();
    errMsg = errMsg || '';
    if (!session) return renderLogin();
    if (!walkId) return renderHome();
    return renderWalk();
  }

  async function boot() {
    await openDb();
    session = loadSession();
    if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
