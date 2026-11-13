import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = process.env.RIBBHU_GATEWAY ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: gateway },
      "/ws": { target: gateway.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
