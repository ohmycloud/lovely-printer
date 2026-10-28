import { PrinterAudio } from './audio.js';

const $ = (selector) => document.querySelector(selector);
const input = $('#input'), printButton = $('#print'), papers = $('#papers');
const defaults = { volume: .6, muted: false, preset: 'puff', typingSound: true, kind: 'love', reducedMotion: false };
let saved = {};
try { saved = JSON.parse(localStorage.getItem('motopager-settings') || '{}'); } catch {}
const settings = { ...defaults, ...saved };
settings.volume = Number.isFinite(settings.volume) ? Math.max(0, Math.min(1, settings.volume)) : .6;
if (!['puff', 'thermal', 'custom'].includes(settings.preset)) settings.preset = 'puff';
if (!['love', 'poetry', 'lyrics'].includes(settings.kind)) settings.kind = 'love';
const audio = new PrinterAudio(settings);
const notes = new Map(), seen = new Set(), queue = [];
let active = null, submitting = false, generating = false, highestZ = 1001, toastTimer;
let ready = false, historyOffset = 0, historyLoading = false, historyGeneration = 0;
const reducedMotion = () => settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
function saveSettings() {
  try { localStorage.setItem('motopager-settings', JSON.stringify(settings)); } catch { toast('偏好暂时无法保存，当前设置仍然有效'); }
  dispatchEvent(new Event('audio-settings'));
  updateSoundUI();
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4000);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务器返回了无法识别的响应'); }
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
const patch = (id, body) => api(`/api/notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });

function updateInput() {
  $('.screen').classList.toggle('has-text', Boolean(input.value));
  printButton.disabled = !input.value.trim() || submitting || generating;
}
input.addEventListener('input', updateInput);
input.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); }
  else if (event.key === 'Enter') audio.carriage();
  else if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key.length === 1 || ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'].includes(event.key))) audio.key();
});
input.addEventListener('compositionend', () => audio.key());
// Audio is only unlocked by a genuine user gesture, never by server events.
for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, () => audio.unlock(), { capture: true });
$('#clear').addEventListener('click', () => { input.value = ''; audio.key(); updateInput(); input.focus(); });
printButton.addEventListener('click', submit);
async function submit() {
  if (printButton.disabled) return;
  const text = input.value;
  if (Array.from(text.replace(/\r\n?/g, '\n')).length > 4000) return toast('每张便签最多 4000 个字符');
  submitting = true; updateInput(); audio.carriage();
  try {
    const note = await api('/api/print', { method: 'POST', body: JSON.stringify({ text, source: 'web' }) });
    enqueue(note); // SSE may arrive first. enqueue is idempotent.
    if (input.value === text) input.value = '';
  } catch (error) { toast(`未能打印：${error.message}。文字已为你保留。`); }
  finally { submitting = false; updateInput(); input.focus(); }
}
$('#inspire').addEventListener('click', async () => {
  if (generating) return;
  generating = true; audio.key(); $('#inspire').disabled = true; $('#inspire').classList.add('loading');
  const previous = input.value; input.value = ''; input.placeholder = 'GENERATING...'; input.disabled = true; updateInput();
  try {
    const message = await api(`/api/inspire?kind=${settings.kind}`);
    input.disabled = false; input.placeholder = 'INPUT_TEXT...';
    input.value = '';
    // Feed a generated message into the amber screen one grapheme at a time.
    const characters = window.Intl?.Segmenter ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(message.text)].map(s => s.segment) : Array.from(message.text);
    if (reducedMotion()) input.value = message.text;
    else {
      input.disabled = true;
      for (let i = 0; i < characters.length; i++) {
        input.value += characters[i]; updateInput(); input.scrollTop = input.scrollHeight;
        if (i % 3 === 0) audio.key(.17);
        await new Promise(resolve => setTimeout(resolve, Math.max(5, Math.min(24, 2200 / characters.length))));
      }
    }
    audio.carriage();
  } catch (error) { input.value = previous; toast(`灵感暂时没来：${error.message}`); }
  finally {
    generating = false; input.disabled = false; input.placeholder = 'INPUT_TEXT...';
    $('#inspire').disabled = false; $('#inspire').classList.remove('loading'); updateInput(); input.focus();
  }
});

function makePaper(note) {
  const position = document.createElement('article');
  position.className = 'paper-position'; position.tabIndex = 0;
  position.setAttribute('aria-label', `便签 ${note.id.slice(0, 6)}，可拖动或使用方向键移动`);
  position.dataset.id = note.id;
  const eject = document.createElement('div'); eject.className = 'paper-eject';
  const paper = document.createElement('div'); paper.className = 'paper';
  const close = document.createElement('button'); close.className = 'paper-close'; close.textContent = '×';
  close.title = '收起到历史'; close.setAttribute('aria-label', '收起便签到历史');
  const header = document.createElement('div'); header.className = 'paper-header';
  const id = document.createElement('span'); id.textContent = `ID: ${note.id.slice(0, 6).toUpperCase()}`;
  const time = document.createElement('time');
  const date = new Date(note.created_at); time.dateTime = note.created_at;
  time.textContent = date.toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  header.append(id, time);
  const text = document.createElement('div'); text.className = 'paper-text'; text.textContent = note.text;
  const footer = document.createElement('div'); footer.className = 'paper-footer';
  const barcode = document.createElement('div'); barcode.className = 'barcode'; barcode.setAttribute('aria-hidden', 'true');
  const end = document.createElement('span'); end.textContent = 'End of Transmission';
  footer.append(barcode, end); paper.append(close, header, text, footer); eject.append(paper); position.append(eject); papers.append(position);
  const item = { note, el: position, paper, eject, height: paper.offsetHeight, scale: 1, dragging: false, printing: false, z: note.z_index > 1 ? note.z_index : Math.min(999, note.seq + 1) };
  notes.set(note.id, item); seen.add(note.id);
  close.addEventListener('pointerdown', event => event.stopPropagation());
  close.addEventListener('click', async (event) => {
    event.stopPropagation(); close.disabled = true;
    try { applyUpdate(await patch(note.id, { archived: true })); }
    catch (error) { close.disabled = false; toast(error.message); }
  });
  installDrag(item); layoutPaper(item);
  return item;
}
function layoutDevice() {
  const height = $('#canvas').clientHeight;
  const scale = Math.max(.35, Math.min(1, (innerWidth - 32) / 392, (height - 205) / 338));
  $('#printer').style.setProperty('--device-scale', scale);
  $('#printer').style.bottom = `${height < 550 ? 24 : innerWidth < 640 ? 48 : 84}px`;
}
function layoutPaper(item) {
  const { note, el, height } = item;
  const bounds = $('#printer').getBoundingClientRect();
  const angle = note.rotation * Math.PI / 180;
  const rotatedW = Math.abs(320 * Math.cos(angle)) + Math.abs(height * Math.sin(angle));
  const rotatedH = Math.abs(height * Math.cos(angle)) + Math.abs(320 * Math.sin(angle));
  const top = 58, gap = Math.max(60, bounds.top - top - 14);
  item.scale = Math.min(1, (innerWidth - 40) / rotatedW, gap / rotatedH);
  const w = 320 * item.scale, h = height * item.scale;
  const inset = 12 + Math.abs(Math.sin(angle)) * Math.max(w, h) / 2;
  let x = note.x ?? ((innerWidth - w) / 2 + ((note.seq % 3) - 1) * 12);
  let y = note.y ?? (bounds.top - h - 12);
  x = Math.max(inset, Math.min(innerWidth - w - inset, x));
  y = Math.max(top + inset / 2, Math.min($('#canvas').clientHeight - h - inset, y));
  Object.assign(item, { x, y });
  el.style.width = '320px'; el.style.height = `${height}px`;
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  el.style.transform = `scale(${item.scale})`;
  el.style.zIndex = item.z;
  item.paper.style.transform = `rotate(${note.rotation}deg)`;
}
function enqueue(note) {
  if (seen.has(note.id) || note.archived) return;
  seen.add(note.id); removeWelcome(); queue.push(note); processQueue();
}
async function processQueue() {
  if (active || !queue.length) return;
  const note = queue.shift();
  const item = makePaper(note); active = item; item.printing = true;
  // Position from the actual measured slot rather than a guessed device height.
  item.note.x = null; item.note.y = null; item.z = Math.min(999, note.seq + 1); layoutPaper(item);
  item.el.classList.add('printing'); item.el.setAttribute('aria-busy', 'true');
  item.el.style.clipPath = 'inset(-12px -24px 0 -24px)';
  $('#screen-led').classList.add('busy'); printButton.classList.add('printing');
  $('#hint').textContent = queue.length ? `PRINTING · ${queue.length} IN QUEUE` : 'PRINTING A LITTLE MOMENT...';
  const duration = reducedMotion() ? 0 : Math.max(1500, Array.from(note.text).length * 20);
  const stopAudio = audio.print(duration || 300); item.stopAudio = stopAudio;
  if (duration) {
    const animation = item.eject.animate([
      { transform: `translateY(${item.height + 12}px)` },
      { transform: 'translateY(0)' }
    ], { duration, easing: 'linear', fill: 'forwards' });
    item.animation = animation;
    try { await animation.finished; } catch { /* Archived or resynced during printing. */ }
    animation.cancel();
  }
  // Let the short cutter sound finish, then release references to completed audio nodes.
  setTimeout(() => { stopAudio(); item.stopAudio = null; }, 180);
  item.printing = false; item.el.classList.remove('printing'); item.el.removeAttribute('aria-busy'); item.el.style.clipPath = '';
  $('#screen-led').classList.remove('busy'); printButton.classList.remove('printing');
  $('#hint').textContent = 'DRAG YOUR NOTE. KEEP THE FEELING.';
  active = null; processQueue();
}
function removeItem(id) {
  const item = notes.get(id);
  if (item) { item.animation?.cancel(); item.stopAudio?.(); item.el.remove(); notes.delete(id); }
  const index = queue.findIndex(note => note.id === id);
  if (index >= 0) queue.splice(index, 1);
}
function applyUpdate(note) {
  if (note.archived) { seen.add(note.id); removeItem(note.id); return; }
  const queued = queue.findIndex(entry => entry.id === note.id);
  if (queued >= 0) { queue[queued] = note; return; }
  const item = notes.get(note.id);
  if (!item) { removeWelcome(); makePaper(note); return; }
  item.note = note;
  if (!item.dragging && !item.printing) { item.z = note.z_index > 1 ? note.z_index : Math.min(999, note.seq + 1); highestZ = Math.max(highestZ, item.z); layoutPaper(item); }
}
function sync(snapshot) {
  const ids = new Set(snapshot.map(note => note.id));
  for (const [id] of notes) if (id !== 'welcome' && !ids.has(id)) removeItem(id);
  for (let i = queue.length - 1; i >= 0; i--) if (!ids.has(queue[i].id)) queue.splice(i, 1);
  for (const note of snapshot) {
    if (notes.has(note.id)) applyUpdate(note);
    else if (!queue.some(n => n.id === note.id)) { makePaper(note); highestZ = Math.max(highestZ, note.z_index); }
    seen.add(note.id);
  }
  if (snapshot.length) removeWelcome();
  else if (!ready && !queue.length && !notes.size) makeWelcome();
  ready = true;
}
function makeWelcome() {
  const note = { id: 'welcome', seq: 0, created_at: new Date().toISOString(), text: 'Welcome to the MotoPager.\n\n写下一句话，或按下红心，\n让灵感为你停留。\n\nHit PRINT to keep a moment.', x: null, y: null, rotation: -2, z_index: 1 };
  const item = makePaper(note); item.el.querySelector('.paper-header span').textContent = 'HELLO, YOU';
  const close = item.el.querySelector('.paper-close');
  close.replaceWith(close.cloneNode(true)); item.el.querySelector('.paper-close').onclick = removeWelcome;
}
function removeWelcome() { removeItem('welcome'); }
function installDrag(item) {
  let drag = null;
  item.el.addEventListener('pointerdown', event => {
    if (event.button !== 0 || item.printing || event.target.closest('button')) return;
    item.dragging = true; item.z = ++highestZ; item.el.style.zIndex = item.z;
    item.el.classList.add('dragging'); item.el.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, left: item.x, top: item.y };
    event.preventDefault(); item.el.focus({ preventScroll: true });
  });
  item.el.addEventListener('pointermove', event => {
    if (!drag) return;
    const margin = 16;
    item.x = Math.max(margin, Math.min(innerWidth - 320 * item.scale - margin, drag.left + event.clientX - drag.x));
    item.y = Math.max(58, Math.min($('#canvas').clientHeight - item.height * item.scale - margin, drag.top + event.clientY - drag.y));
    item.el.style.left = `${item.x}px`; item.el.style.top = `${item.y}px`;
  });
  const end = () => {
    if (!drag) return;
    drag = null; item.dragging = false; item.el.classList.remove('dragging'); persistPosition(item);
  };
  item.el.addEventListener('pointerup', end); item.el.addEventListener('pointercancel', end); item.el.addEventListener('lostpointercapture', end);
  item.el.addEventListener('keydown', event => {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!moves[event.key] || item.printing || event.target.closest('button')) return;
    event.preventDefault(); const [dx, dy] = moves[event.key]; const step = event.shiftKey ? 20 : 5;
    item.note.x = item.x + dx * step; item.note.y = item.y + dy * step; item.z = ++highestZ;
    layoutPaper(item); clearTimeout(item.keySave); item.keySave = setTimeout(() => persistPosition(item), 200);
  });
}
async function persistPosition(item) {
  item.note.x = item.x; item.note.y = item.y; item.note.z_index = item.z;
  if (item.note.id === 'welcome') return;
  try { await patch(item.note.id, { x: item.x, y: item.y, z_index: item.z }); }
  catch (error) { toast(`位置尚未保存：${error.message}`); }
}
layoutDevice();
let resizeFrame;
addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { layoutDevice(); for (const item of notes.values()) layoutPaper(item); });
});
document.fonts.ready.then(() => {
  for (const item of notes.values()) { item.height = item.paper.offsetHeight; layoutPaper(item); }
});

let events;
function connectEvents() {
events?.close();
events = new EventSource('/api/events');
events.onopen = () => { $('#connection').className = 'connection online'; $('#connection').title = '打印机已连接'; $('#connection').setAttribute('aria-label', '打印机已连接'); $('#screen-led').classList.remove('offline'); };
events.onerror = () => { $('#connection').className = 'connection offline'; $('#connection').title = '连接中断，正在自动重连'; $('#connection').setAttribute('aria-label', '连接中断，正在自动重连'); $('#screen-led').classList.add('offline'); };
events.addEventListener('sync', event => sync(JSON.parse(event.data)));
events.addEventListener('printed', event => enqueue(JSON.parse(event.data)));
events.addEventListener('updated', event => applyUpdate(JSON.parse(event.data)));
events.addEventListener('retry-sync', () => {
  // A lagged receiver with a failed snapshot must reconnect, not silently lose commands.
  events.close();
  setTimeout(connectEvents, 2000);
});
}
connectEvents();

// Settings stay out of the printer's original face, in a quiet utility panel.
function updateSoundUI() {
  $('#volume').value = settings.volume * 100; $('#volume-value').value = `${Math.round(settings.volume * 100)}%`;
  $('#sound-preset').value = settings.preset; $('#typing-sound').checked = settings.typingSound;
  $('#reduced-motion').checked = settings.reducedMotion; $('#inspiration-kind').value = settings.kind;
  $('#sound-toggle').textContent = settings.muted ? '♪̸' : '♫';
  $('#sound-toggle').setAttribute('aria-label', settings.muted ? '开启声音' : '静音');
  $('#sound-toggle').title = settings.muted ? '开启声音' : '静音';
  $('#custom-name').textContent = audio.customName ? `已保存：${audio.customName}（仅此浏览器）` : '自定义音频只保存在此浏览器，不上传到服务器。';
  $('#remove-sound').disabled = !audio.customBuffer;
}
$('#sound-toggle').onclick = () => { settings.muted = !settings.muted; saveSettings(); };
$('#settings-open').onclick = () => $('#settings-dialog').showModal();
$('#volume').oninput = event => { settings.volume = Number(event.target.value) / 100; saveSettings(); };
$('#sound-preset').onchange = event => {
  if (event.target.value === 'custom' && !audio.customBuffer) { toast('请先上传一段音频'); updateSoundUI(); return; }
  settings.preset = event.target.value; saveSettings();
};
$('#typing-sound').onchange = event => { settings.typingSound = event.target.checked; saveSettings(); };
$('#reduced-motion').onchange = event => { settings.reducedMotion = event.target.checked; saveSettings(); if (settings.reducedMotion) active?.animation?.finish(); };
$('#inspiration-kind').onchange = event => { settings.kind = event.target.value; saveSettings(); };
$('#sound-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try { await audio.setCustom(file); settings.preset = 'custom'; saveSettings(); toast('你的声音已保存'); }
  catch (error) { toast(error.message); }
  finally { event.target.value = ''; }
};
let stopPreview = () => {};
$('#preview-sound').onclick = async () => { await audio.unlock(); stopPreview(); if (settings.muted || !settings.volume) toast('当前已静音，请先开启声音或调高音量'); else stopPreview = audio.print(1800); };
$('#settings-dialog').addEventListener('close', () => stopPreview());
$('#remove-sound').onclick = async () => { try { await audio.removeCustom(); settings.preset = 'puff'; saveSettings(); } catch (error) { toast(error.message); } };
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  const r = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
});
updateSoundUI();
audio.loadCustom().then(() => { if (settings.preset === 'custom' && !audio.customBuffer) { settings.preset = 'puff'; saveSettings(); } updateSoundUI(); }).catch(() => { if (settings.preset === 'custom') { settings.preset = 'puff'; saveSettings(); } });

$('#history-open').onclick = () => {
  $('#history-dialog').showModal(); historyOffset = 0; historyGeneration++; historyLoading = false;
  $('#history-list').replaceChildren(); loadHistory();
};
$('#history-more').onclick = loadHistory;
async function loadHistory() {
  if (historyLoading) return;
  historyLoading = true; const generation = historyGeneration;
  $('#history-more').disabled = true; $('#history-more').hidden = false; $('#history-more').textContent = '加载中…';
  try {
    const batch = await api(`/api/notes?limit=20&offset=${historyOffset}`);
    if (generation !== historyGeneration) return;
    if (!batch.length && historyOffset === 0) {
      const empty = document.createElement('p'); empty.className = 'empty-history'; empty.textContent = '还没有打印记录。让第一句话留在纸上吧。'; $('#history-list').append(empty);
    }
    for (const note of batch) {
      const row = document.createElement('article'); row.className = 'history-item';
      const time = document.createElement('time'); time.textContent = new Date(note.created_at).toLocaleString('zh-CN');
      const text = document.createElement('p'); text.textContent = note.text;
      const actions = document.createElement('div'); actions.className = 'history-actions';
      const label = document.createElement('span'); label.textContent = `${note.source} · ${note.archived ? '已收起' : '在桌面'}`;
      const restore = document.createElement('button'); restore.className = 'text-button'; restore.textContent = '放回桌面';
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          const item = await patch(note.id, { archived: false, z_index: ++highestZ }); applyUpdate(item);
          const paper = notes.get(note.id); if (paper) { paper.note.x = null; paper.note.y = null; layoutPaper(paper); await persistPosition(paper); }
          $('#history-dialog').close();
        } catch (error) { toast(error.message); } finally { restore.disabled = false; }
      };
      const reprint = document.createElement('button'); reprint.className = 'text-button'; reprint.textContent = '再打印';
      reprint.onclick = async () => {
        reprint.disabled = true;
        try { enqueue(await api('/api/print', { method: 'POST', body: JSON.stringify({ text: note.text, source: 'reprint' }) })); $('#history-dialog').close(); }
        catch (error) { toast(error.message); } finally { reprint.disabled = false; }
      };
      actions.append(label, restore, reprint); row.append(time, text, actions); $('#history-list').append(row);
    }
    historyOffset += batch.length; $('#history-more').hidden = batch.length < 20;
  } catch (error) { toast(error.message); $('#history-more').textContent = '重试'; }
  finally { if (generation === historyGeneration) { historyLoading = false; $('#history-more').disabled = false; if ($('#history-more').textContent !== '重试') $('#history-more').textContent = '加载更多'; } }
}
updateInput();
