import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApp } from "./app.js";

const app = createApp();
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
