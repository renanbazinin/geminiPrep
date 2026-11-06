import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApp } from "./app.js";
import { createServerLargeFiles } from "./documents/config.js";

// K_SERVICE is set on Cloud Run: never serve the app publicly without its password.
if (process.env.K_SERVICE && !process.env.APP_PASSWORD?.trim()) {
  console.error("APP_PASSWORD is required when running on Cloud Run. Refusing to start.");
  process.exit(1);
}

const largeFiles = createServerLargeFiles();
const app = createApp({ largeFiles });
// Expired uploads are also skipped on read; sweeping just reclaims the disk space.
const sweep = () => void largeFiles.sweep().catch((error) => console.warn("Large-file cleanup failed:", error));
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();
const distPath = path.resolve(process.cwd(), "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/docs")) {
      next();
      return;
    }
    res.sendFile(path.join(distPath, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

const port = Number(process.env.PORT) || 3001;
app.listen(port, "0.0.0.0", () => {
  console.log(`Gemini Prep is ready on http://127.0.0.1:${port}`);
});
