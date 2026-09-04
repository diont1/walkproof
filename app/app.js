/**
 * WalkProof demo PWA — IndexedDB tenant data, local auth, walks, PDF.
 * Not a licensed inspection. No GPS. No backend.
 */
(function () {
  'use strict';

  const DB_NAME = 'walkproof-demo';
  const DB_VER = 2;
  const SESSION_KEY = 'wp_session';

  const USERS = [
    { username: 'inspector1', password: 'demo', displayName: 'Alex Rivera', role: 'inspector' },
    { username: 'inspector2', password: 'demo', displayName: 'Casey Morgan', role: 'inspector' },
    { username: 'supervisor', password: 'demo', displayName: 'Jordan Lee', role: 'supervisor' }
  ];

  const COMPANY = 'Acme Building Services';
  const SITE = 'Tower B floors 2–4';
  const SITE_FLOORS = 'Floors 2–4';

  const SEED_AREAS = [
    { name: "Men's restroom 2", floorHint: 'Floor 2' },
    { name: "Women's restroom 3", floorHint: 'Floor 3' },
    { name: 'Lobby / entry', floorHint: 'Ground / entry' },
    { name: 'Break room', floorHint: 'Floor 2–4 common' }
  ];

  let db = null;
  let session = null;
  let currentWalk = null;
  let currentAreaIndex = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('walks')) {
          const store = d.createObjectStore('walks', { keyPath: 'id', autoIncrement: true });
          store.createIndex('byCreated', 'createdAt');
        }
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('photos')) {
          const ps = d.createObjectStore('photos', { keyPath: 'id' });
          ps.createIndex('byWalk', 'walkId');
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function txStore(name, mode) {
    return db.transaction(name, mode).objectStore(name);
  }

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function listWalks() {
    const all = await idbReq(txStore('walks', 'readonly').getAll());
    return (all || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function getWalk(id) {
    return idbReq(txStore('walks', 'readonly').get(id));
  }

  async function putWalk(walk) {
    const id = await idbReq(txStore('walks', 'readwrite').put(walk));
    walk.id = id;
    return walk;
  }


  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function putPhotoBlob(walkId, areaName, blob, mime) {
    const photo = {
      id: uid('photo'),
      walkId: walkId,
      areaName: areaName,
      mime: mime || blob.type || 'image/jpeg',
      blob: blob,
      createdAt: Date.now()
    };
    await idbReq(txStore('photos', 'readwrite').put(photo));
    return photo;
  }

  async function getPhotoBlob(id) {
    return idbReq(txStore('photos', 'readonly').get(id));
  }

  async function deletePhotoBlob(id) {
    await idbReq(txStore('photos', 'readwrite').delete(id));
  }

  function blobToObjectUrl(blob) {
    return URL.createObjectURL(blob);
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      const u = USERS.find((x) => x.username === (s && s.username));
      if (!u) return null;
      return { username: u.username, displayName: u.displayName, role: u.role };
    } catch (e) { return null; }
  }

  function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }

  function tryLogin(username, password) {
    const u = USERS.find(
      (x) => x.username.toLowerCase() === String(username).trim().toLowerCase() && x.password === password
    );
    if (!u) return null;
    return { username: u.username, displayName: u.displayName, role: u.role };
  }

  function $(id) { return document.getElementById(id); }

  function showScreen(which) {
    $('screen-login').classList.toggle('hidden', which !== 'login');
    $('screen-app').classList.toggle('hidden', which !== 'app');
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
    const v = $('view-' + name);
    if (v) v.classList.add('active');
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return String(ts); }
  }

  function avgAreaScores(areas) {
    const scored = (areas || []).filter((a) => typeof a.score === 'number' && !Number.isNaN(a.score));
    if (!scored.length) return null;
    return Math.round(scored.reduce((s, a) => s + a.score, 0) / scored.length);
  }

  function statusBadge(walk) {
    if (walk.attestation) return { cls: 'badge-attested', text: 'Attested' };
    if (walk.status === 'complete') return { cls: 'badge-done', text: 'Complete' };
    return { cls: 'badge-open', text: 'Open' };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function renderHome() {
    $('home-company').textContent = COMPANY;
    $('hdr-user').textContent = session.displayName;
    $('hdr-role').textContent = session.role;
    const walks = await listWalks();
    const list = $('walk-list');
    const empty = $('walk-list-empty');
    list.innerHTML = '';
    if (!walks.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    walks.forEach((w) => {
      const li = document.createElement('li');
      const badge = statusBadge(w);
      const score = typeof w.overallScore === 'number' ? w.overallScore : '—';
      li.innerHTML =
        '<div><div style="font-weight:600">' + escapeHtml(w.site || SITE) +
        '</div><div class="meta">' + escapeHtml(fmtDate(w.createdAt)) + ' · ' +
        escapeHtml(w.inspectorName || '') + ' · <span class="badge ' + badge.cls + '">' +
        badge.text + '</span></div></div><div class="score-pill">' + score + '</div>';
      li.addEventListener('click', () => openWalk(w.id));
      list.appendChild(li);
    });
  }

  async function startWalk() {
    const now = Date.now();
    const walk = {
      company: COMPANY, site: SITE, floors: SITE_FLOORS,
      createdAt: now, updatedAt: now,
      inspectorUsername: session.username, inspectorName: session.displayName,
      status: 'open', overallScore: null,
      areas: SEED_AREAS.map((a) => ({
        name: a.name, floorHint: a.floorHint, score: null, notes: '', photos: [], photoIds: [], complete: false
      })),
      attestation: null
    };
    await putWalk(walk);
    currentWalk = walk;
    showView('walk');
    renderWalk();
  }

  async function openWalk(id) {
    const w = await getWalk(id);
    if (!w) return;
    currentWalk = w;
    showView('walk');
    renderWalk();
  }

  async function persistWalk() {
    if (!currentWalk) return;
    currentWalk.updatedAt = Date.now();
    await putWalk(currentWalk);
  }

  function renderWalk() {
    const w = currentWalk;
    if (!w) return;
    $('walk-meta').textContent =
      fmtDate(w.createdAt) + ' · ' + (w.inspectorName || '') + ' · ' + (w.floors || SITE_FLOORS);
    $('overall-score').value = typeof w.overallScore === 'number' ? w.overallScore : '';
    const badge = statusBadge(w);
    const badgeEl = $('walk-status-badge');
    badgeEl.className = 'badge ' + badge.cls;
    badgeEl.textContent = badge.text;

    const list = $('area-list');
    list.innerHTML = '';
    (w.areas || []).forEach((area, idx) => {
      const li = document.createElement('li');
      li.className = area.complete ? 'complete' : 'incomplete';
      const scoreTxt = typeof area.score === 'number' ? String(area.score) : '—';
      const photoN = (area.photoIds && area.photoIds.length) || (area.photos && area.photos.length) || 0;
      li.innerHTML =
        '<div><div class="area-name">' + escapeHtml(area.name) +
        '</div><div class="area-meta">' + escapeHtml(area.floorHint || '') +
        (photoN ? ' · ' + photoN + ' photo' + (photoN === 1 ? '' : 's') : '') +
        (area.complete ? ' · done' : '') +
        '</div></div><div class="score-pill">' + scoreTxt + '</div>';
      li.addEventListener('click', () => openArea(idx));
      list.appendChild(li);
    });

    const isSupervisor = session.role === 'supervisor';
    const attestForm = $('attest-form');
    const attestDone = $('attest-done');
    const attestHint = $('attest-hint');
    attestHint.textContent = '';
    if (w.attestation) {
      attestForm.classList.add('hidden');
      attestDone.classList.remove('hidden');
      $('attest-card').classList.add('locked');
      $('attest-summary').textContent =
        'Attested by ' + w.attestation.name + ' · ' + fmtDate(w.attestation.at) +
        ' (supervisor review of this walk record)';
    } else {
      attestDone.classList.add('hidden');
      attestForm.classList.remove('hidden');
      $('attest-card').classList.remove('locked');
      $('attest-name').value = isSupervisor ? (session.displayName || 'Jordan Lee') : '';
      $('btn-attest').disabled = !isSupervisor;
      if (!isSupervisor) attestHint.textContent = 'Log in as supervisor to attest.';
    }
  }

  function openArea(idx) {
    currentAreaIndex = idx;
    const area = currentWalk.areas[idx];
    $('area-title').textContent = area.name;
    $('area-floor-hint').textContent = area.floorHint || '';
    const score = typeof area.score === 'number' ? area.score : 80;
    $('area-score').value = score;
    $('area-score-display').textContent = typeof area.score === 'number' ? String(area.score) : '—';
    $('area-notes').value = area.notes || '';
    renderPhotos(area).then(() => showView('area'));
  }

  async function renderPhotos(area) {
    const grid = $('photo-grid');
    grid.innerHTML = '';
    const ids = area.photoIds || [];
    // migrate legacy dataUrl photos into blob store once
    if ((!ids.length) && area.photos && area.photos.length) {
      area.photoIds = area.photoIds || [];
      for (const p of area.photos) {
        if (!p.dataUrl) continue;
        try {
          const res = await fetch(p.dataUrl);
          const blob = await res.blob();
          const photo = await putPhotoBlob(currentWalk.id, area.name, blob, 'image/jpeg');
          area.photoIds.push(photo.id);
        } catch (e) { console.warn(e); }
      }
      area.photos = [];
      await persistWalk();
    }
    for (let i = 0; i < (area.photoIds || []).length; i++) {
      const pid = area.photoIds[i];
      const photo = await getPhotoBlob(pid);
      if (!photo || !photo.blob) continue;
      const div = document.createElement('div');
      div.className = 'thumb';
      const img = document.createElement('img');
      img.src = blobToObjectUrl(photo.blob);
      img.alt = 'Photo ' + (i + 1);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remove-photo';
      btn.setAttribute('aria-label', 'Remove photo');
      btn.textContent = '×';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        area.photoIds = (area.photoIds || []).filter((id) => id !== pid);
        await deletePhotoBlob(pid);
        await persistWalk();
        await renderPhotos(area);
      });
      div.appendChild(img);
      div.appendChild(btn);
      grid.appendChild(div);
    }
  }

  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('image load failed'));
        img.onload = () => {
          let w = img.width, h = img.height;
          const scale = Math.min(1, maxSide / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob(function (blob) {
            if (!blob) {
              // fallback dataURL path
              const dataUrl = canvas.toDataURL('image/jpeg', quality);
              resolve({
                dataUrl: dataUrl,
                blob: null,
                name: file.name || 'photo.jpg', w: w, h: h, addedAt: Date.now()
              });
              return;
            }
            resolve({
              blob: blob,
              dataUrl: null,
              name: file.name || 'photo.jpg', w: w, h: h, addedAt: Date.now()
            });
          }, 'image/jpeg', quality);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function addPhotosFromFiles(fileList) {
    if (currentAreaIndex == null || !currentWalk) return;
    const area = currentWalk.areas[currentAreaIndex];
    if (!area.photoIds) area.photoIds = [];
    area.photos = [];
    for (const f of Array.from(fileList || [])) {
      if (!f.type || !f.type.startsWith('image/')) continue;
      try {
        const compressed = await compressImage(f, 960, 0.72);
        let blob = compressed.blob;
        if (!blob && compressed.dataUrl) {
          const res = await fetch(compressed.dataUrl);
          blob = await res.blob();
        }
        if (!blob) continue;
        const photo = await putPhotoBlob(currentWalk.id, area.name, blob, 'image/jpeg');
        area.photoIds.push(photo.id);
      } catch (err) { console.warn('photo skip', err); }
    }
    await persistWalk();
    await renderPhotos(area);
  }

  async function saveArea(markComplete) {
    const area = currentWalk.areas[currentAreaIndex];
    const scoreVal = Number($('area-score').value);
    area.score = Number.isFinite(scoreVal) ? Math.max(0, Math.min(100, Math.round(scoreVal))) : null;
    area.notes = $('area-notes').value || '';
    if (markComplete) area.complete = true;
    const auto = avgAreaScores(currentWalk.areas);
    if (auto != null && (currentWalk.overallScore == null || currentWalk._overallAuto !== false)) {
      currentWalk.overallScore = auto;
      currentWalk._overallAuto = true;
    }
    await persistWalk();
    showView('walk');
    renderWalk();
  }

  async function attestWalk() {
    if (session.role !== 'supervisor') {
      $('attest-hint').textContent = 'Supervisor role required.';
      return;
    }
    if (currentWalk.attestation) return;
    const name = ($('attest-name').value || '').trim();
    if (!name) { $('attest-hint').textContent = 'Enter attesting name.'; return; }
    currentWalk.attestation = { name: name, username: session.username, at: Date.now() };
    if (currentWalk.status !== 'complete') currentWalk.status = 'complete';
    await persistWalk();
    renderWalk();
  }

  async function downloadPdf() {
    const jspdfNS = window.jspdf;
    if (!jspdfNS || !jspdfNS.jsPDF) {
      alert('jsPDF failed to load. Check vendor/jspdf.umd.min.js');
      return;
    }
    const { jsPDF } = jspdfNS;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const w = currentWalk;
    const margin = 48;
    const pageW = doc.internal.pageSize.getWidth();
    let y = margin;

    doc.setFillColor(31, 107, 69);
    doc.rect(0, 0, pageW, 56, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('WalkProof', margin, 34);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Walk documentation demo', pageW - margin, 34, { align: 'right' });

    y = 80;
    doc.setTextColor(22, 61, 43);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(w.company || COMPANY, margin, y);
    y += 18;
    doc.setFontSize(12);
    doc.text((w.site || SITE) + ' · ' + (w.floors || SITE_FLOORS), margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.text('Inspector: ' + (w.inspectorName || '—') + '  |  Started: ' + fmtDate(w.createdAt), margin, y);
    y += 14;
    const overall = typeof w.overallScore === 'number' ? String(w.overallScore) : '—';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(31, 107, 69);
    doc.text('Overall score: ' + overall, margin, y);
    y += 22;
    doc.setDrawColor(213, 224, 218);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    doc.setTextColor(22, 61, 43);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Areas', margin, y);
    y += 14;

    (w.areas || []).forEach((area, i) => {
      if (y > 680) { doc.addPage(); y = margin; }
      const score = typeof area.score === 'number' ? String(area.score) : '—';
      const photoN = (area.photoIds && area.photoIds.length) || (area.photos && area.photos.length) || 0;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(26, 26, 26);
      doc.text((i + 1) + '. ' + area.name + '  —  score ' + score, margin, y);
      y += 12;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(90, 107, 98);
      doc.text((area.floorHint || '') + (photoN ? '  ·  ' + photoN + ' photo(s) attached' : '  ·  no photos'), margin + 12, y);
      y += 12;
      if (area.notes) {
        const lines = doc.splitTextToSize('Notes: ' + area.notes, pageW - margin * 2 - 12);
        doc.setTextColor(40, 40, 40);
        doc.text(lines, margin + 12, y);
        y += lines.length * 11 + 4;
      } else { y += 4; }
      (area.photos || []).slice(0, 2).forEach((p) => {
        if (y > 700) { doc.addPage(); y = margin; }
        try { doc.addImage(p.dataUrl, 'JPEG', margin + 12, y, 72, 54); y += 62; }
        catch (e) { /* skip */ }
      });
      if (photoN > 2) {
        doc.setFontSize(8);
        doc.setTextColor(90, 107, 98);
        doc.text('(+ ' + (photoN - 2) + ' more photo(s) in app — not all embedded)', margin + 12, y);
        y += 12;
      }
      y += 6;
    });

    if (y > 640) { doc.addPage(); y = margin; }
    y += 8;
    doc.setFillColor(238, 246, 241);
    doc.setDrawColor(31, 107, 69);
    doc.roundedRect(margin, y, pageW - margin * 2, 56, 4, 4, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(22, 61, 43);
    doc.text('Supervisor attest', margin + 12, y + 18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    if (w.attestation) {
      doc.text('Attested by ' + w.attestation.name + ' at ' + fmtDate(w.attestation.at), margin + 12, y + 34);
    } else {
      doc.setTextColor(120, 80, 20);
      doc.text('Not yet attested.', margin + 12, y + 34);
    }
    y += 72;
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    const legal =
      'WalkProof does not certify that a building is clean, safe, or code-compliant. ' +
      'This is not a licensed inspection. Supervisor attests to the walk record only. Demo — local browser data.';
    doc.text(doc.splitTextToSize(legal, pageW - margin * 2), margin, y);
    doc.save('WalkProof_' + (w.site || 'TowerB').replace(/\s+/g, '') + '_' + (w.id || 'demo') + '.pdf');
  }

  function wireEvents() {
    $('login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      $('login-error').textContent = '';
      const s = tryLogin($('login-user').value, $('login-pass').value);
      if (!s) { $('login-error').textContent = 'Invalid demo credentials.'; return; }
      session = s;
      saveSession(s);
      showScreen('app');
      showView('home');
      renderHome();
    });

    $('btn-logout').addEventListener('click', () => {
      clearSession(); session = null; currentWalk = null;
      showScreen('login');
      $('login-pass').value = '';
    });

    $('btn-start-walk').addEventListener('click', () => startWalk());
    $('btn-back-home').addEventListener('click', async () => {
      currentWalk = null; showView('home'); await renderHome();
    });
    $('btn-back-walk').addEventListener('click', () => { showView('walk'); renderWalk(); });

    $('btn-add-area').addEventListener('click', async () => {
      const name = ($('custom-area-name').value || '').trim();
      if (!name) return;
      currentWalk.areas.push({
        name: name, floorHint: 'Custom', score: null, notes: '', photos: [], photoIds: [], complete: false
      });
      $('custom-area-name').value = '';
      await persistWalk();
      renderWalk();
    });

    $('overall-score').addEventListener('change', async () => {
      const v = Number($('overall-score').value);
      if (Number.isFinite(v)) {
        currentWalk.overallScore = Math.max(0, Math.min(100, Math.round(v)));
        currentWalk._overallAuto = false;
        await persistWalk();
      }
    });

    $('btn-auto-overall').addEventListener('click', async () => {
      const auto = avgAreaScores(currentWalk.areas);
      if (auto == null) { alert('Score at least one area first.'); return; }
      currentWalk.overallScore = auto;
      currentWalk._overallAuto = true;
      $('overall-score').value = auto;
      await persistWalk();
    });

    $('btn-mark-complete').addEventListener('click', async () => {
      currentWalk.status = 'complete';
      if (currentWalk.overallScore == null) {
        const auto = avgAreaScores(currentWalk.areas);
        if (auto != null) currentWalk.overallScore = auto;
      }
      await persistWalk();
      renderWalk();
    });

    $('btn-attest').addEventListener('click', () => attestWalk());
    $('btn-download-pdf').addEventListener('click', () => downloadPdf());
    $('area-score').addEventListener('input', () => {
      $('area-score-display').textContent = $('area-score').value;
    });
    $('btn-save-area').addEventListener('click', () => saveArea(true));
    $('btn-save-area-draft').addEventListener('click', () => saveArea(false));
    $('photo-capture').addEventListener('change', async (e) => {
      await addPhotosFromFiles(e.target.files); e.target.value = '';
    });
    $('photo-file').addEventListener('change', async (e) => {
      await addPhotosFromFiles(e.target.files); e.target.value = '';
    });
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const path = location.pathname || '';
    if (!/\/app(\/|$)/.test(path)) return;
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW register failed', err));
  }

  async function boot() {
    wireEvents();
    try { await openDb(); }
    catch (err) { console.error(err); alert('IndexedDB unavailable in this browser.'); return; }
    session = loadSession();
    if (session) { showScreen('app'); showView('home'); await renderHome(); }
    else showScreen('login');
    registerSw();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
