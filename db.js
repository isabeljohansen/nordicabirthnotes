// Supabase-backed storage: boards, cards, blobs (files/images/audio/documents).
// Same `db` interface the app already used for IndexedDB, so app.js and
// cardTypes.js didn't need to change — only this file talks to the network.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BLOBS_BUCKET = 'blobs';

function boardToRow(board) {
  return { id: board.id, name: board.name, created_at: new Date(board.createdAt).toISOString(), view: board.view ?? null };
}
function rowToBoard(row) {
  return { id: row.id, name: row.name, createdAt: new Date(row.created_at).getTime(), view: row.view };
}
function cardToRow(card) {
  return {
    id: card.id,
    board_id: card.boardId,
    type: card.type,
    x: card.x,
    y: card.y,
    w: card.w,
    h: card.h,
    z_index: card.zIndex,
    data: card.data,
    created_at: new Date(card.createdAt).toISOString(),
  };
}
function rowToCard(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    type: row.type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    zIndex: row.z_index,
    data: row.data,
    createdAt: new Date(row.created_at).getTime(),
  };
}

function check(error) {
  if (error) throw error;
}

async function currentUserId() {
  const { data, error } = await client.auth.getUser();
  check(error);
  if (!data.user) throw new Error('Not signed in');
  return data.user.id;
}

export const db = {
  // Boards
  async getAllBoards() {
    const { data, error } = await client.from('boards').select('*');
    check(error);
    return data.map(rowToBoard);
  },
  async putBoard(board) {
    const { error } = await client.from('boards').upsert(boardToRow(board));
    check(error);
  },
  async deleteBoard(id) {
    const { error } = await client.from('boards').delete().eq('id', id);
    check(error);
  },

  // Cards
  async getCardsByBoard(boardId) {
    const { data, error } = await client.from('cards').select('*').eq('board_id', boardId);
    check(error);
    return data.map(rowToCard);
  },
  async putCard(card) {
    const { error } = await client.from('cards').upsert(cardToRow(card));
    check(error);
  },
  async deleteCard(id) {
    const { error } = await client.from('cards').delete().eq('id', id);
    check(error);
  },

  // Blobs (files) — stored in Supabase Storage under <userId>/<blobId>, a
  // private bucket only your own account can read or write (enforced by
  // storage policies, not just app-level checks).
  async putBlob(id, blob, meta = {}) {
    const uidPrefix = await currentUserId();
    const { error } = await client.storage
      .from(BLOBS_BUCKET)
      .upload(`${uidPrefix}/${id}`, blob, { contentType: meta.mimeType || blob.type, upsert: true });
    check(error);
  },
  async getBlob(id) {
    const uidPrefix = await currentUserId();
    const { data, error } = await client.storage.from(BLOBS_BUCKET).download(`${uidPrefix}/${id}`);
    if (error) return null;
    return { id, blob: data };
  },
  async deleteBlob(id) {
    const uidPrefix = await currentUserId();
    const { error } = await client.storage.from(BLOBS_BUCKET).remove([`${uidPrefix}/${id}`]);
    check(error);
  },
};

export const auth = {
  async getSession() {
    const { data, error } = await client.auth.getSession();
    check(error);
    return data.session;
  },
  async signIn(email, password) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    check(error);
  },
  async signOut() {
    await client.auth.signOut();
  },
};

export function uid() {
  return crypto.randomUUID();
}
