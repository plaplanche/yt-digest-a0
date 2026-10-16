/** Escapes a value for HTML text and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** An HTML page; `body` is HTML already, `title` is escaped here. */
export function htmlPage(status: number, title: string, body: string): Response {
  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
${body}
</body></html>`;
  return new Response(page, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** A 400 HTML error page, for errors that must never redirect. */
export function htmlError(message: string): Response {
  return htmlPage(400, "Authorization error", `<h1>Authorization error</h1>\n<p>${escapeHtml(message)}</p>`);
}
