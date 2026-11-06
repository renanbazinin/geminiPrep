import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApp } from "./app.js";
import { createServerLargeFiles, describeLargeFilesEngine } from "./documents/config.js";

const largeFiles = createServerLargeFiles();
const app = createApp({ largeFiles });
console.log(`Large files: ${describeLargeFilesEngine(largeFiles.engine)} (LARGE_FILES_ENGINE=${largeFiles.engine})`);
// Expired uploads are also skipped on read; sweeping just reclaims the disk space.
const sweep = () => void largeFiles.files.sweep().catch((error) => console.warn("Large-file cleanup failed:", error));
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
