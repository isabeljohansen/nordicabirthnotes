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

let initStarted = false;
async function init() {
  if (initStarted) return;
  initStarted = true;
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
    item.title = 'Drag to reorder · double-click to rename';
    const name = document.createElement('div');
    name.className = 'board-item-name';
    name.textContent = board.name;
    name.addEventListener('click', () => {
      if (!boardDragJustEnded) loadBoard(board.id);
    });
    const del = document.createElement('button');
    del.className = 'board-item-del';
    del.textContent = '×';
    del.title = 'Delete board';
    confirmClick(del, 'Sure?', () => deleteBoard(board));
    item.append(name, del);
    item.addEventListener('pointerdown', (e) => startBoardDrag(e, item));
    els.boardList.appendChild(item);
  }
}

// ---------- Reorder & rename boards ----------

// Boards are listed oldest-first, so the order IS their creation timestamps. Rearranging
// re-spaces those timestamps (keeping the new order) rather than adding a database column,
// so there's nothing to migrate in Supabase and older copies of the app still read it fine.
async function saveBoardOrder() {
  const base = Math.min(...boards.map((b) => b.createdAt));
  const changed = [];
  boards.forEach((b, i) => {
    const t = base + i * 1000;
    if (b.createdAt !== t) {
      b.createdAt = t;
      changed.push(b);
    }
  });
  try {
    await Promise.all(changed.map((b) => db.putBoard(b)));
  } catch (err) {
    showToast("Couldn't save the new board order: " + (err.message || err));
  }
}

// Press and drag a board up or down the list. A plain click still opens the board.
let boardDragJustEnded = false;
function startBoardDrag(e, item) {
  if (!isPrimaryPress(e) || e.target.closest('.board-item-del, .board-rename-input')) return;
  const items = [...els.boardList.querySelectorAll('.board-item')];
  const from = items.indexOf(item);
  const step = item.offsetHeight;
  const startY = e.clientY;
  let dragging = false;
  let to = from;

  trackDrag(e, item, {
    capture: false,
    onMove(ev) {
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;
        item.classList.add('dragging');
        els.boardList.classList.add('reordering');
      }
      to = Math.max(0, Math.min(items.length - 1, from + Math.round(dy / step)));
      const lift = Math.max(-from * step, Math.min((items.length - 1 - from) * step, dy));
      item.style.transform = `translateY(${lift}px)`;
      items.forEach((other, j) => {
        if (other === item) return;
        let shift = 0;
        if (from < to && j > from && j <= to) shift = -step;
        if (to < from && j >= to && j < from) shift = step;
        other.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    },
    onEnd() {
      els.boardList.classList.remove('reordering');
      if (!dragging) return;
      boardDragJustEnded = true; // swallow the click that follows the release
      setTimeout(() => { boardDragJustEnded = false; }, 150);
      if (to !== from) {
        const [moved] = boards.splice(from, 1);
        boards.splice(to, 0, moved);
        saveBoardOrder();
      }
      renderSidebar();
    },
  });
}

function startRename(board, nameEl) {
  const input = document.createElement('input');
  input.className = 'board-rename-input';
  input.value = board.name;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Board name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  async function finish(save) {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (save && name && name !== board.name) {
      board.name = name;
      if (currentBoard && currentBoard.id === board.id) els.boardName.textContent = name;
      renderSidebar();
      try {
        await db.putBoard(board);
      } catch (err) {
        showToast("Couldn't rename that board: " + (err.message || err));
      }
    } else {
      renderSidebar();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Delegated, because clicking a board re-draws the list between the two clicks of a double-click.
els.boardList.addEventListener('dblclick', (e) => {
  const item = e.target.closest('.board-item');
  if (!item || e.target.closest('.board-item-del, .board-rename-input')) return;
  const nameEl = item.querySelector('.board-item-name');
  const board = boards[[...els.boardList.children].indexOf(item)];
  if (nameEl && board) startRename(board, nameEl);
});

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

// Loading a board is a network round-trip, so a second call can start before the
// first finishes (clicking the open board twice, or hopping between boards). Without
// the checks below, both loads would draw the board's cards: every card shown twice,
// stacked exactly on top of each other, each copy saving over the other's size and
// position, so images seem to resize and move by themselves.
let loadSeq = 0;
async function loadBoard(boardId) {
  const target = boards.find((b) => b.id === boardId);
  if (!target) return;
  if (currentBoard && currentBoard.id === boardId) return; // already showing (or loading) it

  const seq = ++loadSeq;
  selectedCardId = null;
  currentBoard = target;
  localStorage.setItem(LAST_BOARD_KEY, boardId);

  els.boardName.textContent = target.name;
  els.world.innerHTML = '';
  cards.clear();
  cardEls.clear();
  maxZ = 1;
  view = target.view || defaultView();
  applyView();
  renderSidebar();

  let boardCards;
  try {
    boardCards = await db.getCardsByBoard(boardId);
  } catch (err) {
    if (seq === loadSeq) {
      currentBoard = null; // so clicking the board again retries
      renderSidebar();
      showToast("Couldn't load that board: " + (err.message || err));
    }
    return;
  }
  if (seq !== loadSeq) return; // the user moved on to another board while this loaded

  for (const card of boardCards) {
    cards.set(card.id, card);
    maxZ = Math.max(maxZ, card.zIndex || 1);
  }
  for (const card of cards.values()) {
    renderCard(card);
  }
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
    btn.addEventListener('click', () => {
      // End editing wherever it is, right now: some browsers don't move focus when a
      // button is clicked, and typing would otherwise still go to the old card.
      const active = document.activeElement;
      if (active && isEditingField(active)) active.blur();
      addCard(type, { edit: true });
    });
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
const CARDS_TYPED_INTO = new Set(['notepad', 'comment', 'checklist', 'table']);
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
  // Show it (and, for text cards, put the cursor in it) straight away, then save in the
  // background. Waiting for the save first meant anything typed in that gap went to
  // whatever card had the cursor before. Saves for a card are ordered, so this is safe.
  cards.set(card.id, card);
  renderCard(card);
  selectCard(card);
  if (opts.edit && CARDS_TYPED_INTO.has(type)) {
    const field = cardEls.get(card.id)?.querySelector('[contenteditable]');
    if (field) field.focus();
  }
  try {
    await db.putCard(card);
  } catch (err) {
    const el = cardEls.get(card.id);
    if (el) el.remove();
    cards.delete(card.id);
    cardEls.delete(card.id);
    if (selectedCardId === card.id) selectedCardId = null;
    showToast("Couldn't add that: " + (err.message || err));
    return null;
  }
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

function showToast(message, action) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      toast.classList.remove('show');
      action.onClick();
    });
    toast.appendChild(btn);
  }
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), action ? 8000 : 4500);
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

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

function renderCard(card) {
  const def = CARD_TYPES[card.type];
  const el = document.createElement('div');
  el.className = 'card card-' + card.type;
  el.style.left = card.x + 'px';
  el.style.top = card.y + 'px';
  el.style.width = card.w + 'px';
  el.style.height = card.h + 'px';
  el.style.zIndex = card.zIndex || 1;

  const body = document.createElement('div');
  body.className = 'card-body';

  // Comments auto-size to their text (see cardTypes.js), so they get no manual
  // resize handle at all.
  const resizeHandle = card.type === 'comment' ? null : document.createElement('div');
  if (resizeHandle) resizeHandle.className = 'resize-handle';

  // No banner on cards. The only chrome is this small trash button, and it only shows
  // while the card is selected (it's the way to delete without a keyboard, e.g. on a phone).
  const trash = document.createElement('button');
  trash.type = 'button';
  trash.className = 'card-trash';
  trash.title = 'Delete (or press the Delete key)';
  trash.setAttribute('aria-label', 'Delete');
  trash.innerHTML = TRASH_ICON;
  trash.addEventListener('click', () => removeCard(card));

  el.appendChild(body);
  if (resizeHandle) el.appendChild(resizeHandle);
  el.appendChild(trash);
  els.world.appendChild(el);
  cardEls.set(card.id, el);

  def.render(card, body, ctx);

  if (resizeHandle) wireCardResize(card, el, resizeHandle, { lockAspect: card.type === 'image' });
  wireBodyDrag(card, el, body);

  // Any press on the card (capture phase, so nothing inside can swallow it) selects it,
  // brings it to the front, and ends editing in any other text field.
  el.addEventListener('pointerdown', (e) => {
    pressedOnSelected = selectedCardId === card.id;
    const active = document.activeElement;
    if (active && isEditingField(active) && !active.contains(e.target)) active.blur();
    selectCard(card);
    bringToFront(card, el);
  }, true);
}

function bringToFront(card, el) {
  const alreadyOnTop = [...cards.values()].every((c) => c === card || c.zIndex < card.zIndex);
  if (alreadyOnTop) return;
  card.zIndex = ++maxZ;
  el.style.zIndex = card.zIndex;
  db.putCard(card);
}

// Only a plain left-button press starts a drag. On a Mac, Ctrl+click and a two-finger
// click open the right-click menu, which swallows the "button released" event; a drag
// begun from one of those never ends and keeps following the mouse.
const isPrimaryPress = (e) => e.button === 0 && !e.ctrlKey;

// Runs one pointer drag, from the press that started it until the button is released.
// Listens on the window and ends on pointerup, pointercancel, lost capture, the window
// losing focus, OR any pointer move that arrives with no button held. That last one is
// the safety net: if a "button released" event is ever missed (it happens on some
// trackpads and browsers), the drag still ends on the next mouse move instead of
// staying stuck to the cursor and resizing or moving a card on every move afterwards.
let endActiveDrag = null;
// capture: false skips routing the mouse to `target`. Capture is needed over iframes/canvases,
// but it also makes the browser aim the follow-up "click" at `target` instead of the child
// that was pressed, which would swallow clicks on things inside it (the board list).
function trackDrag(e, target, { onMove, onEnd, capture = true }) {
  if (endActiveDrag) endActiveDrag({ type: 'superseded' }); // never two drags at once
  const id = e.pointerId;
  if (capture) {
    try { target.setPointerCapture(id); } catch (_) { /* pointer already gone */ }
  }
  let finished = false;

  const move = (ev) => {
    if (ev.pointerId !== id) return;
    if (ev.buttons === 0) { end(ev); return; }
    onMove(ev);
  };
  const up = (ev) => { if (ev.pointerId === id) end(ev); };
  const end = (ev) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('blur', end);
    target.removeEventListener('lostpointercapture', end);
    if (endActiveDrag === end) endActiveDrag = null;
    try { target.releasePointerCapture(id); } catch (_) { /* already released */ }
    onEnd(ev);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('blur', end);
  target.addEventListener('lostpointercapture', end);
  endActiveDrag = end;
}

// Cards have no handle bar: press anywhere on a card that isn't a real control and
// drag to move it. We preventDefault on pointerdown so the browser never starts its
// own text-selection/image drag, which would fight our drag. Text works in two steps:
// the first click selects the card (so you can drag it or press Delete), and clicking
// the text of an already-selected card starts editing it. Once you're editing, presses
// inside that text field are left alone so normal text selection and caret movement work.
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

// Things that must keep their own behaviour when clicked: buttons, form fields, links,
// the audio player, iframes and canvases. Everything else on a card is surface to grab.
const NATIVE_CONTROLS = 'button, input, select, textarea, audio, a[href], iframe, canvas';
const isNativeControl = (node) => !!(node.closest && node.closest(NATIVE_CONTROLS));

function wireBodyDrag(card, el, body) {
  body.addEventListener('pointerdown', (e) => {
    if (!isPrimaryPress(e) || isNativeControl(e.target)) return;
    const editable = e.target.closest('[contenteditable]');
    if (editable && document.activeElement === editable) return; // already editing: native text editing
    const wasSelected = pressedOnSelected;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = card.x;
    const originY = card.y;
    let dragging = false;

    trackDrag(e, body, {
      onMove(ev) {
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
      },
      onEnd(ev) {
        if (dragging) {
          db.putCard(card);
        } else if (editable && wasSelected && ev.type === 'pointerup') {
          placeCaretAt(editable, ev.clientX, ev.clientY);
        }
      },
    });
  });
}

function wireCardResize(card, el, handle, opts = {}) {
  handle.addEventListener('pointerdown', (e) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = card.w;
    const originH = card.h;
    const ratio = originW / originH;
    if (opts.lockAspect) card.data.sized = true;

    trackDrag(e, handle, {
      onMove(ev) {
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
      },
      onEnd() { db.putCard(card); },
    });
  });
}

async function cleanupCardBlobs(card) {
  if (card.data && card.data.blobId) {
    revokeBlobUrl(card.data.blobId);
    await db.deleteBlob(card.data.blobId);
  }
}

// ---------- Selection, delete key, undo ----------

let selectedCardId = null;
let pressedOnSelected = false; // was the card already selected when the current press began?

function selectCard(card) {
  const next = card ? card.id : null;
  if (selectedCardId === next) return;
  if (selectedCardId) {
    const prev = cardEls.get(selectedCardId);
    if (prev) prev.classList.remove('selected');
  }
  selectedCardId = next;
  if (next) cardEls.get(next)?.classList.add('selected');
}

const isEditingField = (node) => !!(node && node.closest && node.closest('[contenteditable], input, textarea, select'));

// A deleted card stays recoverable for a while: it's gone from the board and the database
// straight away, but its uploaded file is only discarded once the undo window has passed.
const UNDO_WINDOW_MS = 15000;
const deletedCards = [];

async function removeCard(card) {
  const el = cardEls.get(card.id);
  if (el) el.remove();
  cards.delete(card.id);
  cardEls.delete(card.id);
  if (selectedCardId === card.id) selectedCardId = null;

  const entry = { card, deleting: null, timer: null };
  entry.timer = setTimeout(() => {
    const i = deletedCards.indexOf(entry);
    if (i >= 0) deletedCards.splice(i, 1);
    cleanupCardBlobs(card).catch(() => {});
  }, UNDO_WINDOW_MS);
  deletedCards.push(entry);
  showToast('Deleted', { label: 'Undo', onClick: undoDelete });

  entry.deleting = db.deleteCard(card.id);
  try {
    await entry.deleting;
  } catch (err) {
    // The database refused: don't pretend it's gone.
    clearTimeout(entry.timer);
    const i = deletedCards.indexOf(entry);
    if (i >= 0) deletedCards.splice(i, 1);
    if (currentBoard && card.boardId === currentBoard.id) {
      cards.set(card.id, card);
      renderCard(card);
    }
    showToast("Couldn't delete that: " + (err.message || err));
  }
}

async function undoDelete() {
  const entry = deletedCards.pop();
  if (!entry) return;
  clearTimeout(entry.timer);
  const card = entry.card;
  try {
    await entry.deleting; // make sure the delete has landed before putting the row back
  } catch (err) {
    return;
  }
  await db.putCard(card);
  if (currentBoard && card.boardId === currentBoard.id) {
    cards.set(card.id, card);
    renderCard(card);
    selectCard(card);
  }
  showToast('Restored');
}

document.addEventListener('keydown', (e) => {
  if (els.appRoot.classList.contains('hidden') || !currentBoard) return;
  const editing = isEditingField(document.activeElement);
  if (e.key === 'Escape') {
    if (editing) document.activeElement.blur(); // stop editing, card stays selected
    else selectCard(null);
    return;
  }
  if (editing) return; // Delete/Backspace/Cmd+Z belong to the text being edited
  // Backspace counts too: on a Mac the key labelled "delete" sends Backspace.
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCardId) {
    const card = cards.get(selectedCardId);
    if (card) {
      e.preventDefault();
      removeCard(card);
    }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && deletedCards.length) {
    e.preventDefault();
    undoDelete();
  }
});

// ---------- Pan & zoom ----------

function wireGlobalEvents() {
  els.viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== els.viewport && e.target !== els.world) return;
    if (!isPrimaryPress(e)) return;
    selectCard(null);
    const active = document.activeElement;
    if (active && isEditingField(active)) active.blur();
    els.viewport.classList.add('panning');
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = view.x;
    const originY = view.y;

    trackDrag(e, els.viewport, {
      onMove(ev) {
        view.x = originX + (ev.clientX - startX);
        view.y = originY + (ev.clientY - startY);
        applyView();
      },
      onEnd() {
        els.viewport.classList.remove('panning');
        persistView();
      },
    });
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
