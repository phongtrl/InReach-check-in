/* InReach Check-In / Check-Out
   Pure vanilla JS with localStorage persistence. */

'use strict';

const STORE = {
  devices: 'inreach.devices',
  logs: 'inreach.logs',
};

const PLANS = ['Suspend', 'Enabled/Basic', 'Advanced', 'Premier', 'Deactivated'];
// Plans that represent a live, billable satellite subscription.
const ACTIVE_PLANS = new Set(['Enabled/Basic', 'Advanced', 'Premier']);
// CSS-safe token for a plan name (e.g. "Enabled/Basic" -> "EnabledBasic").
const planClass = (plan) => String(plan).replace(/[^a-z0-9]/gi, '');

/* Known IMEIs by Mini II unit number. Units not listed have no IMEI yet. */
const IMEI_MAP = {
  11: '301434032130080', 12: '301434032034150', 13: '301434032138100',
  14: '301434032727090', 15: '301434032036910', 16: '301434036584700',
  17: '301434036588640', 18: '301434036685930', 19: '301434036789480',
  20: '301434036788560', 21: '301434036781880', 22: '301434036890470',
  23: '301434036893270', 24: '301434036890090', 25: '301434036695910',
  26: '301434036897080', 27: '301434039397480', 28: '301434039390960',
  29: '301434039397690', 30: '301434039390630', 31: '301434039193600',
  32: '301434039068070', 33: '301434039267470', 34: '301434039067710',
  35: '301434039064190', 36: '301434039191460', 37: '301434039169530',
  38: '301434039500080', 39: '301434039211650', 40: '301434039807420',
  41: '301434039314620', 42: '301434039030110', 43: '301434038500810',
  44: '301434039921880', 45: '301434038504820', 46: '301434039925860',
  47: '301434039724600', 48: '301434037895590', 49: '301434038504420',
  50: '301434039720620', 51: '301434039139750',
};
const BLACK_UNITS = new Set([38, 39, 40, 41]);
const GPSMAP_IMEI = '300434036509310';

/* ---------- Storage helpers ---------- */
function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

let devices = load(STORE.devices);
let logs = load(STORE.logs);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- Small utilities ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toLocalInputValue(date) {
  const d = new Date(date);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- Derived state ---------- */
// Latest action for a device tells us if it is currently out.
function deviceStatus(deviceId) {
  // Current status follows the most recent action taken (log insertion order),
  // not the user-picked date — which is minute-granular and can be backdated,
  // so it may sort earlier than a later check-in made in the same minute.
  const entries = logs.filter((l) => l.deviceId === deviceId);
  const last = entries[entries.length - 1];
  if (last && last.action === 'out') {
    return { out: true, person: last.person, since: last.date };
  }
  return { out: false };
}

function knownPeople() {
  return [...new Set(logs.map((l) => l.person).filter(Boolean))].sort();
}

// Devices currently checked out to a given person.
function devicesForPerson(person) {
  return devices
    .filter((d) => {
      const st = deviceStatus(d.id);
      return st.out && st.person === person;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* ---------- Tabs ---------- */
function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('#' + tab.dataset.tab).classList.add('active');
    });
  });
}

/* ---------- Devices ---------- */
const deviceForm = $('#deviceForm');

function currentAction() {
  return document.querySelector('input[name="action"]:checked')?.value || 'out';
}

function renderDeviceOptions() {
  const logSelect = $('#logDevice');
  const filterSelect = $('#historyDeviceFilter');
  const prevLog = logSelect.value;
  const prevFilter = filterSelect.value;
  const action = currentAction();

  // Check-out lists available devices; check-in lists checked-out devices.
  const eligible = devices
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter((d) => {
      if (d.plan === 'Deactivated') return false; // unavailable devices aren't selectable
      return action === 'in' ? deviceStatus(d.id).out : !deviceStatus(d.id).out;
    });

  logSelect.innerHTML = eligible.length
    ? eligible.map((d) => `<option value="${d.id}">${escapeHtml(d.label)}</option>`).join('')
    : `<option value="" disabled>${action === 'in' ? 'Nothing is checked out' : 'No available devices'}</option>`;

  const allOptions = devices
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((d) => `<option value="${d.id}">${escapeHtml(d.label)}</option>`)
    .join('');
  filterSelect.innerHTML = '<option value="">All devices</option>' + allOptions;

  if (eligible.some((d) => d.id === prevLog)) logSelect.value = prevLog;
  if (devices.some((d) => d.id === prevFilter)) filterSelect.value = prevFilter;

  updateDeviceStatusHint();
}

function renderDevices() {
  const tbody = $('#deviceTable tbody');
  const query = $('#deviceSearch').value.trim().toLowerCase();

  const list = devices
    .filter((d) => {
      if (!query) return true;
      return [d.label, d.model, d.imei, d.plan]
        .some((v) => String(v).toLowerCase().includes(query));
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  $('#noDevices').hidden = list.length > 0;
  $('#deviceTable').style.display = list.length ? '' : 'none';
  $('#deviceCount').textContent = devices.length ? devices.length : '';

  const byModel = devices.reduce((acc, d) => {
    const model = d.model || 'Unknown';
    acc[model] = (acc[model] || 0) + 1;
    return acc;
  }, {});
  $('#deviceModels').innerHTML = Object.keys(byModel)
    .sort((a, b) => a.localeCompare(b))
    .map((m) => `<span class="model-chip"><strong>${byModel[m]}</strong> ${escapeHtml(m)}</span>`)
    .join('');

  tbody.innerHTML = list.map((d) => {
    const st = deviceStatus(d.id);
    const status = d.plan === 'Deactivated'
      ? `<span class="badge unavailable">Unavailable</span>`
      : st.out
        ? `<span class="badge out">Not available · ${escapeHtml(st.person)}</span>`
        : `<span class="badge in">Available</span>`;
    const imeiCell = d.imei
      ? `<span class="mono">${escapeHtml(d.imei)}</span>`
      : `<span class="muted-cell">—</span>`;
    return `
      <tr data-id="${d.id}">
        <td><strong>${escapeHtml(d.label)}</strong></td>
        <td>${escapeHtml(d.model)}</td>
        <td>${imeiCell}</td>
        <td><span class="badge plan ${planClass(d.plan)}">${escapeHtml(d.plan)}</span></td>
        <td>${status}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn icon" data-edit="${d.id}" title="Edit">✎</button>
          <button class="btn icon danger" data-del="${d.id}" title="Delete">🗑</button>
        </td>
      </tr>`;
  }).join('');
}

deviceForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#deviceId').value;
  const imei = $('#deviceImei').value.trim();

  if (imei && !/^\d{15}$/.test(imei)) {
    toast('IMEI must be exactly 15 digits (or left blank).', true);
    return;
  }

  const duplicate = imei && devices.find((d) => d.imei === imei && d.id !== id);
  if (duplicate) {
    toast('A device with that IMEI already exists.', true);
    return;
  }

  const data = {
    label: $('#deviceLabel').value.trim(),
    model: $('#deviceModel').value,
    imei,
    plan: $('#devicePlan').value,
  };

  if (id) {
    const dev = devices.find((d) => d.id === id);
    Object.assign(dev, data);
    if (data.plan === 'Suspend') releaseCheckout(dev);
    toast('Device updated.');
  } else {
    devices.push({ id: uid(), ...data });
    toast('Device added.');
  }

  save(STORE.devices, devices);
  resetDeviceForm();
  renderAll();
});

function editDevice(id) {
  const d = devices.find((x) => x.id === id);
  if (!d) return;
  $('#deviceId').value = d.id;
  $('#deviceLabel').value = d.label;
  $('#deviceModel').value = d.model;
  $('#deviceImei').value = d.imei;
  $('#devicePlan').value = d.plan;
  $('#deviceFormTitle').textContent = 'Edit device';
  $('#deviceSubmitBtn').textContent = 'Save changes';
  $('#deviceCancelBtn').hidden = false;
  deviceForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function deleteDevice(id) {
  const d = devices.find((x) => x.id === id);
  if (!d) return;
  const hasLogs = logs.some((l) => l.deviceId === id);
  const msg = hasLogs
    ? `Delete "${d.label}" and its ${logs.filter((l) => l.deviceId === id).length} log entr(y/ies)?`
    : `Delete "${d.label}"?`;
  if (!confirm(msg)) return;

  devices = devices.filter((x) => x.id !== id);
  logs = logs.filter((l) => l.deviceId !== id);
  save(STORE.devices, devices);
  save(STORE.logs, logs);
  resetDeviceForm();
  renderAll();
  toast('Device deleted.');
}

function resetDeviceForm() {
  deviceForm.reset();
  $('#deviceId').value = '';
  $('#deviceFormTitle').textContent = 'Add device';
  $('#deviceSubmitBtn').textContent = 'Add device';
  $('#deviceCancelBtn').hidden = true;
}

$('#deviceCancelBtn').addEventListener('click', resetDeviceForm);
$('#deviceSearch').addEventListener('input', renderDevices);

/* Ensures the full default fleet exists and known IMEIs are filled. Returns count added. */
function addMissingFleet() {
  const findUnit = (n) => devices.find((d) => Number(d.label.match(/inReach Mini II (\d+)/)?.[1]) === n);
  let added = 0;
  let changed = false;

  // GPSMAP 66i
  let gps = devices.find((d) => d.label === 'GPSMAP 66i');
  if (!gps) {
    devices.push({ id: uid(), label: 'GPSMAP 66i', model: 'GPSMAP 66i', imei: GPSMAP_IMEI, plan: 'Enabled/Basic' });
    added++;
  } else if (!gps.imei) {
    gps.imei = GPSMAP_IMEI;
    changed = true;
  }

  // inReach Mini II 11-51
  for (let n = 11; n <= 51; n++) {
    const suffix = BLACK_UNITS.has(n) ? ' (black)' : '';
    const existing = findUnit(n);
    if (!existing) {
      devices.push({ id: uid(), label: `inReach Mini II ${n}${suffix}`, model: 'inReach Mini 2', imei: IMEI_MAP[n] || '', plan: 'Enabled/Basic' });
      added++;
      continue;
    }
    if (!existing.imei && IMEI_MAP[n]) { existing.imei = IMEI_MAP[n]; changed = true; }
    if (BLACK_UNITS.has(n) && !/\(black\)/i.test(existing.label)) { existing.label = `inReach Mini II ${n} (black)`; changed = true; }
  }

  if (added || changed) save(STORE.devices, devices);
  return added;
}

/* Seed the default fleet. Skips units already present. */
function seedMiniFleet() {
  const added = addMissingFleet();
  if (!added) { toast('Default fleet already loaded.'); return; }
  renderAll();
  toast(`Added ${added} device${added === 1 ? '' : 's'}.`);
}

/* Rename legacy "Mini II #NN" labels to the "inReach Mini II NN" format. */
function migrateLabels() {
  let changed = false;
  devices.forEach((d) => {
    const m = d.label.match(/^Mini II #(\d+)$/);
    if (m) { d.label = `inReach Mini II ${m[1]}`; changed = true; }
    if (d.plan === 'Enabled' || d.plan === 'Basic') { d.plan = 'Enabled/Basic'; changed = true; }
  });
  if (changed) save(STORE.devices, devices);
}

/* One-time: fill in known IMEIs and mark black units, without touching manual edits. */
function applyImeiData() {
  if (localStorage.getItem('inreach.imei.v1')) return;
  let changed = false;
  devices.forEach((d) => {
    if (d.label === 'GPSMAP 66i' && !d.imei) { d.imei = GPSMAP_IMEI; changed = true; }
    const m = d.label.match(/inReach Mini II (\d+)/);
    if (!m) return;
    const n = Number(m[1]);
    if (BLACK_UNITS.has(n) && !/\(black\)/i.test(d.label)) {
      d.label = `inReach Mini II ${n} (black)`;
      changed = true;
    }
    if (IMEI_MAP[n] && !d.imei) { d.imei = IMEI_MAP[n]; changed = true; }
  });
  if (changed) save(STORE.devices, devices);
  localStorage.setItem('inreach.imei.v1', '1');
}

/* One-time: fill newly-known IMEIs, mark unit 41 black, and add unit 51. */
function applyImeiDataV2() {
  if (localStorage.getItem('inreach.imei.v2')) return;
  let changed = false;
  devices.forEach((d) => {
    const m = d.label.match(/inReach Mini II (\d+)/);
    if (!m) return;
    const n = Number(m[1]);
    if (BLACK_UNITS.has(n) && !/\(black\)/i.test(d.label)) {
      d.label = `inReach Mini II ${n} (black)`;
      changed = true;
    }
    if (IMEI_MAP[n] && !d.imei) { d.imei = IMEI_MAP[n]; changed = true; }
  });
  if (!devices.some((d) => /inReach Mini II 51\b/.test(d.label))) {
    devices.push({ id: uid(), label: 'inReach Mini II 51', model: 'inReach Mini 2', imei: IMEI_MAP[51], plan: 'Enabled/Basic' });
    changed = true;
  }
  if (changed) save(STORE.devices, devices);
  localStorage.setItem('inreach.imei.v2', '1');
}

$('#seedFleetBtn').addEventListener('click', seedMiniFleet);

$('#deviceTable').addEventListener('click', (e) => {
  const editId = e.target.closest('[data-edit]')?.dataset.edit;
  const delId = e.target.closest('[data-del]')?.dataset.del;
  if (editId) editDevice(editId);
  if (delId) deleteDevice(delId);
});

/* Suspending a device frees it: release any active check-out so it reads Available. */
function releaseCheckout(dev) {
  const st = deviceStatus(dev.id);
  if (!st.out) return;
  logs.push({ id: uid(), deviceId: dev.id, person: st.person, action: 'in', date: new Date().toISOString(), notes: '' });
  save(STORE.logs, logs);
}

/* Right-click a device row to change its status or subscription plan. */
function openPlanMenu(x, y, deviceId) {
  const dev = devices.find((d) => d.id === deviceId);
  if (!dev) return;
  const menu = $('#planMenu');
  const st = deviceStatus(dev.id);

  let statusHtml;
  if (dev.plan === 'Deactivated') {
    statusHtml = `<div class="cm-note">Unavailable · deactivated</div>`;
  } else if (st.out) {
    statusHtml = `<button type="button" data-action="in"><span>Check in</span><span class="cm-sub">${escapeHtml(st.person)}</span></button>`;
  } else {
    statusHtml = `<button type="button" data-action="out"><span>Check out…</span></button>`;
  }

  menu.innerHTML =
    `<div class="cm-title">${escapeHtml(dev.label)}</div>` +
    statusHtml +
    `<div class="cm-sep"></div>` +
    `<div class="cm-title">Plan</div>` +
    PLANS.map((p) => `
      <button type="button" data-plan="${p}">
        <span>${p}</span>
        ${p === dev.plan ? '<span class="cm-check">✓</span>' : ''}
      </button>`).join('');

  menu.hidden = false;
  // Keep the menu within the viewport.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  menu.dataset.deviceId = deviceId;
}

function closePlanMenu() {
  const menu = $('#planMenu');
  menu.hidden = true;
  delete menu.dataset.deviceId;
}

/* Replace the menu with an inline check-out form (person + subscription). */
function renderCheckoutForm(dev) {
  const menu = $('#planMenu');
  menu.innerHTML =
    `<div class="cm-title">Check out ${escapeHtml(dev.label)}</div>` +
    `<div class="cm-form">` +
    `<input class="cm-input" id="cmPerson" type="text" placeholder="Person name" list="peopleList" autocomplete="off" />` +
    `<select class="cm-select" id="cmPlan">` +
    PLANS.map((p) => `<option value="${p}"${p === dev.plan ? ' selected' : ''}>${p}</option>`).join('') +
    `</select>` +
    `<button type="button" class="cm-confirm" data-confirm>Check out</button>` +
    `</div>`;
  $('#cmPerson').focus();
}

function checkoutFromMenu(dev) {
  const plan = $('#cmPlan').value;
  // Deactivating needs no person — it just marks the device Unavailable.
  if (plan === 'Deactivated') {
    dev.plan = 'Deactivated';
    save(STORE.devices, devices);
    closePlanMenu();
    renderAll();
    toast(`${dev.label} deactivated.`);
    return;
  }
  // Suspending needs no person — it frees the device (Available).
  if (plan === 'Suspend') {
    dev.plan = 'Suspend';
    releaseCheckout(dev);
    save(STORE.devices, devices);
    closePlanMenu();
    renderAll();
    toast(`${dev.label} suspended · available.`);
    return;
  }
  const person = $('#cmPerson').value.trim();
  if (!person) { $('#cmPerson').focus(); return; }
  logs.push({ id: uid(), deviceId: dev.id, person, action: 'out', date: new Date().toISOString(), notes: '' });
  save(STORE.logs, logs);
  if (plan && dev.plan !== plan) { dev.plan = plan; }
  save(STORE.devices, devices);
  closePlanMenu();
  renderAll();
  toast(`${dev.label} checked out to ${person}.`);
}

$('#deviceTable').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  e.preventDefault();
  openPlanMenu(e.clientX, e.clientY, row.dataset.id);
});

$('#planMenu').addEventListener('click', (e) => {
  const id = $('#planMenu').dataset.deviceId;
  if (!id) return;
  const dev = devices.find((d) => d.id === id);
  if (!dev) { closePlanMenu(); return; }

  const action = e.target.closest('[data-action]')?.dataset.action;
  const plan = e.target.closest('[data-plan]')?.dataset.plan;

  if (action === 'in') {
    const st = deviceStatus(id);
    logs.push({ id: uid(), deviceId: id, person: st.person, action: 'in', date: new Date().toISOString(), notes: '' });
    save(STORE.logs, logs);
    closePlanMenu();
    renderAll();
    toast(`${dev.label} checked in.`);
  } else if (action === 'out') {
    renderCheckoutForm(dev); // keep menu open for input
  } else if (e.target.closest('[data-confirm]')) {
    checkoutFromMenu(dev);
  } else if (plan) {
    dev.plan = plan;
    if (plan === 'Suspend') releaseCheckout(dev);
    save(STORE.devices, devices);
    renderAll();
    toast(`${dev.label} set to ${plan}.`);
    closePlanMenu();
  }
});

$('#planMenu').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'cmPerson') return;
  e.preventDefault();
  const dev = devices.find((d) => d.id === $('#planMenu').dataset.deviceId);
  if (dev) checkoutFromMenu(dev);
});

$('#planMenu').addEventListener('change', (e) => {
  if (e.target.id !== 'cmPlan') return;
  const val = e.target.value;
  const noPerson = val === 'Deactivated' || val === 'Suspend';
  const btn = $('#planMenu .cm-confirm');
  const person = $('#cmPerson');
  if (btn) btn.textContent = val === 'Deactivated' ? 'Deactivate' : val === 'Suspend' ? 'Set available' : 'Check out';
  if (person) { person.disabled = noPerson; person.placeholder = noPerson ? 'Not needed' : 'Person name'; }
});

document.addEventListener('click', (e) => {
  // Ignore clicks on elements detached by a menu re-render.
  if (!document.contains(e.target)) return;
  if (!$('#planMenu').hidden && !$('#planMenu').contains(e.target)) closePlanMenu();
});
document.addEventListener('scroll', closePlanMenu, true);
window.addEventListener('resize', closePlanMenu);

/* ---------- Check in / out ---------- */
const logForm = $('#logForm');

function updateDeviceStatusHint() {
  const id = $('#logDevice').value;
  const hint = $('#deviceStatusHint');
  const dev = devices.find((d) => d.id === id);
  // Pre-select the device's current subscription.
  if (dev) $('#logPlan').value = dev.plan;
  if (!id) { hint.textContent = ''; return; }

  const st = deviceStatus(id);
  hint.textContent = st.out
    ? `Currently checked out by ${st.person} since ${formatDateTime(st.since)}.`
    : 'Currently available.';
}

$('#logDevice').addEventListener('change', updateDeviceStatusHint);
document.querySelectorAll('input[name="action"]').forEach((r) =>
  r.addEventListener('change', renderDeviceOptions));

function renderPeople() {
  $('#peopleList').innerHTML = knownPeople()
    .map((p) => `<option value="${escapeHtml(p)}"></option>`)
    .join('');
}

logForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const deviceId = $('#logDevice').value;
  const person = $('#logPerson').value.trim();
  const action = document.querySelector('input[name="action"]:checked').value;
  const dateVal = $('#logDate').value;
  const selectedPlan = $('#logPlan').value;

  if (!deviceId) { toast('Select a device.', true); return; }

  // Deactivating just sets the device Unavailable — no person or log needed.
  if (selectedPlan === 'Deactivated') {
    const dev = devices.find((d) => d.id === deviceId);
    if (dev) { dev.plan = 'Deactivated'; save(STORE.devices, devices); }
    logForm.reset();
    setPickerDate(new Date());
    renderAll();
    toast(`${dev ? dev.label : 'Device'} deactivated.`);
    return;
  }

  if (!person) { toast('Enter a person name.', true); return; }
  if (!dateVal) { toast('Pick a date and time.', true); return; }

  const st = deviceStatus(deviceId);
  if (action === 'out' && st.out) {
    toast(`Already checked out by ${st.person}.`, true);
    return;
  }
  if (action === 'in' && !st.out) {
    toast('Device is not checked out.', true);
    return;
  }

  logs.push({
    id: uid(),
    deviceId,
    person,
    action,
    date: new Date(dateVal).toISOString(),
    notes: $('#logNotes').value.trim(),
    plan: selectedPlan,
  });
  save(STORE.logs, logs);

  // Apply the chosen subscription to the device.
  const dev = devices.find((d) => d.id === deviceId);
  if (dev && selectedPlan && dev.plan !== selectedPlan) {
    dev.plan = selectedPlan;
    if (selectedPlan === 'Suspend') releaseCheckout(dev);
    save(STORE.devices, devices);
  }

  logForm.reset();
  setPickerDate(new Date());
  renderAll();
  toast(action === 'out' ? 'Checked out.' : 'Checked in.');
});

function renderCheckedOut() {
  const container = $('#checkedOutList');

  // Capture current item positions for a FLIP reflow animation.
  const oldRects = new Map();
  container.querySelectorAll('.status-item[data-id]').forEach((el) => {
    oldRects.set(el.dataset.id, el.getBoundingClientRect());
  });

  const out = devices
    .map((d) => ({ d, st: deviceStatus(d.id) }))
    .filter((x) => x.st.out)
    .sort((a, b) => a.d.label.localeCompare(b.d.label));

  if (!out.length) {
    confirmingCheckin = null;
    container.innerHTML = '<p class="empty">Nothing is checked out right now.</p>';
    return;
  }

  container.innerHTML = out.map(({ d, st }) => {
    const controls = confirmingCheckin === d.id
      ? `<div class="confirm-inline">
          <span class="confirm-text">Confirm check-in?</span>
          <button class="btn ghost" data-cancelin>No</button>
          <button class="btn primary" data-confirmin="${d.id}">Yes</button>
        </div>`
      : `<button class="btn ghost" data-quickin="${d.id}">Check in</button>`;
    return `
    <div class="status-item" data-id="${d.id}">
      <div>
        <strong>${escapeHtml(d.label)}</strong>
        <span class="badge plan ${planClass(d.plan)}">${escapeHtml(d.plan)}</span>
        <div class="who">${escapeHtml(st.person)} · since ${formatDateTime(st.since)}</div>
      </div>
      ${controls}
    </div>`;
  }).join('');

  // Play the FLIP: existing rows slide from their old spot, new rows fade in.
  container.querySelectorAll('.status-item[data-id]').forEach((el) => {
    const old = oldRects.get(el.dataset.id);
    if (old) {
      const dx = old.left - el.getBoundingClientRect().left;
      const dy = old.top - el.getBoundingClientRect().top;
      if (dx || dy) {
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1)';
          el.style.transform = '';
        });
      }
    } else {
      el.classList.add('item-enter');
    }
  });
}

let confirmingCheckin = null;

$('#checkedOutList').addEventListener('click', (e) => {
  const askId = e.target.closest('[data-quickin]')?.dataset.quickin;
  const confirmId = e.target.closest('[data-confirmin]')?.dataset.confirmin;
  const cancel = e.target.closest('[data-cancelin]');

  if (askId) { confirmingCheckin = askId; renderCheckedOut(); return; }
  if (cancel) { confirmingCheckin = null; renderCheckedOut(); return; }
  if (!confirmId) return;

  const st = deviceStatus(confirmId);
  logs.push({
    id: uid(),
    deviceId: confirmId,
    person: st.person,
    action: 'in',
    date: new Date().toISOString(),
    notes: '',
  });
  save(STORE.logs, logs);
  confirmingCheckin = null;
  renderAll();
  toast('Checked in.');
});

/* ---------- People (rename across all logs) ---------- */
let editingPerson = null;

function renderPeopleManage() {
  const container = $('#peopleManage');
  const people = knownPeople();
  if (!people.length) {
    editingPerson = null;
    container.innerHTML = '<p class="empty">No people yet.</p>';
    return;
  }
  container.innerHTML = people.map((p) => {
    if (p === editingPerson) {
      return `
        <div class="user-item editing">
          <input class="user-input" id="personEditInput" type="text"
            value="${escapeHtml(p)}" autocomplete="off" />
          <button class="btn icon" data-save="${escapeHtml(p)}" title="Save">✓</button>
          <button class="btn icon" data-cancel title="Cancel">✕</button>
        </div>`;
    }
    return `
      <div class="user-item">
        <div class="user-main">
          <span class="user-name">${escapeHtml(p)}</span>
          <button class="btn icon" data-rename="${escapeHtml(p)}" title="Rename">✎</button>
        </div>
        ${(() => {
          const assigned = devicesForPerson(p);
          return assigned.length
            ? `<div class="user-devices">${assigned
                .map((d) => `<span class="device-chip">${escapeHtml(d.label)}</span>`)
                .join('')}</div>`
            : '<p class="user-devices empty-note">No devices currently checked out to them.</p>';
        })()}
      </div>`;
  }).join('');
  if (editingPerson) {
    const inp = $('#personEditInput');
    if (inp) { inp.focus(); inp.select(); }
  }
}

function renamePerson(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) { renderPeopleManage(); return; }
  logs.forEach((l) => { if (l.person === oldName) l.person = newName; });
  save(STORE.logs, logs);
  renderAll();
  toast(`Renamed “${oldName}” to “${newName}”.`);
}

$('#peopleManage').addEventListener('click', (e) => {
  const rename = e.target.closest('[data-rename]');
  const saveBtn = e.target.closest('[data-save]');
  const cancel = e.target.closest('[data-cancel]');
  if (rename) { editingPerson = rename.dataset.rename; renderPeopleManage(); }
  else if (cancel) { editingPerson = null; renderPeopleManage(); }
  else if (saveBtn) {
    const oldName = saveBtn.dataset.save;
    const newName = $('#personEditInput').value;
    editingPerson = null;
    renamePerson(oldName, newName);
  }
});

$('#peopleManage').addEventListener('keydown', (e) => {
  if (e.target.id !== 'personEditInput') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const oldName = editingPerson;
    const newName = e.target.value;
    editingPerson = null;
    renamePerson(oldName, newName);
  } else if (e.key === 'Escape') {
    editingPerson = null;
    renderPeopleManage();
  }
});

/* ---------- History ---------- */
function filteredLogs() {
  const dev = $('#historyDeviceFilter').value;
  const act = $('#historyActionFilter').value;
  const q = $('#historySearch').value.trim().toLowerCase();

  return logs
    .filter((l) => (!dev || l.deviceId === dev))
    .filter((l) => (!act || l.action === act))
    .filter((l) => {
      if (!q) return true;
      return [l.person, l.notes].some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function deviceLabel(id) {
  const d = devices.find((x) => x.id === id);
  return d ? d.label : '(deleted device)';
}

function renderHistory() {
  const tbody = $('#historyTable tbody');
  const list = filteredLogs();

  $('#noHistory').hidden = list.length > 0;
  $('#historyTable').style.display = list.length ? '' : 'none';

  tbody.innerHTML = list.map((l) => `
    <tr>
      <td class="mono">${formatDateTime(l.date)}</td>
      <td><span class="badge ${l.action}">${l.action === 'out' ? 'Check out' : 'Check in'}</span></td>
      <td>${escapeHtml(deviceLabel(l.deviceId))}</td>
      <td>${escapeHtml(l.person)}</td>
      <td>${escapeHtml(l.notes || '')}</td>
      <td style="text-align:right;">
        <button class="btn icon danger" data-dellog="${l.id}" title="Delete entry">🗑</button>
      </td>
    </tr>`).join('');
}

$('#historyTable').addEventListener('click', (e) => {
  const id = e.target.closest('[data-dellog]')?.dataset.dellog;
  if (!id) return;
  if (!confirm('Delete this log entry?')) return;
  logs = logs.filter((l) => l.id !== id);
  save(STORE.logs, logs);
  renderAll();
  toast('Entry deleted.');
});

['#historyDeviceFilter', '#historyActionFilter', '#historySearch'].forEach((sel) => {
  $(sel).addEventListener('input', renderHistory);
});

$('#exportBtn').addEventListener('click', () => {
  const list = filteredLogs();
  if (!list.length) { toast('Nothing to export.', true); return; }

  const rows = [['Date', 'Action', 'Device', 'IMEI', 'Person', 'Notes']];
  list.forEach((l) => {
    const d = devices.find((x) => x.id === l.deviceId);
    rows.push([
      new Date(l.date).toISOString(),
      l.action === 'out' ? 'Check out' : 'Check in',
      d ? d.label : '(deleted)',
      d ? d.imei : '',
      l.person,
      l.notes || '',
    ]);
  });

  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inreach-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#backupBtn').addEventListener('click', () => {
  const backup = {
    app: 'InReach Check-In',
    version: 1,
    exportedAt: new Date().toISOString(),
    devices,
    logs,
  };

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}`;

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `InReachCI-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded.');
});

let pendingImport = null;

$('#importBtn').addEventListener('click', () => $('#backupFile').click());

$('#backupFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow picking the same file again later
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { toast('Invalid backup file.', true); return; }
    if (!data || !Array.isArray(data.devices) || !Array.isArray(data.logs)) {
      toast('Not a valid InReach backup.', true);
      return;
    }
    pendingImport = data;
    const when = data.exportedAt ? formatDateTime(data.exportedAt) : 'an unknown date';
    $('#importConfirm').innerHTML = `
      <span class="ic-text">Replace all current data with backup from ${escapeHtml(when)} —
        <strong>${data.devices.length}</strong> device${data.devices.length === 1 ? '' : 's'},
        <strong>${data.logs.length}</strong> log${data.logs.length === 1 ? '' : 's'}?</span>
      <button type="button" class="btn ghost" data-import-cancel>Cancel</button>
      <button type="button" class="btn danger" data-import-confirm>Replace all</button>`;
    $('#importConfirm').hidden = false;
  };
  reader.onerror = () => toast('Could not read file.', true);
  reader.readAsText(file);
});

$('#importConfirm').addEventListener('click', (e) => {
  if (e.target.closest('[data-import-cancel]')) {
    pendingImport = null;
    $('#importConfirm').hidden = true;
    return;
  }
  if (e.target.closest('[data-import-confirm]') && pendingImport) {
    devices = pendingImport.devices;
    logs = pendingImport.logs;
    save(STORE.devices, devices);
    save(STORE.logs, logs);
    pendingImport = null;
    $('#importConfirm').hidden = true;
    migrateLabels();
    renderAll();
    toast('Backup imported.');
  }
});

/* ---------- Reports: activity by quarter and month ---------- */
const QUARTER_NAMES = ['Q1 · Jan–Mar', 'Q2 · Apr–Jun', 'Q3 · Jul–Sep', 'Q4 · Oct–Dec'];

function reportYears() {
  return [...new Set(logs.map((l) => new Date(l.date).getFullYear()))].sort((a, b) => b - a);
}

function selectedReportYear() {
  const v = $('#reportYear').value;
  return v ? Number(v) : (reportYears()[0] || new Date().getFullYear());
}

// Returns per-month {out, in} counts for the given year.
function monthlyCounts(year) {
  const months = Array.from({ length: 12 }, () => ({ out: 0, in: 0 }));
  logs.forEach((l) => {
    const d = new Date(l.date);
    if (d.getFullYear() !== year) return;
    months[d.getMonth()][l.action]++;
  });
  return months;
}

function quarterlyCounts(months) {
  const q = Array.from({ length: 4 }, () => ({ out: 0, in: 0 }));
  months.forEach((c, m) => {
    const qi = Math.floor(m / 3);
    q[qi].out += c.out;
    q[qi].in += c.in;
  });
  return q;
}

// Subscription-licence picture: current assignment plus check-out history per plan.
// Older logs predate per-entry plan capture, so they fall back to the device's
// current plan for the usage tallies.
function licenceStats(year) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const blank = () => PLANS.reduce((o, p) => { o[p] = 0; return o; }, {});
  const current = blank();
  devices.forEach((d) => { current[d.plan] = (current[d.plan] || 0) + 1; });
  const activeCount = devices.filter((d) => ACTIVE_PLANS.has(d.plan)).length;

  const usedYear = blank();
  const usedAll = blank();
  logs.forEach((l) => {
    if (l.action !== 'out') return;
    const plan = l.plan || byId.get(l.deviceId)?.plan;
    if (!plan) return;
    usedAll[plan] = (usedAll[plan] || 0) + 1;
    if (new Date(l.date).getFullYear() === year) usedYear[plan] = (usedYear[plan] || 0) + 1;
  });

  return { current, activeCount, usedYear, usedAll };
}

function licenceStatusLabel(plan) {
  if (ACTIVE_PLANS.has(plan)) return 'Active';
  if (plan === 'Suspend') return 'Suspended';
  if (plan === 'Deactivated') return 'Deactivated';
  return '—';
}

// Renders the on-page "Subscription licences" card.
function renderLicences(year) {
  const s = licenceStats(year);
  $('#activeLicenceCount').textContent = `${s.activeCount} active`;

  const chips = PLANS
    .filter((p) => s.current[p] > 0)
    .map((p) => `<span class="licence-chip ${planClass(p)}"><strong>${s.current[p]}</strong> ${escapeHtml(p)}</span>`)
    .join('');
  $('#licenceChips').innerHTML = chips || '<span class="muted-cell">No devices yet.</span>';

  $('#licenceTable tbody').innerHTML = PLANS.map((p) => `
    <tr>
      <td><span class="badge plan ${planClass(p)}">${escapeHtml(p)}</span></td>
      <td>${licenceStatusLabel(p)}</td>
      <td>${s.current[p] || 0}</td>
      <td>${s.usedYear[p] || 0}</td>
      <td><strong>${s.usedAll[p] || 0}</strong></td>
    </tr>`).join('');
}

// Renders the on-page "Activity log" card — every check-out and check-in for the year.
function renderActivityLog(year) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const rows = logs
    .filter((l) => new Date(l.date).getFullYear() === year)
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const outCount = rows.filter((l) => l.action === 'out').length;
  const inCount = rows.length - outCount;
  $('#activityLogCount').textContent = rows.length ? `${outCount} out · ${inCount} in` : '';
  $('#noActivityLog').hidden = rows.length > 0;
  $('#activityLogTable').style.display = rows.length ? '' : 'none';

  $('#activityLogTable tbody').innerHTML = rows.map((l) => {
    const dev = byId.get(l.deviceId);
    const badge = l.action === 'in'
      ? '<span class="badge act-in">Check-in</span>'
      : '<span class="badge act-out">Check-out</span>';
    return `
      <tr>
        <td>${escapeHtml(formatDateTime(l.date))}</td>
        <td>${badge}</td>
        <td>${escapeHtml(dev ? dev.label : 'Unknown device')}</td>
        <td>${escapeHtml(l.person || '')}</td>
        <td>${escapeHtml(l.notes || '')}</td>
      </tr>`;
  }).join('');
}

function renderReports() {
  const years = reportYears();
  const yearSel = $('#reportYear');
  const prev = yearSel.value;
  yearSel.innerHTML = (years.length ? years : [new Date().getFullYear()])
    .map((y) => `<option value="${y}">${y}</option>`)
    .join('');
  if (years.map(String).includes(prev)) yearSel.value = prev;

  const year = selectedReportYear();
  const months = monthlyCounts(year);
  const quarters = quarterlyCounts(months);

  const totalOut = months.reduce((s, c) => s + c.out, 0);
  const totalIn = months.reduce((s, c) => s + c.in, 0);
  const totalActivity = totalOut + totalIn;
  const yearLogs = logs.filter((l) => new Date(l.date).getFullYear() === year);
  const people = new Set(yearLogs.map((l) => l.person).filter(Boolean)).size;
  const busiestIdx = months.reduce(
    (best, c, i, arr) => (c.out + c.in > arr[best].out + arr[best].in ? i : best), 0);
  const busiest = totalActivity ? MONTHS[busiestIdx].slice(0, 3) : '—';
  const activeMonths = months.filter((c) => c.out + c.in > 0).length;
  const avgPerMonth = activeMonths ? Math.round(totalActivity / activeMonths) : 0;

  $('#reportSummary').innerHTML = [
    { label: 'Check-outs', value: totalOut, cls: 'out' },
    { label: 'Check-ins', value: totalIn, cls: 'in' },
    { label: 'Total activity', value: totalActivity, cls: 'accent' },
    { label: 'People', value: people, cls: 'plain' },
    { label: 'Busiest month', value: busiest, cls: 'accent' },
    { label: 'Avg / active month', value: avgPerMonth, cls: 'plain' },
  ].map((c) => `
    <div class="stat ${c.cls}">
      <span class="stat-value">${c.value}</span>
      <span class="stat-label">${c.label}</span>
    </div>`).join('');

  renderMonthChart(months);
  renderFleetDonut();
  renderTopUsers(yearLogs);
  renderLicences(year);
  renderActivityLog(year);

  const peak = Math.max(...quarters.map((c) => c.out + c.in), 1);
  $('#quarterTable tbody').innerHTML = quarters.map((c, i) => {
    const total = c.out + c.in;
    return `
    <tr>
      <td>${QUARTER_NAMES[i]}</td>
      <td>${c.out}</td>
      <td>${c.in}</td>
      <td><strong>${total}</strong></td>
      <td>${shareBar(c.out, c.in, peak)}</td>
    </tr>`;
  }).join('');

  const peakMonth = Math.max(...months.map((c) => c.out + c.in), 1);
  $('#monthTable tbody').innerHTML = months.map((c, m) => {
    const total = c.out + c.in;
    return `
    <tr>
      <td>${MONTHS[m]}</td>
      <td>${c.out}</td>
      <td>${c.in}</td>
      <td><strong>${total}</strong></td>
      <td>${shareBar(c.out, c.in, peakMonth)}</td>
    </tr>`;
  }).join('');
}

// Horizontal split bar showing out/in proportion relative to the busiest row.
function shareBar(out, inn, peak) {
  const total = out + inn;
  if (!total) return '<span class="muted-cell">—</span>';
  const scale = (total / peak) * 100;
  const outPct = (out / total) * 100;
  const inPct = (inn / total) * 100;
  return `
    <div class="share-bar" style="width:${scale.toFixed(1)}%" title="${out} out · ${inn} in">
      <span class="seg-out" style="width:${outPct.toFixed(1)}%"></span>
      <span class="seg-in" style="width:${inPct.toFixed(1)}%"></span>
    </div>`;
}

// Vertical grouped bar chart of check-outs and check-ins for each month.
function renderMonthChart(months) {
  const chart = $('#monthChart');
  const empty = $('#noReportActivity');
  const peak = Math.max(...months.map((c) => Math.max(c.out, c.in)), 1);
  const hasData = months.some((c) => c.out || c.in);
  if (empty) empty.hidden = hasData;
  chart.hidden = !hasData;
  chart.innerHTML = months.map((c, m) => {
    const outH = (c.out / peak) * 100;
    const inH = (c.in / peak) * 100;
    return `
      <div class="bar-col" title="${MONTHS[m]}: ${c.out} out, ${c.in} in">
        <div class="bar-stack">
          <span class="bar out" style="height:${outH.toFixed(1)}%">${c.out ? `<em>${c.out}</em>` : ''}</span>
          <span class="bar in" style="height:${inH.toFixed(1)}%">${c.in ? `<em>${c.in}</em>` : ''}</span>
        </div>
        <span class="bar-label">${MONTHS[m].slice(0, 1)}</span>
      </div>`;
  }).join('');
}

// Live fleet composition: available, checked out, deactivated.
function renderFleetDonut() {
  const out = devices.filter((d) => d.plan !== 'Deactivated' && deviceStatus(d.id).out).length;
  const deactivated = devices.filter((d) => d.plan === 'Deactivated').length;
  const available = devices.length - out - deactivated;
  const total = devices.length || 1;

  const parts = [
    { label: 'Available', value: available, color: 'var(--sage)' },
    { label: 'Checked out', value: out, color: 'var(--clay)' },
    { label: 'Deactivated', value: deactivated, color: 'var(--muted)' },
  ];

  let acc = 0;
  const stops = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const start = (acc / total) * 360;
      acc += p.value;
      const end = (acc / total) * 360;
      return `${p.color} ${start.toFixed(1)}deg ${end.toFixed(1)}deg`;
    })
    .join(', ');

  const donut = $('#fleetDonut');
  donut.style.background = devices.length
    ? `conic-gradient(${stops})`
    : 'var(--surface-2)';
  donut.innerHTML = `<div class="donut-hole"><strong>${devices.length}</strong><span>devices</span></div>`;

  $('#fleetDonutLegend').innerHTML = parts.map((p) => {
    const pct = devices.length ? Math.round((p.value / total) * 100) : 0;
    return `
      <li>
        <span class="dot" style="background:${p.color}"></span>
        <span class="lg-label">${p.label}</span>
        <span class="lg-value">${p.value} · ${pct}%</span>
      </li>`;
  }).join('');
}

// Per-person activity ranking for the selected year (top 8).
function renderTopUsers(yearLogs) {
  const byPerson = {};
  yearLogs.forEach((l) => {
    if (!l.person) return;
    const p = (byPerson[l.person] ||= { out: 0, in: 0 });
    p[l.action]++;
  });
  const ranked = Object.entries(byPerson)
    .map(([name, c]) => ({ name, out: c.out, in: c.in, total: c.out + c.in }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const list = $('#topUsers');
  const empty = $('#noTopUsers');
  $('#topUsersCount').textContent = ranked.length ? ranked.length : '';
  empty.hidden = ranked.length > 0;
  list.hidden = ranked.length === 0;

  const peak = Math.max(...ranked.map((r) => r.total), 1);
  list.innerHTML = ranked.map((r, i) => `
    <div class="rank-row">
      <span class="rank-num">${i + 1}</span>
      <div class="rank-body">
        <div class="rank-head">
          <span class="rank-name">${escapeHtml(r.name)}</span>
          <span class="rank-total">${r.total}</span>
        </div>
        <div class="rank-bar">
          <span class="seg-out" style="width:${((r.out / peak) * 100).toFixed(1)}%"></span>
          <span class="seg-in" style="width:${((r.in / peak) * 100).toFixed(1)}%"></span>
        </div>
      </div>
    </div>`).join('');
}


function exportReport() {
  const year = selectedReportYear();
  const months = monthlyCounts(year);
  const quarters = quarterlyCounts(months);
  if (!months.some((c) => c.out || c.in)) { toast('No activity to export.', true); return; }

  const byId = new Map(devices.map((d) => [d.id, d]));
  const yearLogs = logs
    .filter((l) => new Date(l.date).getFullYear() === year)
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const totalOut = yearLogs.filter((l) => l.action === 'out').length;
  const totalIn = yearLogs.filter((l) => l.action === 'in').length;

  const rows = [
    [`InReach activity report ${year}`],
    [],
    ['Quarter', 'Check-outs', 'Check-ins', 'Total'],
    ...quarters.map((c, i) => [QUARTER_NAMES[i].replace(' · ', ' '), c.out, c.in, c.out + c.in]),
    [],
    ['Month', 'Check-outs', 'Check-ins', 'Total'],
    ...months.map((c, m) => [MONTHS[m], c.out, c.in, c.out + c.in]),
    [],
    [`Detailed activity ${year} — ${totalOut} check-outs, ${totalIn} check-ins`],
    ['Date & time', 'Action', 'Device', 'Person', 'Subscription', 'Notes'],
    ...yearLogs.map((l) => [
      formatDateTime(l.date),
      l.action === 'in' ? 'Check-in' : 'Check-out',
      byId.get(l.deviceId)?.label || 'Unknown device',
      l.person || '',
      l.plan || '',
      l.notes || '',
    ]),
  ];

  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inreach-report-${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* Gather every figure shown in the Reports tab, for the native-text PDF export. */
function computeReportData() {
  const now = new Date();

  const total = devices.length;
  const deactivated = devices.filter((d) => d.plan === 'Deactivated').length;
  const checkedOut = devices
    .filter((d) => d.plan !== 'Deactivated' && deviceStatus(d.id).out)
    .map((d) => ({ d, st: deviceStatus(d.id) }))
    .sort((a, b) => a.d.label.localeCompare(b.d.label));
  const out = checkedOut.length;
  const available = total - out - deactivated;

  const totalByModel = {};
  const availByModel = {};
  devices.forEach((d) => {
    const model = d.model || 'Unknown';
    totalByModel[model] = (totalByModel[model] || 0) + 1;
    if (d.plan !== 'Deactivated' && !deviceStatus(d.id).out) {
      availByModel[model] = (availByModel[model] || 0) + 1;
    }
  });
  const models = Object.keys(totalByModel).sort((a, b) => a.localeCompare(b));

  const year = selectedReportYear();
  const months = monthlyCounts(year);
  const quarters = quarterlyCounts(months);
  const totalOut = months.reduce((s, c) => s + c.out, 0);
  const totalIn = months.reduce((s, c) => s + c.in, 0);
  const totalActivity = totalOut + totalIn;
  const yearLogs = logs.filter((l) => new Date(l.date).getFullYear() === year);
  const people = new Set(yearLogs.map((l) => l.person).filter(Boolean)).size;
  const busiestIdx = months.reduce(
    (best, c, i, arr) => (c.out + c.in > arr[best].out + arr[best].in ? i : best), 0);
  const busiest = totalActivity ? MONTHS[busiestIdx] : '—';
  const activeMonths = months.filter((c) => c.out + c.in > 0).length;
  const avgPerMonth = activeMonths ? Math.round(totalActivity / activeMonths) : 0;

  const byPerson = {};
  yearLogs.forEach((l) => {
    if (!l.person) return;
    const p = (byPerson[l.person] ||= { out: 0, in: 0 });
    p[l.action]++;
  });
  const topUsers = Object.entries(byPerson)
    .map(([name, c]) => ({ name, out: c.out, in: c.in, total: c.out + c.in }))
    .sort((a, b) => b.total - a.total);

  const licences = licenceStats(year);

  const devById = new Map(devices.map((d) => [d.id, d]));
  const activityLog = yearLogs
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((l) => ({
      date: l.date,
      action: l.action,
      device: devById.get(l.deviceId)?.label || 'Unknown device',
      person: l.person || '',
      notes: l.notes || '',
    }));

  return {
    now, total, deactivated, checkedOut, out, available,
    totalByModel, availByModel, models, year, months, quarters,
    totalOut, totalIn, totalActivity, people, busiest, avgPerMonth, topUsers, licences, activityLog,
  };
}

/* Lazy-load jsPDF + autoTable from CDN once, so we can build a real, text-based
   PDF file in the browser (selectable text, vector charts — not a screenshot). */
let pdfLibPromise;
function ensurePdfLibs() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve();
  if (pdfLibPromise) return pdfLibPromise;
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
  pdfLibPromise = load('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    .then(() => load('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
    .catch((err) => { pdfLibPromise = null; throw err; });
  return pdfLibPromise;
}

// PDF theme palette (mirrors the app's Japandi colours).
const PDF_COLORS = {
  ink: [56, 51, 44],
  inkSoft: [109, 103, 92],
  muted: [122, 115, 101],
  line: [216, 210, 199],
  sage: [127, 139, 111],
  clay: [185, 134, 106],
  headFill: [241, 236, 226],
  rowAlt: [249, 246, 240],
};

// Draw a donut chart from segments; renders the total in the hole.
function pdfDonut(doc, cx, cy, radius, segments, centerCount) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) {
    doc.setFillColor(...PDF_COLORS.headFill);
    doc.circle(cx, cy, radius, 'F');
  } else {
    let angle = -90;
    segments.forEach((seg) => {
      if (seg.value <= 0) return;
      const sweep = (seg.value / total) * 360;
      const steps = Math.max(1, Math.ceil(sweep / 2));
      const step = sweep / steps;
      doc.setFillColor(seg.color[0], seg.color[1], seg.color[2]);
      for (let i = 0; i < steps; i++) {
        const a1 = ((angle + i * step) * Math.PI) / 180;
        const a2 = ((angle + (i + 1) * step) * Math.PI) / 180;
        doc.triangle(
          cx, cy,
          cx + radius * Math.cos(a1), cy + radius * Math.sin(a1),
          cx + radius * Math.cos(a2), cy + radius * Math.sin(a2),
          'F');
      }
      angle += sweep;
    });
  }
  doc.setFillColor(255, 255, 255);
  doc.circle(cx, cy, radius * 0.58, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...PDF_COLORS.ink);
  doc.text(String(centerCount), cx, cy + 2, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...PDF_COLORS.muted);
  doc.text('DEVICES', cx, cy + 14, { align: 'center' });
}

// Draw a grouped monthly bar chart (check-outs vs check-ins).
function pdfBars(doc, x, y, w, h, months) {
  const { clay, sage, muted } = PDF_COLORS;
  const peak = Math.max(...months.map((c) => Math.max(c.out, c.in)), 1);
  const groupW = w / 12;
  const barW = Math.min(11, groupW * 0.34);
  months.forEach((c, m) => {
    const gx = x + m * groupW + groupW / 2;
    const outH = (c.out / peak) * h;
    const inH = (c.in / peak) * h;
    doc.setFillColor(...clay);
    doc.rect(gx - barW - 1, y + h - outH, barW, outH, 'F');
    doc.setFillColor(...sage);
    doc.rect(gx + 1, y + h - inH, barW, inH, 'F');
    doc.setFontSize(7); doc.setTextColor(...muted);
    doc.text(MONTHS[m].slice(0, 1), gx, y + h + 11, { align: 'center' });
  });
}

async function downloadReportPdf() {
  toast('Building PDF…');
  try {
    await ensurePdfLibs();
  } catch {
    toast('Could not load the PDF library (check your connection).', true);
    return;
  }

  try {
    const r = computeReportData();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const C = PDF_COLORS;

    const now = r.now;
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getDate())}${pad(now.getMonth() + 1)}${String(now.getFullYear()).slice(-2)}`;

    const M = 40;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const contentW = pageW - M * 2;
    let y = 0;

    const ensureSpace = (need) => {
      if (y + need > pageH - M) { doc.addPage(); y = M; }
    };

    const heading = (text, forceNewPage = false) => {
      if (forceNewPage) { doc.addPage(); y = M; }
      ensureSpace(46);
      y += 6;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...C.ink);
      doc.text(text, M, y);
      y += 8;
      doc.setDrawColor(...C.line); doc.setLineWidth(0.8);
      doc.line(M, y, pageW - M, y);
      y += 18;
    };

    const summaryCards = (items) => {
      const gap = 10;
      const cardW = (contentW - gap * (items.length - 1)) / items.length;
      const cardH = 52;
      ensureSpace(cardH + 8);
      items.forEach((it, i) => {
        const x = M + i * (cardW + gap);
        doc.setDrawColor(...C.line); doc.setLineWidth(0.8);
        doc.roundedRect(x, y, cardW, cardH, 6, 6, 'S');

        let vs = 17;
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.ink); doc.setFontSize(vs);
        const val = String(it.value);
        while (doc.getTextWidth(val) > cardW - 20 && vs > 9) { vs -= 1; doc.setFontSize(vs); }
        doc.text(val, x + 12, y + 26);

        let ls = 7.5;
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted); doc.setFontSize(ls);
        const lbl = String(it.label).toUpperCase();
        while (doc.getTextWidth(lbl) > cardW - 18 && ls > 5) { ls -= 0.5; doc.setFontSize(ls); }
        doc.text(lbl, x + 12, y + 42);
      });
      y += cardH + 20;
    };

    const baseTableStyle = {
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: C.ink, lineColor: C.line, lineWidth: 0.5 },
      headStyles: { fillColor: C.headFill, textColor: C.muted, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.rowAlt },
    };

    const table = (head, body, opts = {}) => {
      doc.autoTable({ startY: y, head: [head], body, margin: { left: M, right: M }, theme: 'grid', ...baseTableStyle, ...opts });
      y = doc.lastAutoTable.finalY + 22;
    };

    /* ---- Title ---- */
    y = 54;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(...C.ink);
    doc.text('InReach Check-In — Report', M, y);
    y += 18;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...C.muted);
    doc.text(`Generated ${formatDateTime(now.toISOString())}  ·  Activity year ${r.year}`, M, y);
    y += 22;

    /* ---- Fleet status ---- */
    heading('Fleet status');
    summaryCards([
      { label: 'Devices', value: r.total },
      { label: 'Available', value: r.available },
      { label: 'Checked out', value: r.out },
      { label: 'Deactivated', value: r.deactivated },
    ]);

    /* ---- Fleet snapshot (donut + legend) ---- */
    heading('Fleet snapshot');
    ensureSpace(150);
    {
      const parts = [
        { label: 'Available', value: r.available, color: C.sage },
        { label: 'Checked out', value: r.out, color: C.clay },
        { label: 'Deactivated', value: r.deactivated, color: C.muted },
      ];
      pdfDonut(doc, M + 62, y + 60, 52, parts, r.total);
      let ly = y + 26;
      const lx = M + 150;
      doc.setFontSize(10);
      parts.forEach((p) => {
        doc.setFillColor(...p.color);
        doc.rect(lx, ly - 8, 10, 10, 'F');
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.inkSoft);
        doc.text(p.label, lx + 16, ly);
        const pct = r.total ? Math.round((p.value / r.total) * 100) : 0;
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.ink);
        doc.text(`${p.value}  ·  ${pct}%`, pageW - M, ly, { align: 'right' });
        ly += 24;
      });
      y += 150;
    }

    /* ---- Devices by model ---- */
    heading('Devices by model');
    table(
      ['Model', 'Available', 'Total'],
      r.models.map((m) => [m, String(r.availByModel[m] || 0), String(r.totalByModel[m])]),
      { columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } } });

    /* ---- Currently checked out ---- */
    heading('Currently checked out');
    table(
      ['Device', 'Person', 'Since'],
      r.checkedOut.length
        ? r.checkedOut.map(({ d, st }) => [d.label, st.person, formatDateTime(st.since)])
        : [[{ content: 'Nothing is checked out.', colSpan: 3, styles: { halign: 'center', textColor: C.muted, fontStyle: 'italic' } }]]);

    /* ---- Most active users ---- */
    heading('Most active users');
    if (r.topUsers.length) {
      table(
        ['#', 'User', 'Check-outs', 'Check-ins', 'Total'],
        r.topUsers.slice(0, 15).map((u, i) => [String(i + 1), u.name, String(u.out), String(u.in), String(u.total)]),
        { columnStyles: { 0: { cellWidth: 26, halign: 'center' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' } } });
    } else {
      ensureSpace(30);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...C.muted);
      doc.text('No user activity this year.', M, y + 2);
      y += 26;
    }

    /* ---- Subscription licences ---- */
    heading('Subscription licences');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...C.inkSoft);
    doc.text(
      `${r.licences.activeCount} active licence${r.licences.activeCount === 1 ? '' : 's'} currently assigned (Enabled/Basic, Advanced, Premier).`,
      M, y);
    y += 16;
    table(
      ['Licence / plan', 'Status', 'Assigned', `Used ${r.year}`, 'Used all-time'],
      PLANS.map((p) => [
        p,
        licenceStatusLabel(p),
        String(r.licences.current[p] || 0),
        String(r.licences.usedYear[p] || 0),
        String(r.licences.usedAll[p] || 0),
      ]),
      { columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' } } });

    /* ---- Activity summary ---- */
    heading(`Activity ${r.year}`, true);
    summaryCards([
      { label: 'Check-outs', value: r.totalOut },
      { label: 'Check-ins', value: r.totalIn },
      { label: 'Total activity', value: r.totalActivity },
      { label: 'People', value: r.people },
      { label: 'Busiest month', value: r.busiest },
      { label: 'Avg / month', value: r.avgPerMonth },
    ]);

    /* ---- Monthly activity chart ---- */
    heading('Monthly activity');
    ensureSpace(160);
    {
      const chartH = 120;
      const chartX = M;
      const chartY = y;
      doc.setDrawColor(...C.line); doc.setLineWidth(0.8);
      doc.line(chartX, chartY + chartH, chartX + contentW, chartY + chartH);
      pdfBars(doc, chartX, chartY, contentW, chartH, r.months);
      y = chartY + chartH + 20;
      doc.setFillColor(...C.clay); doc.rect(chartX, y - 8, 10, 10, 'F');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...C.inkSoft);
      doc.text('Check-outs', chartX + 15, y);
      const w1 = doc.getTextWidth('Check-outs');
      doc.setFillColor(...C.sage); doc.rect(chartX + 15 + w1 + 18, y - 8, 10, 10, 'F');
      doc.text('Check-ins', chartX + 15 + w1 + 18 + 15, y);
      y += 24;
    }

    /* ---- Quarter + month tables side by side ---- */
    heading('Activity by period');
    {
      const half = (contentW - 20) / 2;
      const startY = y;
      doc.autoTable({
        startY,
        head: [['Quarter', 'Out', 'In', 'Total']],
        body: r.quarters.map((c, i) => [QUARTER_NAMES[i].replace(' · ', ' '), String(c.out), String(c.in), String(c.out + c.in)]),
        margin: { left: M }, tableWidth: half, theme: 'grid', ...baseTableStyle,
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', fontStyle: 'bold' } },
      });
      const leftFinal = doc.lastAutoTable.finalY;
      doc.autoTable({
        startY,
        head: [['Month', 'Out', 'In', 'Total']],
        body: r.months.map((c, m) => [MONTHS[m], String(c.out), String(c.in), String(c.out + c.in)]),
        margin: { left: M + half + 20 }, tableWidth: half, theme: 'grid', ...baseTableStyle,
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', fontStyle: 'bold' } },
      });
      y = Math.max(leftFinal, doc.lastAutoTable.finalY) + 22;
    }

    /* ---- Activity log (every check-out and check-in) ---- */
    heading('Activity log', true);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...C.inkSoft);
    doc.text(`${r.totalOut} check-outs and ${r.totalIn} check-ins recorded in ${r.year} (newest first).`, M, y);
    y += 16;
    if (r.activityLog.length) {
      table(
        ['Date & time', 'Action', 'Device', 'Person', 'Notes'],
        r.activityLog.map((l) => [
          formatDateTime(l.date),
          l.action === 'in' ? 'Check-in' : 'Check-out',
          l.device,
          l.person,
          l.notes,
        ]),
        {
          columnStyles: { 0: { cellWidth: 108 }, 1: { cellWidth: 62, halign: 'center', fontStyle: 'bold' } },
          // Tint the Action cell: orange for check-out, pastel green for check-in.
          didParseCell: (data) => {
            if (data.section !== 'body' || data.column.index !== 1) return;
            const isIn = data.cell.raw === 'Check-in';
            data.cell.styles.fillColor = isIn ? [207, 233, 189] : [251, 220, 192];
            data.cell.styles.textColor = isIn ? [74, 125, 51] : [194, 94, 18];
          },
        });
    } else {
      ensureSpace(30);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...C.muted);
      doc.text('No activity recorded this year.', M, y + 2);
      y += 26;
    }

    /* ---- Page footers ---- */
    const pages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted);
      doc.text(`InReach Check-In · Page ${p} of ${pages}`, pageW - M, pageH - 18, { align: 'right' });
    }

    doc.save(`InReachCI-Report-${stamp}.pdf`);
    toast('Report downloaded.');
  } catch {
    toast('Could not generate the PDF.', true);
  }
}

$('#reportYear').addEventListener('change', renderReports);
$('#reportExportBtn').addEventListener('click', exportReport);
$('#reportPdfBtn').addEventListener('click', downloadReportPdf);

/* ---------- Stats ---------- */
function renderStats() {
  const total = devices.length;
  const deactivated = devices.filter((d) => d.plan === 'Deactivated').length;
  const out = devices.filter((d) => d.plan !== 'Deactivated' && deviceStatus(d.id).out).length;
  const available = total - out - deactivated;
  const people = knownPeople().length;

  const cards = [
    { label: 'Devices', value: total, cls: 'accent' },
    { label: 'Available', value: available, cls: 'in' },
    { label: 'Checked out', value: out, cls: 'out' },
    { label: 'People', value: people, cls: 'plain' },
  ];

  $('#stats').innerHTML = cards.map((c) => `
    <div class="stat ${c.cls}">
      <span class="stat-value">${c.value}</span>
      <span class="stat-label">${c.label}</span>
    </div>`).join('');

  const availByModel = devices
    .filter((d) => d.plan !== 'Deactivated' && !deviceStatus(d.id).out)
    .reduce((acc, d) => {
      const model = d.model || 'Unknown';
      acc[model] = (acc[model] || 0) + 1;
      return acc;
    }, {});
  const models = Object.keys(availByModel).sort((a, b) => a.localeCompare(b));
  $('#availableModels').innerHTML = models.length
    ? `<span class="mb-label">Available by model</span>` + models
        .map((m) => `<span class="model-chip"><strong>${availByModel[m]}</strong> ${escapeHtml(m)}</span>`)
        .join('')
    : `<span class="mb-label">No devices available</span>`;
}

/* ---------- Render orchestrator ---------- */
function renderAll() {
  renderStats();
  renderDeviceOptions();
  renderDevices();
  renderCheckedOut();
  renderPeopleManage();
  renderPeople();
  renderHistory();
  renderReports();
}

/* ============================================================
   Custom date & time picker (Japandi calendar)
   Writes a "YYYY-MM-DDTHH:mm" string to the hidden #logDate input.
   ============================================================ */
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const dp = { selected: new Date(), view: new Date() };

function pad2(n) { return String(n).padStart(2, '0'); }

function toHiddenValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatPickerDisplay(d) {
  const day = WEEKDAYS[(d.getDay() + 6) % 7];
  return `${day} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}  ·  ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Central setter: updates state, hidden input, and the display button.
function setPickerDate(date) {
  dp.selected = new Date(date);
  dp.view = new Date(dp.selected.getFullYear(), dp.selected.getMonth(), 1);
  $('#logDate').value = toHiddenValue(dp.selected);
  $('#logDateText').textContent = formatPickerDisplay(dp.selected);
  const t = $('#dpTime');
  if (t) t.value = `${pad2(dp.selected.getHours())}:${pad2(dp.selected.getMinutes())}`;
  if (!$('#calendarPopover').hidden) renderCalendar();
}

function renderCalendar() {
  $('#dpTitle').textContent = `${MONTHS[dp.view.getMonth()]} ${dp.view.getFullYear()}`;
  $('#dpWeekdays').innerHTML = WEEKDAYS.map((w) => `<span>${w}</span>`).join('');

  const year = dp.view.getFullYear();
  const month = dp.view.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Monday-based
  const start = new Date(year, month, 1 - startOffset);

  const today = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const classes = ['dp-day'];
    if (d.getMonth() !== month) classes.push('muted');
    if (sameDay(d, today)) classes.push('today');
    if (sameDay(d, dp.selected)) classes.push('selected');
    cells += `<button type="button" class="${classes.join(' ')}" data-day="${toHiddenValue(d).slice(0, 10)}">${d.getDate()}</button>`;
  }
  $('#dpDays').innerHTML = cells;
}

function openPicker() {
  $('#calendarPopover').hidden = false;
  $('#logDateDisplay').classList.add('open');
  $('#logDateDisplay').setAttribute('aria-expanded', 'true');
  renderCalendar();
}

function closePicker() {
  $('#calendarPopover').hidden = true;
  $('#logDateDisplay').classList.remove('open');
  $('#logDateDisplay').setAttribute('aria-expanded', 'false');
}

function initDatePicker() {
  $('#logDateDisplay').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#calendarPopover').hidden ? openPicker() : closePicker();
  });

  $('#dpPrev').addEventListener('click', () => {
    dp.view = new Date(dp.view.getFullYear(), dp.view.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#dpNext').addEventListener('click', () => {
    dp.view = new Date(dp.view.getFullYear(), dp.view.getMonth() + 1, 1);
    renderCalendar();
  });

  $('#dpDays').addEventListener('click', (e) => {
    const iso = e.target.closest('[data-day]')?.dataset.day;
    if (!iso) return;
    const [y, m, d] = iso.split('-').map(Number);
    const next = new Date(dp.selected);
    next.setFullYear(y, m - 1, d);
    setPickerDate(next);
  });

  $('#dpTime').addEventListener('change', () => {
    const [h, min] = $('#dpTime').value.split(':').map(Number);
    if (Number.isNaN(h)) return;
    const next = new Date(dp.selected);
    next.setHours(h, min || 0, 0, 0);
    setPickerDate(next);
  });

  $('#dpNow').addEventListener('click', () => setPickerDate(new Date()));
  $('#dpDone').addEventListener('click', closePicker);

  // Close when clicking outside the picker.
  document.addEventListener('click', (e) => {
    // Ignore clicks on elements detached by a re-render (e.g. a day button).
    if (!document.contains(e.target)) return;
    if (!$('#calendarPopover').hidden && !$('#datepicker').contains(e.target)) closePicker();
  });
}

/* ---------- Init ---------- */
function init() {
  initTabs();
  initDatePicker();
  setPickerDate(new Date());
  migrateLabels();
  applyImeiData();
  applyImeiDataV2();
  // First launch: pre-load the default fleet.
  if (!localStorage.getItem('inreach.seeded')) {
    localStorage.setItem('inreach.seeded', '1');
    if (!devices.length) seedMiniFleet();
  }
  // One-time: ensure the GPSMAP 66i exists for pre-existing data.
  if (!localStorage.getItem('inreach.gpsmap66i')) {
    localStorage.setItem('inreach.gpsmap66i', '1');
    if (!devices.some((d) => d.label === 'GPSMAP 66i')) {
      devices.push({ id: uid(), label: 'GPSMAP 66i', model: 'GPSMAP 66i', imei: '', plan: 'Enabled/Basic' });
      save(STORE.devices, devices);
    }
  }
  // Guarantee the complete default fleet exists, even on browsers seeded before it was finalized.
  if (!localStorage.getItem('inreach.fleet.v3')) {
    localStorage.setItem('inreach.fleet.v3', '1');
    addMissingFleet();
  }
  renderAll();
}

init();
