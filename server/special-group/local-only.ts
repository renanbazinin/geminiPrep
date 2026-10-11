import type { NextFunction, Request, Response } from "express";

// This app stores a Jira token on the local server, so its API answers only this computer.
// Same rules as the /jira space: loopback socket, localhost Host header, local dev origins.

const LOCAL_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const DEV_PORTS = ["5173", "5174", "3001"];

export function localOnly(req: Request, res: Response, next: NextFunction) {
  if (!LOCAL_ADDRESSES.includes(req.socket.remoteAddress ?? "")) {
    res.status(403).json({ error: "The Special Group app only answers this computer." }); return;
  }
  try {
    if (!LOCAL_HOSTS.includes(new URL(`http://${req.headers.host}`).hostname)) throw new Error();
  } catch { res.status(403).json({ error: "Open the app through localhost." }); return; }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      const local = LOCAL_HOSTS.includes(url.hostname);
      if (!local || !(url.host === req.headers.host || DEV_PORTS.includes(url.port))) throw new Error();
    } catch { res.status(403).json({ error: "This origin can't use the Special Group app." }); return; }
  }
  if (req.method === "POST" && !req.is("application/json")) { res.status(415).json({ error: "JSON is required." }); return; }
  next();
}
