import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app talks to a backend gateway (LiteLLM proxy + app server) in production.
// In dev we proxy /api to a local backend if one is running; otherwise the
// mock chat service in src/services handles requests so the UI works standalone.
export default defineConfig({
  plugins: [react()],
  server: {
    // Aligned with the Google OAuth client (configured for localhost:3000).
    // Add http://localhost:3000 to the client's Authorized JavaScript origins.
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
