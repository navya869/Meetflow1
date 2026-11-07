import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const apiPort = Number(process.env.PORT || 8000);
const frontendPort = Number(process.env.VITE_PORT || 5173);

export default defineConfig({
  root: fileURLToPath(new URL("./client/", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: frontendPort,
    strictPort: false,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}` },
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      "/static": { target: `http://127.0.0.1:${apiPort}` },
      "/meetings": { target: `http://127.0.0.1:${apiPort}` }
    }
  }
});
