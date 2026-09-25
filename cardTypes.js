import { db, uid } from './db.js';

// Cache of blobId -> objectURL so we don't recreate them on every render.
const objectUrlCache = new Map();

export async function getBlobUrl(blobId) {
  if (objectUrlCache.has(blobId)) return objectUrlCache.get(blobId);
  const record = await db.getBlob(blobId);
  if (!record) return null;
  const url = URL.createObjectURL(record.blob);
  objectUrlCache.set(blobId, url);
  return url;
}

// Show a file the user just added straight from memory, instead of downloading
// the copy we just uploaded (slow for big photos, and the card would sit empty).
export function primeBlobUrl(blobId, blob) {
  if (!objectUrlCache.has(blobId)) objectUrlCache.set(blobId, URL.createObjectURL(blob));
}

export function revokeBlobUrl(blobId) {
  const url = objectUrlCache.get(blobId);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlCache.delete(blobId);
  }
}

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  return node;
}

export function parseVideoUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const id = u.searchParams.get('v');
      if (id) return `https://www.youtube.com/embed/${id}`;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'embed' && parts[1]) return `https://www.youtube.com/embed/${parts[1]}`;
    }
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1);
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (u.hostname.includes('vimeo.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 1];
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
  } catch (e) {
    return null;
  }
  return null;
}

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  notepad: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  comment: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  checklist: svg('<path d="M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.5"/><path d="m9 11 3 3L22 4"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  table: svg('<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>'),
  swatch: svg('<circle cx="12" cy="12" r="8.5" stroke="none" style="fill:var(--swatch-icon)"/>'),
  image: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
  document: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  audio: svg('<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'),
  video: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 8 6 4-6 4Z"/>'),
  drawing: svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
};

export const CARD_TYPES = {
  notepad: {
    label: 'Notepad', icon: ICONS.notepad,
    defaultSize: { w: 260, h: 200 },
    createData: () => ({ html: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      const editor = el('div', 'notepad-editor', { contenteditable: 'true' });
      editor.innerHTML = card.data.html || '';
      editor.setAttribute('data-placeholder', 'Type a note…');
      editor.addEventListener('input', () => ctx.saveData(card, { html: editor.innerHTML }));
      editor.addEventListener('pointerdown', (e) => e.stopPropagation());
      body.appendChild(editor);
    },
  },

  comment: {
    label: 'Comment', icon: ICONS.comment,
    defaultSize: { w: 220, h: 60 },
    createData: () => ({ text: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      const editor = el('div', 'comment-editor', { contenteditable: 'true' });
      editor.innerText = card.data.text || '';
      editor.setAttribute('data-placeholder', 'Add a comment…');

      // Comments have no resize handle — height always fits the text. Everything around
      // the text (handle strip, border, the body's own padding) is measured live rather
      // than hardcoded, so it stays right if that CSS changes. Layout sizes (offsetHeight,
      // scrollHeight) are used on purpose: getBoundingClientRect shrinks/grows with the
      // board's zoom level and would make the bubble the wrong height unless zoom is 100%.
      function fitHeight() {
        const cs = getComputedStyle(body);
        const bodyPadding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const chrome = card.h - body.offsetHeight + bodyPadding;
        // +2px safety margin: without it, a sub-pixel shortfall can make the
        // browser think the content overflows by a hair, which (even with
        // scrolling off) auto-scrolls to keep the caret visible and clips the
        // top line.
        const needed = Math.max(46, Math.ceil(editor.scrollHeight + chrome) + 2);
        if (Math.abs(needed - card.h) > 1) ctx.setCardSize(card, card.w, needed);
      }

      editor.addEventListener('input', () => {
        ctx.saveData(card, { text: editor.innerText });
        fitHeight();
      });
      // No pointerdown stopPropagation here (unlike other card types): the comment
      // body itself is draggable, handled by wireBodyDrag in app.js.
      body.appendChild(editor);
      fitHeight();
      // Re-measure whenever the text changes size on its own, e.g. when the web font
      // finishes loading after the bubble was first measured with a fallback font
      // (different letter widths => different wrapping => wrong height).
      new ResizeObserver(fitHeight).observe(editor);
    },
  },

  checklist: {
    label: 'Checklist', icon: ICONS.checklist,
    defaultSize: { w: 240, h: 220 },
    createData: () => ({ items: [{ id: uid(), text: '', done: false }] }),
    render(card, body, ctx) {
      body.innerHTML = '';
      const list = el('div', 'checklist');
      let focusEl = null;
      card.data.items.forEach((item, idx) => {
        const row = el('div', 'checklist-item');
        const cb = el('input', 'checklist-checkbox', { type: 'checkbox' });
        cb.checked = item.done;
        cb.addEventListener('pointerdown', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          item.done = cb.checked;
          ctx.saveData(card, { items: card.data.items });
        });
        const text = el('div', 'checklist-text', { contenteditable: 'true' });
        text.innerText = item.text;
        text.setAttribute('data-placeholder', 'List item…');
        text.addEventListener('pointerdown', (e) => e.stopPropagation());
        text.addEventListener('input', () => {
          item.text = text.innerText;
          ctx.saveData(card, { items: card.data.items });
        });
        text.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            card.data.items.splice(idx + 1, 0, { id: uid(), text: '', done: false });
            card.data._focusIndex = idx + 1;
            ctx.saveData(card, { items: card.data.items });
            ctx.rerender(card);
          }
        });
        if (idx === card.data._focusIndex) focusEl = text;
        const del = el('button', 'checklist-del', { text: '×' });
        del.addEventListener('pointerdown', (e) => e.stopPropagation());
        del.addEventListener('click', () => {
          card.data.items.splice(idx, 1);
          if (card.data.items.length === 0) card.data.items.push({ id: uid(), text: '', done: false });
          ctx.saveData(card, { items: card.data.items });
          ctx.rerender(card);
        });
        row.append(cb, text, del);
        list.appendChild(row);
      });
      delete card.data._focusIndex;
      const addBtn = el('button', 'checklist-add', { text: '+ Add item' });
      addBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      addBtn.addEventListener('click', () => {
        card.data.items.push({ id: uid(), text: '', done: false });
        card.data._focusIndex = card.data.items.length - 1;
        ctx.saveData(card, { items: card.data.items });
        ctx.rerender(card);
      });
      body.append(list, addBtn);
      if (focusEl) focusEl.focus();
    },
  },

  link: {
    label: 'Link', icon: ICONS.link,
    defaultSize: { w: 240, h: 120 },
    createData: () => ({ url: '', title: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      if (card.data.url && !card.data._editing) {
        const wrap = el('div', 'link-view');
        const a = el('a', 'link-title', { href: card.data.url, target: '_blank', rel: 'noopener noreferrer' });
        a.textContent = card.data.title || card.data.url;
        a.addEventListener('pointerdown', (e) => e.stopPropagation());
        const urlLine = el('div', 'link-url', { text: card.data.url });
        const editBtn = el('button', 'link-edit', { text: 'Edit' });
        editBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        editBtn.addEventListener('click', () => {
          card.data._editing = true;
          ctx.rerender(card);
        });
        wrap.append(a, urlLine, editBtn);
        body.appendChild(wrap);
      } else {
        const form = el('div', 'link-form');
        const urlInput = el('input', 'link-input', { placeholder: 'Paste URL…', type: 'url' });
        const titleInput = el('input', 'link-input', { placeholder: 'Label (optional)' });
        urlInput.value = card.data.url || '';
        titleInput.value = card.data.title || '';
        [urlInput, titleInput].forEach((i) => i.addEventListener('pointerdown', (e) => e.stopPropagation()));
        const saveBtn = el('button', 'link-save', { text: 'Save' });
        saveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        saveBtn.addEventListener('click', () => {
          let url = urlInput.value.trim();
          if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
          card.data._editing = false;
          ctx.saveData(card, { url, title: titleInput.value.trim() });
          ctx.rerender(card);
        });
        form.append(urlInput, titleInput, saveBtn);
        body.appendChild(form);
      }
    },
  },

  table: {
    label: 'Table', icon: ICONS.table,
    defaultSize: { w: 320, h: 200 },
    createData: () => ({ rows: [['', ''], ['', '']] }),
    render(card, body, ctx) {
      body.innerHTML = '';
      const wrap = el('div', 'table-wrap');
      const table = el('table', 'card-table');
      card.data.rows.forEach((row, r) => {
        const tr = el('tr');
        row.forEach((cellVal, c) => {
          const td = el('td');
          const cell = el('div', 'table-cell', { contenteditable: 'true' });
          cell.innerText = cellVal;
          cell.addEventListener('pointerdown', (e) => e.stopPropagation());
          cell.addEventListener('input', () => {
            card.data.rows[r][c] = cell.innerText;
            ctx.saveData(card, { rows: card.data.rows });
          });
          td.appendChild(cell);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      const controls = el('div', 'table-controls');
      const addRow = el('button', '', { text: '+ Row' });
      const addCol = el('button', '', { text: '+ Col' });
      const delRow = el('button', '', { text: '− Row' });
      const delCol = el('button', '', { text: '− Col' });
      [addRow, addCol, delRow, delCol].forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));
      addRow.addEventListener('click', () => {
        const cols = card.data.rows[0]?.length || 1;
        card.data.rows.push(new Array(cols).fill(''));
        ctx.saveData(card, { rows: card.data.rows });
        ctx.rerender(card);
      });
      addCol.addEventListener('click', () => {
        card.data.rows.forEach((row) => row.push(''));
        ctx.saveData(card, { rows: card.data.rows });
        ctx.rerender(card);
      });
      delRow.addEventListener('click', () => {
        if (card.data.rows.length > 1) card.data.rows.pop();
        ctx.saveData(card, { rows: card.data.rows });
        ctx.rerender(card);
      });
      delCol.addEventListener('click', () => {
        if (card.data.rows[0].length > 1) card.data.rows.forEach((row) => row.pop());
        ctx.saveData(card, { rows: card.data.rows });
        ctx.rerender(card);
      });
      controls.append(addRow, addCol, delRow, delCol);
      wrap.append(table, controls);
      body.appendChild(wrap);
    },
  },

  swatch: {
    label: 'Color', icon: ICONS.swatch,
    defaultSize: { w: 140, h: 140 },
    createData: () => ({ color: '#c9a9e0', label: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      const wrap = el('div', 'swatch-wrap');
      const box = el('div', 'swatch-box');
      box.style.background = card.data.color;
      const picker = el('input', 'swatch-picker', { type: 'color' });
      picker.value = card.data.color;
      picker.addEventListener('pointerdown', (e) => e.stopPropagation());
      picker.addEventListener('input', () => {
        box.style.background = picker.value;
        ctx.saveData(card, { color: picker.value, label: card.data.label });
      });
      const label = el('div', 'swatch-label', { contenteditable: 'true' });
      label.innerText = card.data.label || card.data.color;
      label.addEventListener('pointerdown', (e) => e.stopPropagation());
      label.addEventListener('input', () => ctx.saveData(card, { color: card.data.color, label: label.innerText }));
      box.appendChild(picker);
      wrap.append(box, label);
      body.appendChild(wrap);
    },
  },

  image: {
    label: 'Image', icon: ICONS.image,
    defaultSize: { w: 260, h: 200 },
    createData: () => ({ blobId: null, filename: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      if (!card.data.blobId) {
        body.appendChild(makeFilePicker('image/*', async (file) => {
          const blobId = uid();
          await db.putBlob(blobId, file, { filename: file.name, mimeType: file.type });
          primeBlobUrl(blobId, file);
          ctx.saveData(card, { blobId, filename: file.name });
          ctx.rerender(card);
        }));
        return;
      }
      const img = el('img', 'image-el');
      img.draggable = false;
      // Fit the card box to the image's own aspect ratio the first time it loads,
      // so there's no letterboxed "invisible frame" around it. Once fitted, the
      // resize handle (locked to this ratio) keeps it that way permanently.
      img.onload = () => {
        if (card.data.sized) return;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh) return;
        const maxDim = 340;
        const scale = Math.min(1, maxDim / Math.max(nw, nh));
        // Flag first, so the single save below carries both the size and "fitted";
        // saved separately, a lost flag would make the image re-fit on every load.
        card.data.sized = true;
        ctx.setCardSize(card, Math.round(nw * scale), Math.round(nh * scale));
      };
      getBlobUrl(card.data.blobId).then((url) => {
        if (url) img.src = url;
      });
      body.appendChild(img);
    },
  },

  document: {
    label: 'Document', icon: ICONS.document,
    defaultSize: { w: 220, h: 100 },
    createData: () => ({ blobId: null, filename: '', mimeType: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      if (!card.data.blobId) {
        body.appendChild(makeFilePicker('*/*', async (file) => {
          const blobId = uid();
          await db.putBlob(blobId, file, { filename: file.name, mimeType: file.type });
          primeBlobUrl(blobId, file);
          ctx.saveData(card, { blobId, filename: file.name, mimeType: file.type });
          ctx.rerender(card);
        }));
        return;
      }
      const wrap = el('div', 'doc-wrap');
      const icon = el('div', 'doc-icon');
      icon.innerHTML = ICONS.document;
      const name = el('div', 'doc-name', { text: card.data.filename });
      const openBtn = el('button', 'doc-open', { text: 'Open' });
      openBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      openBtn.addEventListener('click', async () => {
        const url = await getBlobUrl(card.data.blobId);
        if (url) window.open(url, '_blank');
      });
      wrap.append(icon, name, openBtn);
      body.appendChild(wrap);
    },
  },

  audio: {
    label: 'Audio', icon: ICONS.audio,
    defaultSize: { w: 260, h: 100 },
    createData: () => ({ blobId: null, filename: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      if (!card.data.blobId) {
        body.appendChild(makeFilePicker('audio/*', async (file) => {
          const blobId = uid();
          await db.putBlob(blobId, file, { filename: file.name, mimeType: file.type });
          primeBlobUrl(blobId, file);
          ctx.saveData(card, { blobId, filename: file.name });
          ctx.rerender(card);
        }));
        return;
      }
      const wrap = el('div', 'audio-wrap');
      const name = el('div', 'audio-name', { text: card.data.filename });
      const audio = el('audio', 'audio-player', { controls: 'true' });
      audio.addEventListener('pointerdown', (e) => e.stopPropagation());
      getBlobUrl(card.data.blobId).then((url) => {
        if (url) audio.src = url;
      });
      wrap.append(name, audio);
      body.appendChild(wrap);
    },
  },

  video: {
    label: 'Video', icon: ICONS.video,
    defaultSize: { w: 320, h: 200 },
    createData: () => ({ url: '', embedUrl: '' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      if (!card.data.embedUrl) {
        const form = el('div', 'video-form');
        const input = el('input', 'link-input', { placeholder: 'YouTube or Vimeo URL…' });
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
        const saveBtn = el('button', 'link-save', { text: 'Embed' });
        saveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        const hint = el('div', 'video-hint', { text: '' });
        saveBtn.addEventListener('click', () => {
          const embedUrl = parseVideoUrl(input.value.trim());
          if (!embedUrl) {
            hint.textContent = "Couldn't recognize that URL — try a full YouTube or Vimeo link.";
            return;
          }
          ctx.saveData(card, { url: input.value.trim(), embedUrl });
          ctx.rerender(card);
        });
        form.append(input, saveBtn, hint);
        body.appendChild(form);
        return;
      }
      const iframe = el('iframe', 'video-embed', {
        src: card.data.embedUrl,
        frameborder: '0',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
        allowfullscreen: 'true',
      });
      body.appendChild(iframe);
    },
  },

  drawing: {
    label: 'Drawing', icon: ICONS.drawing,
    defaultSize: { w: 280, h: 220 },
    createData: () => ({ strokes: [], color: '#2b2b2b' }),
    render(card, body, ctx) {
      body.innerHTML = '';
      const wrap = el('div', 'drawing-wrap');
      const toolbar = el('div', 'drawing-toolbar');
      const colorInput = el('input', 'drawing-color', { type: 'color' });
      colorInput.value = card.data.color || '#2b2b2b';
      colorInput.addEventListener('pointerdown', (e) => e.stopPropagation());
      const clearBtn = el('button', '', { text: 'Clear' });
      clearBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      toolbar.append(colorInput, clearBtn);

      const canvas = el('canvas', 'drawing-canvas');
      wrap.append(toolbar, canvas);
      body.appendChild(wrap);

      const dpr = window.devicePixelRatio || 1;
      function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, rect.width * dpr);
        canvas.height = Math.max(1, rect.height * dpr);
        redraw();
      }
      const ctx2d = canvas.getContext('2d');
      function redraw() {
        ctx2d.setTransform(1, 0, 0, 1, 0, 0);
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx2d.scale(dpr, dpr);
        for (const stroke of card.data.strokes) {
          ctx2d.strokeStyle = stroke.color;
          ctx2d.lineWidth = stroke.width;
          ctx2d.lineCap = 'round';
          ctx2d.lineJoin = 'round';
          ctx2d.beginPath();
          stroke.points.forEach((p, i) => {
            if (i === 0) ctx2d.moveTo(p.x, p.y);
            else ctx2d.lineTo(p.x, p.y);
          });
          ctx2d.stroke();
        }
      }
      new ResizeObserver(resizeCanvas).observe(canvas);

      let drawing = false;
      let current = null;
      canvas.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        drawing = true;
        canvas.setPointerCapture(e.pointerId);
        const rect = canvas.getBoundingClientRect();
        current = { color: colorInput.value, width: 2.5, points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }] };
        card.data.strokes.push(current);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        e.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        current.points.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        redraw();
      });
      const finish = () => {
        if (!drawing) return;
        drawing = false;
        ctx.saveData(card, { strokes: card.data.strokes, color: colorInput.value });
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointerleave', finish);
      clearBtn.addEventListener('click', () => {
        card.data.strokes = [];
        redraw();
        ctx.saveData(card, { strokes: [], color: colorInput.value });
      });
    },
  },
};

function makeFilePicker(accept, onFile) {
  const wrap = el('div', 'file-picker');
  const input = el('input', '', { type: 'file', accept });
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
  });
  const label = el('div', 'file-picker-label', { text: 'Click to upload' });
  wrap.append(label, input);
  return wrap;
}
