// The mocks server of spec/lot-2.md section 5.3: SponsorBlock for now, Google (OIDC) comes later.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.MOCKS_PORT ?? "8789");

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/health") {
    send(res, 200, "application/json", JSON.stringify({ status: "ok" }));
  } else if (req.method === "GET" && path === "/sponsorblock/api/skipSegments") {
    send(res, 404, "text/plain", "Not Found");
  } else {
    send(res, 404, "text/plain", "Not Found");
  }
}

createServer(handle).listen(port, "127.0.0.1", () => {
  console.log(`mocks: listening on http://127.0.0.1:${port}`);
});
