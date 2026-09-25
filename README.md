# Nordica Birth

A personal, Milanote-style board for organizing midwifery resources, client education
materials, and links — freeform boards with draggable cards. Your data lives in
Supabase (a hosted database + file storage + login), so the same boards show up on
every device you log into.

## One-time setup (already mostly done)

1. **Supabase project** — create one at [supabase.com](https://supabase.com).
2. **Database + storage** — open the SQL Editor in your Supabase project, paste in
   the contents of [`schema.sql`](schema.sql), and run it. This creates the tables
   for your boards/cards and a private file storage bucket for images/PDFs/audio,
   all locked to your account only.
3. **Your login** — in **Authentication → Users**, add one user with your email and
   a password. That's what you'll log in with.
4. **Connect the app** — in **Project Settings → API**, copy the *Project URL* and
   the *anon public* key into [`config.js`](config.js), replacing the two
   placeholder values there.

## Hosting it (GitHub Pages)

1. Create a **public** GitHub repository (required for free Pages hosting).
2. Upload every file in this folder to it (drag-and-drop works fine via GitHub's
   web UI — Add file → Upload files).
3. In the repo, go to **Settings → Pages**, set "Deploy from branch" → `main` →
   `/ (root)`, save.
4. GitHub gives you a URL like `https://yourname.github.io/repo-name/` — that's
   your app, reachable from any device. Bookmark it.

Whenever the app's files change, just re-upload the changed ones the same way.

## Running it locally (for testing changes)

```bash
python3 serve.py
```

Then open **http://localhost:5173**. (`serve.py` disables browser caching, so edits
to these files always show up on refresh instead of a stale copy.) Or double-click
**`run.command`**, which does the same thing and opens the browser for you.

## What's in it

- **Boards** — create as many as you like from the sidebar (e.g. "Prenatal Education,"
  "Client Handouts"). Each one remembers its own pan/zoom position.
  Drag a board up or down the list to rearrange them, and double-click a board's name
  to rename it. (The big title at the top of a board can be edited too.) The order is
  saved with your boards, so it's the same on every device.
  - **Sub-boards** — hover a board and click **+** to add a sub-board inside it (e.g.
    "Information" → "Breastfeeding"). Or drag any board onto the middle of another board
    to nest it; drag a sub-board out to the left (below the last sub-board) to make it
    top-level again. Click the small arrow to fold a group up. Sub-boards go one level
    deep. Deleting a parent board keeps its sub-boards and makes them top-level.
    This needs a one-time database update: run the last block of `schema.sql`
    (the `parent_id` lines) in Supabase's SQL Editor.
- **Cards** — add from the toolbar: Notepad, Comment, Checklist, Link, Table, Color
  swatch, Image, Document, Audio, YouTube/Vimeo Video, and Drawing.
  - Cards have no banner. Click one and drag from anywhere that isn't a control
    (a button, field, link, checkbox or the audio player) to move it. On a video or
    drawing, the first click selects it (so you can drag it); once selected, the next
    click plays the video or draws.
  - Text works in two steps: the first click selects the card, and clicking its text
    again starts editing. A card you just added from the toolbar is ready to type in.
  - **Delete a selected card with the Delete (or Backspace) key.** A "Deleted - Undo" bar
    appears for a few seconds; press Cmd+Z (Ctrl+Z on Windows) or click Undo to get it
    back. If you're in the middle of typing in a card, Delete edits the text instead:
    press Escape first to stop editing, then Delete. There's also a small trash button
    on the corner of the selected card for when there's no keyboard (e.g. a phone).
  - Resize from the bottom-right corner where available.
  - Delete a board with the × next to its name in the sidebar (click once to arm it,
    again to confirm).
  - Dragging and resizing only respond to a plain left-click. Right-click and Ctrl+click
    are ignored, and a drag always ends when the mouse button comes up (or the next time
    the mouse moves with no button held), so nothing can stay "stuck" to the cursor.
  - Drop files from Finder or another app straight onto the board (images, audio
    and PDFs/documents each become the matching card).
  - Copy something and press Cmd+V (Ctrl+V on Windows) on the board: a copied
    image or screenshot becomes an image card, a link becomes a link card (YouTube
    and Vimeo links become video cards), and any other text becomes a notepad. It
    lands where your cursor is. Pasting inside a note or comment just pastes text
    there, as usual.
- **Canvas** — drag the background to pan; scroll to pan, or Ctrl/Cmd+scroll (or
  pinch) to zoom. Use the +/− controls or "Reset" in the header too.
- **Storage** — your boards, cards, and uploaded files live in Supabase, gated by
  Row Level Security so only your logged-in account can ever read or write them.

## Note on the free tier

Supabase's free tier pauses a project after 7 days with no activity — the app will
just show a connection error until you wake it back up with one click in the
Supabase dashboard. Nothing is lost, it just needs a nudge if you haven't opened
the board in a while.
