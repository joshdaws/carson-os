import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: resolve(__dirname, "tailwind.config.js") },
    autoprefixer: {},
  },
};
