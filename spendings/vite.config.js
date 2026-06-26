import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const RULES_FILE = path.resolve(process.cwd(), "category-rules.json");

// Dev endpoint so the browser can persist categorization rules to a dedicated file.
// GET  /__rules  -> current rules JSON
// POST /__rules  -> overwrite the file with the posted JSON
function rulesApi() {
  return {
    name: "category-rules-api",
    configureServer(server) {
      server.middlewares.use("/__rules", (req, res) => {
        if (req.method === "GET") {
          let data = '{"provider":{},"txn":{}}';
          try { data = fs.readFileSync(RULES_FILE, "utf8") || data; } catch {}
          res.setHeader("Content-Type", "application/json");
          res.end(data);
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const parsed = JSON.parse(body); // validate before writing
              fs.writeFileSync(RULES_FILE, JSON.stringify(parsed, null, 2) + "\n");
              res.setHeader("Content-Type", "application/json");
              res.end('{"ok":true}');
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(e) }));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), rulesApi()],
  server: { port: 5173, open: true },
});
