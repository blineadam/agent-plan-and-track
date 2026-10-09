# Uploading the final crops (step 5, items 2 and 3)

Read this before uploading the settled-head crops and editing the PR body.

Upload through the installed browser MCP on the draft PR page:

- Upload the final before/after crops through the comment form's "Paste, drop, or click to add files"
  button: the real file input is hidden, so the upload tool needs the visible button.
- The MCP only accepts files inside its workspace roots, so stage the crops under the project first
  (a gitignored scratch directory).
- Wait until the comment editor holds one `<img>` per file with a `user-attachments` URL and no
  "Uploading" placeholder.

Then, for the body edit in item 3:

- Copy the generated image markup before clearing the comment editor (never post it).
- Lay the images out as two-column Before/After tables.
- Give paired images descriptive alt text and the same displayed dimensions: GitHub fills
  `width`/`height` with device pixels, so a scale-2 crop needs them halved to the CSS size.
