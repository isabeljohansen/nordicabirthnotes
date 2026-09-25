import { db, auth, uid } from './db.js';
import { CARD_TYPES, revokeBlobUrl, primeBlobUrl, parseVideoUrl } from './cardTypes.js';

const LAST_BOARD_KEY = 'midwife-board:lastBoardId';

const els = {
  boardList: document.getElementById('board-list'),
  newBoardBtn: document.getElementById('new-board-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  boardName: document.getElementById('board-name'),
  toolbar: document.getElementById('toolbar'),
  viewport: document.getElementById('canvas-viewport'),
  world: document.getElementById('world'),
  zoomLevel: document.getElementById('zoom-level'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomReset: document.getElementById('zoom-reset'),
  loginScreen: document.getElementById('login-screen'),
  loginForm: document.getElementById('login-form'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  loginError: document.getElementById('login-error'),
  appRoot: document.getElementById('app'),
};

let boards = [];
let currentBoard = null;
let cards = new Map(); // id -> card object
let cardEls = new Map(); // id -> DOM element
let maxZ = 1;
let view = { x: 0, y: 0, scale: 1 };

const WORLD_SIZE = 6000;
const WORLD_CENTER = WORLD_SIZE / 2;

function defaultView() {
  const rect = els.viewport.getBoundingClientRect();
  return {
    x: rect.width / 2 - WORLD_CENTER,
    y: rect.height / 2 - WORLD_CENTER,
    scale: 1,
  };
}

function applyView() {
  els.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  els.zoomLevel.textContent = Math.round(view.scale * 100) + '%';
}

function screenToWorld(sx, sy) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

// ---------- Init ----------

async function init() {
  boards = await db.getAllBoards();
  if (boards.length === 0) {
    const board = { id: uid(), name: 'My First Board', createdAt: Date.now(), view: null };
    await db.putBoard(board);
    boards.push(board);
  }
  boards.sort((a, b) => a.createdAt - b.createdAt);

  const lastId = localStorage.getItem(LAST_BOARD_KEY);
  const initial = boards.find((b) => b.id === lastId) || boards[0];

  renderSidebar();
  buildToolbar();
  wireGlobalEvents();
  await loadBoard(initial.id);
}

// ---------- Confirm-click helper (replaces window.confirm, which browser
// automation/some environments silently auto-dismiss, and which blocks the UI) ----------

function confirmClick(button, label, onConfirm) {
  let confirming = false;
  let revertTimer = null;
  const originalText = button.textContent;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirming) {
      confirming = true;
      button.textContent = label;
      button.classList.add('confirming');
      revertTimer = setTimeout(() => {
        confirming = false;
        button.textContent = originalText;
        button.classList.remove('confirming');
      }, 2500);
      return;
    }
    clearTimeout(revertTimer);
    confirming = false;
    button.textContent = originalText;
    button.classList.remove('confirming');
    onConfirm();
  });
}

// ---------- Sidebar ----------

function renderSidebar() {
  els.boardList.innerHTML = '';
  for (const board of boards) {
    const item = document.createElement('div');
    item.className = 'board-item' + (currentBoard && board.id === currentBoard.id ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'board-item-name';
    name.textContent = board.name;
    name.addEventListener('click', () => loadBoard(board.id));
    const del = document.createElement('button');
    del.className = 'board-item-del';
    del.textContent = '×';
    del.title = 'Delete board';
    confirmClick(del, 'Sure?', () => deleteBoard(board));
    item.append(name, del);
    els.boardList.appendChild(item);
  }
}

els.newBoardBtn.addEventListener('click', () => {
  const form = document.createElement('div');
  form.className = 'new-board-form';
  const input = document.createElement('input');
  input.className = 'new-board-input';
  input.placeholder = 'Board name…';
  form.appendChild(input);
  els.newBoardBtn.replaceWith(form);
  input.focus();

  let done = false;
  async function commit() {
    if (done) return;
    done = true;
    const name = input.value.trim();
    form.replaceWith(els.newBoardBtn);
    if (!name) return;
    const board = { id: uid(), name, createdAt: Date.now(), view: null };
    await db.putBoard(board);
    boards.push(board);
    renderSidebar();
    await loadBoard(board.id);
  }
  function cancel() {
    if (done) return;
    done = true;
    form.replaceWith(els.newBoardBtn);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
});

async function deleteBoard(board) {
  const boardCards = await db.getCardsByBoard(board.id);
  for (const card of boardCards) {
    await cleanupCardBlobs(card);
    await db.deleteCard(card.id);
  }
  await db.deleteBoard(board.id);
  boards = boards.filter((b) => b.id !== board.id);
  if (currentBoard && currentBoard.id === board.id) {
    if (boards.length > 0) {
      await loadBoard(boards[0].id);
    } else {
      const fresh = { id: uid(), name: 'My First Board', createdAt: Date.now(), view: null };
      await db.putBoard(fresh);
      boards.push(fresh);
      await loadBoard(fresh.id);
    }
  }
  renderSidebar();
}

els.boardName.addEventListener('blur', async () => {
  if (!currentBoard) return;
  const name = els.boardName.textContent.trim() || 'Untitled board';
  currentBoard.name = name;
  els.boardName.textContent = name;
  await db.putBoard(currentBoard);
  renderSidebar();
});
els.boardName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    els.boardName.blur();
  }
});

// ---------- Board loading ----------

async function loadBoard(boardId) {
  currentBoard = boards.find((b) => b.id === boardId);
  if (!currentBoard) return;
  localStorage.setItem(LAST_BOARD_KEY, boardId);

  els.boardName.textContent = currentBoard.name;
  els.world.innerHTML = '';
  cards.clear();
  cardEls.clear();
  maxZ = 1;

  const boardCards = await db.getCardsByBoard(boardId);
  for (const card of boardCards) {
    cards.set(card.id, card);
    maxZ = Math.max(maxZ, card.zIndex || 1);
  }

  view = currentBoard.view || defaultView();
  applyView();

  for (const card of cards.values()) {
    renderCard(card);
  }

  renderSidebar();
}

// ---------- Toolbar ----------

// Thin dividers after these types group the icons: text/notes | data/media | rich media.
const TOOLBAR_DIVIDE_AFTER = new Set(['link', 'document']);

function buildToolbar() {
  els.toolbar.innerHTML = '';
  for (const [type, def] of Object.entries(CARD_TYPES)) {
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.innerHTML = def.icon;
    btn.title = def.label;
    btn.setAttribute('aria-label', 'Add ' + def.label.toLowerCase());
    btn.addEventListener('click', () => addCard(type));
    els.toolbar.appendChild(btn);
    if (TOOLBAR_DIVIDE_AFTER.has(type)) {
      const divider = document.createElement('span');
      divider.className = 'tool-divider';
      els.toolbar.appendChild(divider);
    }
  }
}

// opts.center (world coords) places the card exactly there (used for file drops);
// omitted, it centers on the current viewport with a small random jitter so
// repeated toolbar clicks don't stack perfectly on top of each other.
// opts.data merges over the type's default data (used to pre-fill a dropped file).
// opts.size overrides the type's default {w, h} (used to fit pasted text).
async function addCard(type, opts = {}) {
  if (!currentBoard) return;
  const def = CARD_TYPES[type];
  const size = opts.size || def.defaultSize;
  let center = opts.center;
  let jitter = 0;
  if (!center) {
    const rect = els.viewport.getBoundingClientRect();
    center = screenToWorld(rect.width / 2, rect.height / 2);
    jitter = 40;
  }
  const card = {
    id: uid(),
    boardId: currentBoard.id,
    type,
    x: center.x - size.w / 2 + (Math.random() * jitter - jitter / 2),
    y: center.y - size.h / 2 + (Math.random() * jitter - jitter / 2),
    w: size.w,
    h: size.h,
    zIndex: ++maxZ,
    data: { ...def.createData(), ...(opts.data || {}) },
    createdAt: Date.now(),
  };
  cards.set(card.id, card);
  await db.putCard(card);
  renderCard(card);
  return card;
}

// Any file becomes the matching card: images -> image, audio -> audio player,
// everything else (PDFs, docs, ...) -> document.
async function addFileCard(file, point) {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'document';
  const filename = file.name || (kind === 'image' ? 'pasted-image.png' : 'pasted-file');
  const blobId = uid();
  await db.putBlob(blobId, file, { filename, mimeType: file.type });
  primeBlobUrl(blobId, file);
  const data = kind === 'document' ? { blobId, filename, mimeType: file.type } : { blobId, filename };
  await addCard(kind, { center: point, data });
}

// ---------- Paste ----------

const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 4500);
}

// Pasted text becomes a video card (YouTube/Vimeo link), a link card (any other
// URL), or a notepad. It's always escaped, never inserted as HTML, so pasting
// from a web page can't inject markup into a note.
function cardForText(text) {
  const t = text.trim();
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) {
    const url = /^https?:/i.test(t) ? t : 'https://' + t;
    const embedUrl = parseVideoUrl(url);
    if (embedUrl) return { type: 'video', data: { url, embedUrl } };
    return { type: 'link', data: { url, title: '' } };
  }
  const lines = t.split(/\r?\n/).reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 36)), 0);
  const h = Math.min(440, Math.max(110, Math.round(lines * 19.5 + 52)));
  return { type: 'notepad', data: { html: escapeHtml(t).replace(/\r?\n/g, '<br>') }, size: { w: 280, h } };
}

// Paste where the cursor is if it's over the board, otherwise mid-screen. Pasting
// again without moving the mouse steps each new card down-right, so they don't
// pile up exactly on top of each other.
let lastPointer = null;
let lastPaste = null;
function pastePoint() {
  const rect = els.viewport.getBoundingClientRect();
  const p = lastPointer;
  const overBoard = p && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
  const base = overBoard
    ? screenToWorld(p.x - rect.left, p.y - rect.top)
    : screenToWorld(rect.width / 2, rect.height / 2);
  if (lastPaste && Math.hypot(base.x - lastPaste.base.x, base.y - lastPaste.base.y) < 8) {
    lastPaste.count += 1;
  } else {
    lastPaste = { base, count: 0 };
  }
  return { x: base.x + lastPaste.count * 30, y: base.y + lastPaste.count * 30 };
}

async function addFromClipboard(files, text) {
  let point = pastePoint();
  const nudge = () => { point = { x: point.x + 30, y: point.y + 30 }; };
  if (files.length) {
    for (const file of files) {
      await addFileCard(file, point);
      nudge();
    }
    lastPaste.count += files.length - 1;
    return;
  }
  const { type, data, size } = cardForText(text);
  await addCard(type, { center: point, data, size });
}

document.addEventListener('paste', (e) => {
  if (els.appRoot.classList.contains('hidden') || !currentBoard) return;
  // Pasting into a note, comment, checklist item, table cell or text field
  // should just paste text there, as usual.
  const target = e.target instanceof Element ? e.target : document.body;
  if (target.closest('[contenteditable], input, textarea')) return;
  const cd = e.clipboardData;
  if (!cd) return;
  // Read everything now: the clipboard is only readable during this event.
  const files = Array.from(cd.files || []);
  const text = cd.getData('text/plain') || '';
  if (!files.length && !text.trim()) return;
  e.preventDefault();
  addFromClipboard(files, text).catch((err) => showToast("Couldn't paste that: " + (err.message || err)));
});

// ---------- Card rendering ----------

const persistTimers = new Map();
function schedulePersist(card) {
  clearTimeout(persistTimers.get(card.id));
  persistTimers.set(card.id, setTimeout(() => db.putCard(card), 300));
}

const ctx = {
  saveData(card, patch) {
    // Updates in-memory data synchronously so any immediate rerender (e.g. clicking
    // "+ Row" right after typing) always reflects the latest value; only the disk
    // write is debounced.
    Object.assign(card.data, patch);
    schedulePersist(card);
  },
  rerender(card) {
    const el = cardEls.get(card.id);
    if (!el) return;
    const body = el.querySelector('.card-body');
    CARD_TYPES[card.type].render(card, body, ctx);
  },
  setCardSize(card, w, h) {
    card.w = w;
    card.h = h;
    const el = cardEls.get(card.id);
    if (el) {
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }
    db.putCard(card);
  },
};

function renderCard(card) {
  const def = CARD_TYPES[card.type];
  const el = document.createElement('div');
  el.className = 'card card-' + card.type;
  el.style.left = card.x + 'px';
  el.style.top = card.y + 'px';
  el.style.width = card.w + 'px';
  el.style.height = card.h + 'px';
  el.style.zIndex = card.zIndex || 1;

  const handle = document.createElement('div');
  handle.className = 'card-handle';
  const iconLabel = document.createElement('span');
  iconLabel.className = 'card-handle-icon';
  iconLabel.innerHTML = def.icon;
  iconLabel.title = def.label;
  const delBtn = document.createElement('button');
  delBtn.className = 'card-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Delete card';
  delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  confirmClick(delBtn, '✓', () => deleteCard(card));
  handle.append(iconLabel, delBtn);

  const body = document.createElement('div');
  body.className = 'card-body';

  // Comments auto-size to their text (see cardTypes.js), so they get no manual
  // resize handle at all.
  const resizeHandle = card.type === 'comment' ? null : document.createElement('div');
  if (resizeHandle) resizeHandle.className = 'resize-handle';

  el.append(handle, body);
  if (resizeHandle) el.appendChild(resizeHandle);
  els.world.appendChild(el);
  cardEls.set(card.id, el);

  def.render(card, body, ctx);

  wireCardDrag(card, el, handle);
  if (resizeHandle) wireCardResize(card, el, resizeHandle, { lockAspect: card.type === 'image' });
  if (card.type === 'comment' || card.type === 'image') wireBodyDrag(card, el, body);

  el.addEventListener('pointerdown', () => bringToFront(card, el));
}

function bringToFront(card, el) {
  const alreadyOnTop = [...cards.values()].every((c) => c === card || c.zIndex < card.zIndex);
  if (alreadyOnTop) return;
  card.zIndex = ++maxZ;
  el.style.zIndex = card.zIndex;
  db.putCard(card);
}

function wireCardDrag(card, el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = card.x;
    const originY = card.y;

    function onMove(ev) {
      const dx = (ev.clientX - startX) / view.scale;
      const dy = (ev.clientY - startY) / view.scale;
      card.x = originX + dx;
      card.y = originY + dy;
      el.style.left = card.x + 'px';
      el.style.top = card.y + 'px';
    }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      db.putCard(card);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// Comment and image cards have no visible handle bar, so the whole body is the
// grab area. We preventDefault on pointerdown so the browser never starts its
// own native text-selection/image drag (which would otherwise fight our own
// drag logic); for comments, a plain click (no movement past the threshold)
// manually places the caret instead, so clicking to edit still works normally.
const DRAG_THRESHOLD = 5;
function placeCaretAt(editor, x, y) {
  editor.focus();
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (range) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function wireBodyDrag(card, el, body) {
  body.addEventListener('pointerdown', (e) => {
    // Let native controls (e.g. the image card's hidden file-picker input
    // before an image is chosen) behave normally instead of being hijacked.
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    const editor = body.querySelector('[contenteditable]');
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = card.x;
    const originY = card.y;
    let dragging = false;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;
      }
      card.x = originX + dx / view.scale;
      card.y = originY + dy / view.scale;
      el.style.left = card.x + 'px';
      el.style.top = card.y + 'px';
    }
    function onUp(ev) {
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerup', onUp);
      if (dragging) {
        db.putCard(card);
      } else if (editor) {
        placeCaretAt(editor, ev.clientX, ev.clientY);
      }
    }
    body.addEventListener('pointermove', onMove);
    body.addEventListener('pointerup', onUp);
  });
}

function wireCardResize(card, el, handle, opts = {}) {
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = card.w;
    const originH = card.h;
    const ratio = originW / originH;
    if (opts.lockAspect) card.data.sized = true;

    function onMove(ev) {
      const dx = (ev.clientX - startX) / view.scale;
      const dy = (ev.clientY - startY) / view.scale;
      if (opts.lockAspect) {
        // Project the drag onto the box's own diagonal so resizing (from any
        // direction off the corner) always keeps the original aspect ratio —
        // this is what makes it feel like resizing the image itself, not a
        // separately-shaped frame around it.
        const t = (dx * ratio + dy) / (ratio * ratio + 1);
        card.w = Math.max(30, originW + t * ratio);
        card.h = card.w / ratio;
      } else {
        card.w = Math.max(100, originW + dx);
        card.h = Math.max(60, originH + dy);
      }
      el.style.width = card.w + 'px';
      el.style.height = card.h + 'px';
    }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      db.putCard(card);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

async function cleanupCardBlobs(card) {
  if (card.data && card.data.blobId) {
    revokeBlobUrl(card.data.blobId);
    await db.deleteBlob(card.data.blobId);
  }
}

async function deleteCard(card) {
  await cleanupCardBlobs(card);
  await db.deleteCard(card.id);
  const el = cardEls.get(card.id);
  if (el) el.remove();
  cards.delete(card.id);
  cardEls.delete(card.id);
}

// ---------- Pan & zoom ----------

function wireGlobalEvents() {
  els.viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== els.viewport && e.target !== els.world) return;
    els.viewport.classList.add('panning');
    els.viewport.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = view.x;
    const originY = view.y;

    function onMove(ev) {
      view.x = originX + (ev.clientX - startX);
      view.y = originY + (ev.clientY - startY);
      applyView();
    }
    function onUp() {
      els.viewport.classList.remove('panning');
      els.viewport.removeEventListener('pointermove', onMove);
      els.viewport.removeEventListener('pointerup', onUp);
      persistView();
    }
    els.viewport.addEventListener('pointermove', onMove);
    els.viewport.addEventListener('pointerup', onUp);
  });

  els.viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = els.viewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const before = screenToWorld(cx, cy);
      const factor = Math.exp(-e.deltaY * 0.01);
      view.scale = Math.min(3, Math.max(0.2, view.scale * factor));
      view.x = cx - before.x * view.scale;
      view.y = cy - before.y * view.scale;
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
    }
    applyView();
    persistView();
  }, { passive: false });

  els.zoomIn.addEventListener('click', () => zoomBy(1.2));
  els.zoomOut.addEventListener('click', () => zoomBy(1 / 1.2));
  els.zoomReset.addEventListener('click', () => {
    view = defaultView();
    applyView();
    persistView();
  });

  // Drag files in from Finder, another app, or a browser tab and drop them onto the board.
  els.viewport.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  els.viewport.addEventListener('drop', async (e) => {
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (files.length === 0) return;
    e.preventDefault();
    const rect = els.viewport.getBoundingClientRect();
    let point = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    try {
      for (const file of files) {
        await addFileCard(file, point);
        point = { x: point.x + 30, y: point.y + 30 };
      }
    } catch (err) {
      showToast("Couldn't add that file: " + (err.message || err));
    }
  });

  window.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; });
}

function zoomBy(factor) {
  const rect = els.viewport.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const before = screenToWorld(cx, cy);
  view.scale = Math.min(3, Math.max(0.2, view.scale * factor));
  view.x = cx - before.x * view.scale;
  view.y = cy - before.y * view.scale;
  applyView();
  persistView();
}

let persistTimer = null;
function persistView() {
  if (!currentBoard) return;
  currentBoard.view = { ...view };
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => db.putBoard(currentBoard), 400);
}

// ---------- Auth gate ----------

async function boot() {
  const session = await auth.getSession();
  if (session) {
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  els.loginScreen.classList.remove('hidden');
  els.appRoot.classList.add('hidden');
  els.loginEmail.focus();
}

function showApp() {
  els.loginScreen.classList.add('hidden');
  els.appRoot.classList.remove('hidden');
  init();
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.textContent = '';
  const submitBtn = els.loginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await auth.signIn(els.loginEmail.value.trim(), els.loginPassword.value);
    els.loginPassword.value = '';
    showApp();
  } catch (err) {
    els.loginError.textContent = 'Wrong email or password.';
  } finally {
    submitBtn.disabled = false;
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await auth.signOut();
  location.reload();
});

boot();
