/* WalkProof internal demo PWA — matches PWA-SPEC.md (display name + role, no password) */
(function () {
  "use strict";

  const DB_NAME = "walkproof-demo";
  const DB_VER = 1;
  const LEGAL =
    "WalkProof does not certify that a building is clean, safe, or code-compliant. Not a licensed inspection. Supervisor attestation is the customer\u2019s.";

  const TEMPLATE = {
    id: "tpl_nightly_bsc",
    companyId: "co_acme",
    name: "Nightly QC \u2014 commercial",
    areas: [
      {
        key: "restroom_mens",
        name: "Men\u2019s restroom",
        items: ["Soap / paper stocked", "Floors dry", "Toilets / fixtures clean", "Trash emptied"],
      },
      {
        key: "restroom_womens",
        name: "Women\u2019s restroom",
        items: ["Soap / paper stocked", "Floors dry", "Mirrors / counters", "Trash emptied"],
      },
      {
        key: "lobby",
        name: "Lobby / entry",
        items: ["Glass clean", "Mats / floors", "Trash pulled", "Reception presentable"],
      },
      {
        key: "break_room",
        name: "Break room",
        items: ["Counters wiped", "Sink / trash", "Fridge note / spills checked"],
      },
    ],
  };

  const PEOPLE = [
    { id: "p_maya", companyId: "co_acme", name: "Maya Reyes", role: "inspector" },
    { id: "p_sam", companyId: "co_acme", name: "Sam Okonkwo", role: "inspector" },
    { id: "p_jordan", companyId: "co_acme", name: "Jordan Lee", role: "supervisor" },
  ];

  const COMPANY = {
    id: "co_acme",
    name: "Acme Building Services",
    brandName: "WalkProof",
  };

  const SEED_STARTED = "2026-09-03T03:40:00.000Z";
  const SEED_ENDED = "2026-09-03T04:05:00.000Z";
  const SEED_ATTESTED = "2026-09-03T04:12:00.000Z";

  let db = null;
  let session = null;
  const photoUrlCache = new Map();
  let toastTimer = null;

  const appEl = () => document.getElementById("app");

  function uid(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtWhen(iso) {
    if (!iso) return "\u2014";
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return iso;
    }
  }

  function overallFromAreas(areas) {
    const scores = (areas || [])
      .map((a) => a.score)
      .filter((n) => typeof n === "number" && !Number.isNaN(n));
    if (!scores.length) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2400);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (ev) => {
        const d = ev.target.result;
        ["meta", "company", "people", "templates", "walks", "photos", "session"].forEach((name) => {
          if (!d.objectStoreNames.contains(name)) {
            d.createObjectStore(name, { keyPath: name === "meta" || name === "session" ? "key" : "id" });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function storeGet(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function storeGetAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function storePut(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function storeDelete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function clearStore(storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function makePlaceholderBlob(label, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(40, 90, 240, 60);
    ctx.fillStyle = "#163d2b";
    ctx.font = "bold 28px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label || "photo", 160, 120);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob || new Blob([], { type: "image/png" })), "image/png");
    });
  }

  async function seedDemo(force) {
    const meta = await storeGet("meta", "seeded");
    if (meta && !force) return;

    for (const s of ["company", "people", "templates", "walks", "photos", "session", "meta"]) {
      await clearStore(s);
    }
    photoUrlCache.forEach((u) => URL.revokeObjectURL(u));
    photoUrlCache.clear();

    await storePut("company", COMPANY);
    for (const p of PEOPLE) await storePut("people", p);
    await storePut("templates", TEMPLATE);

    const colors = ["#1f6b45", "#3a7ca5", "#8a5a00", "#5a6b60", "#2d6a4f", "#40916c"];
    const photoIds = [];
    for (let i = 0; i < 6; i++) {
      const id = "ph_seed_" + i;
      const blob = await makePlaceholderBlob("photo", colors[i % colors.length]);
      await storePut("photos", { id, mime: "image/png", blob, capturedAt: SEED_STARTED });
      photoIds.push(id);
    }

    function itemResults(labels, results) {
      return labels.map((label, i) => ({ label, result: results[i] || "pass", note: "" }));
    }

    const attestedWalk = {
      id: "w_tower_b_sample",
      companyId: "co_acme",
      templateId: "tpl_nightly_bsc",
      siteName: "Tower B",
      label: "Nightly QC \u2014 Tower B, floors 2\u20134",
      floors: "2\u20134",
      status: "attested",
      inspectorId: "p_maya",
      inspectorName: "Maya Reyes",
      startedAt: SEED_STARTED,
      submittedAt: SEED_ENDED,
      attestedAt: SEED_ATTESTED,
      attestedById: "p_jordan",
      attestedByName: "Jordan Lee",
      areas: [
        {
          key: "restroom_mens",
          name: "Men\u2019s restroom 2",
          items: itemResults(TEMPLATE.areas[0].items, ["fail", "fail", "pass", "pass"]),
          photos: [
            { id: photoIds[0], mime: "image/png", blobKey: photoIds[0], capturedAt: SEED_STARTED },
            { id: photoIds[1], mime: "image/png", blobKey: photoIds[1], capturedAt: SEED_STARTED },
          ],
          score: 72,
          notes: "Soap empty; floor wet at sinks",
        },
        {
          key: "restroom_womens",
          name: "Women\u2019s restroom 3",
          items: itemResults(TEMPLATE.areas[1].items, ["pass", "pass", "fail", "pass"]),
          photos: [{ id: photoIds[2], mime: "image/png", blobKey: photoIds[2], capturedAt: SEED_STARTED }],
          score: 88,
          notes: "Stocked; mirrors streaked",
        },
        {
          key: "lobby",
          name: "Lobby / entry",
          items: itemResults(TEMPLATE.areas[2].items, ["pass", "pass", "pass", "pass"]),
          photos: [
            { id: photoIds[3], mime: "image/png", blobKey: photoIds[3], capturedAt: SEED_STARTED },
            { id: photoIds[4], mime: "image/png", blobKey: photoIds[4], capturedAt: SEED_STARTED },
          ],
          score: 94,
          notes: "Glass clean; trash pulled",
        },
        {
          key: "break_room",
          name: "Break room",
          items: itemResults(TEMPLATE.areas[3].items, ["pass", "pass", "pass"]),
          photos: [{ id: photoIds[5], mime: "image/png", blobKey: photoIds[5], capturedAt: SEED_STARTED }],
          score: 90,
          notes: "Counters wiped; fridge note left",
        },
      ],
      overallScore: 86,
    };
    await storePut("walks", attestedWalk);

    const ipPhotos = [];
    for (let i = 0; i < 2; i++) {
      const id = "ph_ip_" + i;
      const blob = await makePlaceholderBlob("photo", colors[(i + 2) % colors.length]);
      await storePut("photos", { id, mime: "image/png", blob, capturedAt: new Date().toISOString() });
      ipPhotos.push(id);
    }
    const now = new Date().toISOString();
    const inProgress = {
      id: "w_tower_b_ip",
      companyId: "co_acme",
      templateId: "tpl_nightly_bsc",
      siteName: "Tower B",
      label: "Nightly QC \u2014 Tower B, floors 5\u20136",
      floors: "5\u20136",
      status: "in_progress",
      inspectorId: "p_maya",
      inspectorName: "Maya Reyes",
      startedAt: now,
      areas: TEMPLATE.areas.map((a, idx) => {
        const filled = idx < 2;
        return {
          key: a.key,
          name: a.name + (a.key.indexOf("restroom") >= 0 ? " " + (5 + idx) : ""),
          items: a.items.map((label) => ({ label, result: filled ? "pass" : null, note: "" })),
          photos: filled
            ? [{ id: ipPhotos[idx], mime: "image/png", blobKey: ipPhotos[idx], capturedAt: now }]
            : [],
          score: filled ? (idx === 0 ? 91 : 85) : null,
          notes: filled ? (idx === 0 ? "Looking good on 5" : "Almost done") : "",
        };
      }),
      overallScore: null,
    };
    await storePut("walks", inProgress);
    await storePut("meta", { key: "seeded", at: new Date().toISOString() });
  }

  async function loadSession() {
    const row = await storeGet("session", "current");
    session = row ? row.value : null;
    return session;
  }

  async function saveSession(value) {
    session = value;
    if (value) await storePut("session", { key: "current", value });
    else await storeDelete("session", "current");
  }

  async function getWalk(id) { return storeGet("walks", id); }

  async function saveWalk(walk) {
    walk.overallScore = overallFromAreas(walk.areas);
    await storePut("walks", walk);
    return walk;
  }

  async function listWalks() {
    const all = await storeGetAll("walks");
    return all.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  }

  async function getPhotoUrl(photoId) {
    if (photoUrlCache.has(photoId)) return photoUrlCache.get(photoId);
    const row = await storeGet("photos", photoId);
    if (!row || !row.blob) return null;
    const url = URL.createObjectURL(row.blob);
    photoUrlCache.set(photoId, url);
    return url;
  }

  async function savePhotoBlob(blob, mime, capturedAt) {
    const id = uid("ph");
    await storePut("photos", { id, mime: mime || blob.type || "image/jpeg", blob, capturedAt });
    return id;
  }

  function shellHeader(title, sub) {
    const role = session ? session.role : "";
    return (
      '<header class="app-header"><div><h1>' +
      escapeHtml(title) +
      "</h1>" +
      (sub ? '<p class="sub">' + escapeHtml(sub) + "</p>" : "") +
      "</div>" +
      (role ? '<span class="tag">' + escapeHtml(role) + "</span>" : "") +
      "</header>"
    );
  }

  function renderGate() {
    appEl().innerHTML =
      '<div class="demo-banner">Internal demo. Data stays on this device. Not a licensed inspection.</div>' +
      '<div class="gate-brand"><div class="logo" aria-hidden="true">WP</div><h1>WalkProof</h1>' +
      "<p>Walkthrough QC for building-service contractors.</p></div>" +
      '<form class="card" id="gate-form">' +
      '<div class="field"><label for="displayName">Display name</label>' +
      '<input id="displayName" name="displayName" required maxlength="80" placeholder="e.g. Maya Reyes" autocomplete="name"></div>' +
      '<div class="field"><label>Role</label><div class="role-picker">' +
      '<label class="choice"><input type="radio" name="role" value="inspector" checked> Inspector</label>' +
      '<label class="choice"><input type="radio" name="role" value="supervisor"> Supervisor</label>' +
      "</div></div>" +
      '<div class="field"><label>Company</label><div class="fixed-value">Acme Building Services</div></div>' +
      '<button type="submit" class="btn">Enter demo</button></form>' +
      '<a class="link-back" href="/">Marketing site</a>';

    document.getElementById("gate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("displayName").value.trim();
      if (!name) return;
      const role = (document.querySelector('input[name="role"]:checked') || {}).value || "inspector";
      const people = await storeGetAll("people");
      let person = people.find((p) => p.role === role && p.name.toLowerCase() === name.toLowerCase());
      if (!person) person = people.find((p) => p.role === role) || null;
      await saveSession({
        displayName: name,
        role,
        personId: person ? person.id : null,
        enteredAt: new Date().toISOString(),
      });
      renderHome();
    });
  }

  function walkListButton(w) {
    const score = w.overallScore != null ? " · score " + w.overallScore : "";
    return (
      '<button type="button" class="list-item" data-walk="' +
      escapeHtml(w.id) +
      '"><div class="row"><span class="title">' +
      escapeHtml(w.label || w.siteName) +
      '</span><span class="status-pill ' +
      escapeHtml(w.status) +
      '">' +
      escapeHtml(String(w.status).replace("_", " ")) +
      "</span></div><div class=\"meta\">" +
      escapeHtml(w.inspectorName || "") +
      " · " +
      escapeHtml(fmtWhen(w.startedAt)) +
      escapeHtml(score) +
      "</div></button>"
    );
  }

  async function renderHome() {
    if (!session) return renderGate();
    const walks = await listWalks();
    const name = session.displayName;
    const role = session.role;

    let body = shellHeader("WalkProof", COMPANY.name + " · " + name);
    body += '<div class="demo-banner">Internal demo. Data stays on this device. Not a licensed inspection.</div>';

    if (role === "inspector") {
      body += '<button class="btn" id="btn-start">Start a walk</button>';
      const groups = [
        ["In progress", walks.filter((w) => w.status === "in_progress")],
        ["Submitted (awaiting attest)", walks.filter((w) => w.status === "submitted")],
        ["Attested (local)", walks.filter((w) => w.status === "attested")],
      ];
      for (const [label, list] of groups) {
        body += '<div class="section-label">' + escapeHtml(label) + "</div>";
        if (!list.length) body += '<div class="empty">None</div>';
        else {
          body += '<div class="stack">';
          for (const w of list) body += walkListButton(w);
          body += "</div>";
        }
      }
    } else {
      const queue = walks.filter((w) => w.status === "submitted");
      const recent = walks.filter((w) => w.status === "attested");
      body += '<button class="btn btn-secondary" id="btn-seed-sample">Open seed Tower B (read-only sample)</button>';
      body += '<div class="section-label">Queue — needs attest</div>';
      if (!queue.length) body += '<div class="empty">No submitted walks</div>';
      else {
        body += '<div class="stack">';
        for (const w of queue) body += walkListButton(w);
        body += "</div>";
      }
      body += '<div class="section-label">Recent attested</div>';
      if (!recent.length) body += '<div class="empty">None yet</div>';
      else {
        body += '<div class="stack">';
        for (const w of recent) body += walkListButton(w);
        body += "</div>";
      }
    }

    body +=
      '<div class="section-label">Session</div><div class="btn-row">' +
      '<button class="btn btn-secondary" id="btn-switch">Switch role</button>' +
      '<button class="btn btn-danger" id="btn-reset">Reset demo data</button></div>';

    appEl().innerHTML = body;

    const start = document.getElementById("btn-start");
    if (start) start.onclick = () => renderNewWalk();
    const seedBtn = document.getElementById("btn-seed-sample");
    if (seedBtn) seedBtn.onclick = () => renderReport("w_tower_b_sample");
    document.getElementById("btn-switch").onclick = async () => {
      await saveSession(null);
      renderGate();
    };
    document.getElementById("btn-reset").onclick = async () => {
      if (!confirm("Reset all demo data on this device?")) return;
      await seedDemo(true);
      toast("Demo data reset");
      renderHome();
    };
    appEl().querySelectorAll("[data-walk]").forEach((el) => {
      el.onclick = () => openWalk(el.getAttribute("data-walk"));
    });
  }

  async function openWalk(id) {
    const walk = await getWalk(id);
    if (!walk) return toast("Walk not found");
    if (session.role === "inspector") {
      if (walk.status === "in_progress") return renderArea(walk.id, 0);
      return renderReport(walk.id);
    }
    if (walk.status === "submitted") return renderAttest(walk.id);
    return renderReport(walk.id);
  }

  function renderNewWalk() {
    appEl().innerHTML =
      shellHeader("New walk", "From seed template") +
      '<form class="card" id="new-walk">' +
      '<div class="field"><label for="siteName">Site name</label><input id="siteName" value="Tower B" required></div>' +
      '<div class="field"><label for="label">Walk label</label><input id="label" value="Nightly QC" required></div>' +
      '<div class="field"><label for="floors">Floors / zones</label><input id="floors" value="2\u20134"></div>' +
      '<p class="muted">Started at will be set when you begin.</p>' +
      '<button type="submit" class="btn">Begin areas</button>' +
      '<button type="button" class="btn btn-ghost" id="btn-cancel">Cancel</button></form>';

    document.getElementById("btn-cancel").onclick = () => renderHome();
    document.getElementById("new-walk").onsubmit = async (e) => {
      e.preventDefault();
      const siteName = document.getElementById("siteName").value.trim();
      const label = document.getElementById("label").value.trim();
      const floors = document.getElementById("floors").value.trim();
      const walk = {
        id: uid("w"),
        companyId: "co_acme",
        templateId: TEMPLATE.id,
        siteName,
        label: label + (floors ? " \u2014 " + siteName + ", floors " + floors : ""),
        floors,
        status: "in_progress",
        inspectorId: session.personId,
        inspectorName: session.displayName,
        startedAt: new Date().toISOString(),
        areas: TEMPLATE.areas.map((a) => ({
          key: a.key,
          name: a.name,
          items: a.items.map((lab) => ({ label: lab, result: null, note: "" })),
          photos: [],
          score: null,
          notes: "",
        })),
        overallScore: null,
      };
      await saveWalk(walk);
      renderArea(walk.id, 0);
    };
  }

  async function paintPhotos(area) {
    const grid = document.getElementById("photo-grid");
    if (!grid) return;
    if (!area.photos.length) {
      grid.innerHTML = '<p class="muted">No photos yet</p>';
      return;
    }
    let html = "";
    for (const ph of area.photos) {
      const url = await getPhotoUrl(ph.blobKey || ph.id);
      html +=
        '<div class="photo-thumb" data-ph="' +
        escapeHtml(ph.id) +
        '">' +
        (url ? '<img src="' + url + '" alt="photo">' : "") +
        '<span class="cap">' +
        escapeHtml(fmtWhen(ph.capturedAt)) +
        '</span><button type="button" class="rm" aria-label="Remove">\u00d7</button></div>';
    }
    grid.innerHTML = html;
  }

  async function renderArea(walkId, areaIndex) {
    const walk = await getWalk(walkId);
    if (!walk) return renderHome();
    if (walk.status !== "in_progress") return renderReport(walkId);
    const idx = Math.max(0, Math.min(areaIndex, walk.areas.length - 1));
    const area = walk.areas[idx];

    let html =
      shellHeader(area.name, walk.label) +
      '<div class="area-nav"><span>Area ' +
      (idx + 1) +
      " of " +
      walk.areas.length +
      '</span><button class="btn-ghost" id="btn-home" type="button">Home</button></div>';

    html += '<div class="card"><h3>Checklist</h3>';
    area.items.forEach((item, i) => {
      html +=
        '<div class="checklist-item" data-item="' +
        i +
        '"><div class="label">' +
        escapeHtml(item.label) +
        '</div><div class="result-toggle">' +
        ["pass", "fail", "na"]
          .map(
            (r) =>
              '<button type="button" data-result="' +
              r +
              '" class="' +
              (item.result === r ? "active " + r : "") +
              '">' +
              r.toUpperCase() +
              "</button>"
          )
          .join("") +
        '</div><input type="text" class="item-note" data-item="' +
        i +
        '" placeholder="Optional note" value="' +
        escapeHtml(item.note || "") +
        '"></div>';
    });
    html += "</div>";

    html +=
      '<div class="card"><h3>Photos</h3>' +
      '<label class="file-btn">Add photo<input type="file" id="photo-input" accept="image/*" capture="environment"></label>' +
      '<div class="photo-grid" id="photo-grid"></div>' +
      '<p class="muted">Each photo stores capturedAt (device clock).</p></div>';

    html +=
      '<div class="card"><h3>Area score (0\u2013100)</h3>' +
      '<div class="field"><input type="number" id="area-score" min="0" max="100" step="1" value="' +
      (area.score != null ? area.score : "") +
      '" placeholder="Inspector-entered"></div>' +
      '<div class="field"><label for="area-notes">Area notes</label>' +
      '<textarea id="area-notes">' +
      escapeHtml(area.notes || "") +
      "</textarea></div></div>";

    html += '<div class="btn-row">';
    html += '<button class="btn btn-secondary" id="btn-prev" ' + (idx === 0 ? "disabled" : "") + ">Previous</button>";
    if (idx < walk.areas.length - 1) html += '<button class="btn" id="btn-next">Next area</button>';
    else html += '<button class="btn" id="btn-review">Review &amp; submit</button>';
    html += "</div>";

    async function persistAreaFields() {
      const scoreRaw = document.getElementById("area-score").value;
      const score = scoreRaw === "" ? null : Math.max(0, Math.min(100, parseInt(scoreRaw, 10)));
      area.score = Number.isFinite(score) ? score : null;
      area.notes = document.getElementById("area-notes").value.trim();
      appEl().querySelectorAll(".item-note").forEach((inp) => {
        const i = +inp.getAttribute("data-item");
        area.items[i].note = inp.value.trim();
      });
      walk.areas[idx] = area;
      await saveWalk(walk);
    }

    appEl().innerHTML = html;
    appEl().dataset.walkId = walkId;
    appEl().dataset.areaIdx = String(idx);
    await paintPhotos(area);

    document.querySelectorAll("#photo-grid .rm").forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.preventDefault();
        const thumb = btn.closest(".photo-thumb");
        const phId = thumb && thumb.getAttribute("data-ph");
        if (!phId) return;
        await persistAreaFields();
        area.photos = area.photos.filter((ph) => ph.id !== phId);
        walk.areas[idx] = area;
        await saveWalk(walk);
        renderArea(walkId, idx);
      };
    });

    document.getElementById("btn-home").onclick = () => renderHome();

    appEl().querySelectorAll(".checklist-item").forEach((row) => {
      const i = +row.getAttribute("data-item");
      row.querySelectorAll("[data-result]").forEach((btn) => {
        btn.onclick = async () => {
          area.items[i].result = btn.getAttribute("data-result");
          await persistAreaFields();
          renderArea(walkId, idx);
        };
      });
    });

    document.getElementById("photo-input").onchange = async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const capturedAt = new Date().toISOString();
      const id = await savePhotoBlob(file, file.type, capturedAt);
      area.photos.push({ id, mime: file.type, blobKey: id, capturedAt });
      await persistAreaFields();
      toast("Photo added");
      renderArea(walkId, idx);
    };

    const go = async (nextIdx) => {
      await persistAreaFields();
      if (nextIdx === "review") return renderReview(walkId);
      renderArea(walkId, nextIdx);
    };
    document.getElementById("btn-prev").onclick = () => go(idx - 1);
    const next = document.getElementById("btn-next");
    if (next) next.onclick = () => go(idx + 1);
    const review = document.getElementById("btn-review");
    if (review) review.onclick = () => go("review");
  }

  async function renderReview(walkId) {
    const walk = await getWalk(walkId);
    if (!walk) return renderHome();
    walk.overallScore = overallFromAreas(walk.areas);
    await saveWalk(walk);
    const missing = walk.areas.filter((a) => a.score == null || a.score === "");

    let html =
      shellHeader("Review walk", walk.label) +
      '<div class="card"><div class="score-big">' +
      (walk.overallScore != null ? walk.overallScore : "\u2014") +
      ' / 100</div><p class="muted">Overall = round(average of area scores)</p>' +
      '<div class="score-bar"><span style="width:' +
      (walk.overallScore || 0) +
      '%"></span></div></div>';

    html += '<div class="card"><h3>Areas</h3><div class="stack">';
    walk.areas.forEach((a, i) => {
      html +=
        '<button type="button" class="list-item" data-area="' +
        i +
        '"><div class="row"><span class="title">' +
        escapeHtml(a.name) +
        "</span><strong>" +
        (a.score != null ? a.score : "\u2014") +
        '</strong></div><div class="meta">' +
        a.photos.length +
        " photos · " +
        escapeHtml(a.notes || "No notes") +
        "</div></button>";
    });
    html += "</div></div>";
    if (missing.length) {
      html += '<div class="demo-banner">Enter a score (0\u2013100) for every area before submit.</div>';
    }
    html +=
      '<label class="choice" style="display:flex;gap:8px;align-items:flex-start;margin:12px 0">' +
      '<input type="checkbox" id="confirm-done"> <span>I completed this walk.</span></label>';
    html +=
      '<button class="btn" id="btn-submit" ' +
      (missing.length ? "disabled" : "") +
      ">Submit walk for attest</button>";
    html += '<button class="btn btn-ghost" id="btn-back">Back to areas</button>';

    appEl().innerHTML = html;
    appEl().querySelectorAll("[data-area]").forEach((el) => {
      el.onclick = () => renderArea(walkId, +el.getAttribute("data-area"));
    });
    document.getElementById("btn-back").onclick = () => renderArea(walkId, walk.areas.length - 1);
    const box = document.getElementById("confirm-done");
    const btn = document.getElementById("btn-submit");
    const sync = () => {
      btn.disabled = !!missing.length || !box.checked;
    };
    box.onchange = sync;
    sync();
    btn.onclick = async () => {
      if (!box.checked || missing.length) return;
      walk.status = "submitted";
      walk.submittedAt = new Date().toISOString();
      walk.overallScore = overallFromAreas(walk.areas);
      await saveWalk(walk);
      toast("Submitted for attest");
      renderHome();
    };
  }

  async function buildReportHtml(walk, forAttest) {
    let html =
      shellHeader(forAttest ? "Attest walk" : "Report", walk.label) +
      '<div class="card"><h2>' +
      escapeHtml(walk.label) +
      '</h2><p class="muted">' +
      escapeHtml(COMPANY.name) +
      " · " +
      escapeHtml(walk.siteName) +
      " · floors " +
      escapeHtml(walk.floors || "\u2014") +
      '</p><p class="muted">Inspector: ' +
      escapeHtml(walk.inspectorName) +
      " · Started " +
      escapeHtml(fmtWhen(walk.startedAt)) +
      '</p><div class="score-big">' +
      (walk.overallScore != null ? walk.overallScore : "\u2014") +
      ' / 100</div><div class="score-bar"><span style="width:' +
      (walk.overallScore || 0) +
      '%"></span></div></div>';

    for (const a of walk.areas) {
      html +=
        '<div class="card"><div class="row"><h3>' +
        escapeHtml(a.name) +
        "</h3><strong>" +
        (a.score != null ? a.score : "\u2014") +
        '</strong></div><p class="muted">' +
        escapeHtml(a.notes || "No notes") +
        '</p><ul style="margin:8px 0;padding-left:18px;font-size:13px">';
      for (const it of a.items || []) {
        html +=
          "<li>" +
          escapeHtml(it.label) +
          " — <strong>" +
          escapeHtml((it.result || "\u2014").toUpperCase()) +
          "</strong>" +
          (it.note ? " (" + escapeHtml(it.note) + ")" : "") +
          "</li>";
      }
      html += "</ul>";
      if (a.photos && a.photos.length) {
        html += '<div class="photo-grid">';
        for (const ph of a.photos) {
          const url = await getPhotoUrl(ph.blobKey || ph.id);
          html +=
            '<div class="photo-thumb">' +
            (url ? '<img src="' + url + '" alt="photo">' : "") +
            '<span class="cap">' +
            escapeHtml(fmtWhen(ph.capturedAt)) +
            "</span></div>";
        }
        html += "</div>";
      } else html += '<p class="muted">0 photos</p>';
      html += "</div>";
    }

    if (walk.status === "attested") {
      html +=
        '<div class="attest-strip">Attested by ' +
        escapeHtml(walk.attestedByName) +
        (walk.attestedByName === "Jordan Lee" ? ", Night Supervisor" : "") +
        " · " +
        escapeHtml(fmtWhen(walk.attestedAt)) +
        "</div>";
    } else if (walk.status === "submitted") {
      html +=
        '<div class="demo-banner">Submitted ' +
        escapeHtml(fmtWhen(walk.submittedAt)) +
        " — awaiting supervisor attest.</div>";
    }
    html += '<p class="muted" style="margin-top:12px">' + escapeHtml(LEGAL) + "</p>";
    return html;
  }

  async function renderAttest(walkId) {
    const walk = await getWalk(walkId);
    if (!walk) return renderHome();
    let html = await buildReportHtml(walk, true);
    html +=
      '<div class="stack" style="margin-top:12px">' +
      '<button class="btn" id="btn-attest">Attest report</button>' +
      '<button class="btn btn-secondary" id="btn-sendback">Send back</button>' +
      '<button class="btn btn-ghost" id="btn-home">Home</button></div>';
    appEl().innerHTML = html;
    document.getElementById("btn-home").onclick = () => renderHome();
    document.getElementById("btn-attest").onclick = async () => {
      walk.status = "attested";
      walk.attestedAt = new Date().toISOString();
      walk.attestedById = session.personId;
      walk.attestedByName = session.displayName;
      await saveWalk(walk);
      toast("Attested");
      renderReport(walkId);
    };
    document.getElementById("btn-sendback").onclick = async () => {
      const note = prompt("Optional note for inspector:") || "";
      walk.status = "in_progress";
      walk.submittedAt = null;
      if (note) walk.sendBackNote = note;
      await saveWalk(walk);
      toast("Sent back");
      renderHome();
    };
  }

  async function renderReport(walkId) {
    const walk = await getWalk(walkId);
    if (!walk) return renderHome();
    let html = await buildReportHtml(walk, false);
    html +=
      '<div class="stack" style="margin-top:12px">' +
      (walk.status === "attested" ? '<button class="btn" id="btn-pdf">Download PDF</button>' : "") +
      '<button class="btn btn-ghost" id="btn-home">Home</button></div>';
    appEl().innerHTML = html;
    document.getElementById("btn-home").onclick = () => renderHome();
    const pdfBtn = document.getElementById("btn-pdf");
    if (pdfBtn) pdfBtn.onclick = () => downloadPdf(walk);
  }

  async function downloadPdf(walk) {
    const jspdf = window.jspdf;
    if (!jspdf || !jspdf.jsPDF) {
      toast("PDF library missing");
      return;
    }
    const doc = new jspdf.jsPDF({ unit: "pt", format: "letter" });
    const margin = 48;
    let y = margin;
    const pageW = doc.internal.pageSize.getWidth();
    const maxW = pageW - margin * 2;

    function line(txt, size, style) {
      doc.setFont("helvetica", style || "normal");
      doc.setFontSize(size || 11);
      const lines = doc.splitTextToSize(String(txt), maxW);
      for (const ln of lines) {
        if (y > 720) {
          doc.addPage();
          y = margin;
        }
        doc.text(ln, margin, y);
        y += (size || 11) + 4;
      }
    }

    line(COMPANY.brandName || "WalkProof", 18, "bold");
    line(COMPANY.name, 12);
    y += 6;
    line(walk.label, 14, "bold");
    line("Site: " + walk.siteName + " · Floors: " + (walk.floors || "—"));
    line("Inspector: " + walk.inspectorName);
    line("Started: " + fmtWhen(walk.startedAt));
    if (walk.submittedAt) line("Submitted: " + fmtWhen(walk.submittedAt));
    line("Overall score: " + (walk.overallScore != null ? walk.overallScore : "—") + " / 100", 13, "bold");
    y += 8;

    for (const a of walk.areas) {
      line(a.name + " — score " + (a.score != null ? a.score : "—"), 12, "bold");
      line("Notes: " + (a.notes || "—"));
      line("Photos: " + (a.photos ? a.photos.length : 0));
      for (const it of a.items || []) {
        line(
          "  · " + it.label + ": " + (it.result || "—").toUpperCase() + (it.note ? " — " + it.note : ""),
          10
        );
      }
      y += 4;
    }

    if (walk.status === "attested") {
      y += 6;
      const who =
        walk.attestedByName + (walk.attestedByName === "Jordan Lee" ? ", Night Supervisor" : "");
      line("Attested by " + who + " · " + fmtWhen(walk.attestedAt), 11, "bold");
    }

    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90);
    const footer = doc.splitTextToSize(LEGAL, maxW);
    if (y + footer.length * 10 > 750) {
      doc.addPage();
      y = margin;
    }
    doc.text(footer, margin, y);
    doc.setTextColor(0);

    const safe = (walk.siteName || "walk").replace(/[^\w\-]+/g, "_");
    doc.save("WalkProof_" + safe + "_" + (walk.overallScore || "report") + ".pdf");
    toast("PDF downloaded");
  }

  async function boot() {
    const foot = document.getElementById("legal-footer");
    if (foot) foot.textContent = LEGAL;
    db = await openDb();
    await seedDemo(false);
    await loadSession();
    if (session) renderHome();
    else renderGate();
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (e) {}
    }
  }

  boot().catch((err) => {
    console.error(err);
    appEl().innerHTML =
      '<div class="demo-banner">Failed to start demo: ' + escapeHtml(err.message || err) + "</div>";
  });
})();
