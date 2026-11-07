import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  server: { host: "0.0.0.0", port: 3000, strictPort: true, allowedHosts: true },
});
