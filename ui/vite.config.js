import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin to correctly handle the ComfyUI scripts in development mode
const rewriteComfyImports = ({ isDev }) => {
  return {
    name: "rewrite-comfy-imports",
    resolveId(source) {
      if (!isDev) {
        return;
      }
      if (source === "/scripts/app.js") {
        return "http://127.0.0.1:8188/scripts/app.js";
      }
      if (source === "/scripts/api.js") {
        return "http://127.0.0.1:8188/scripts/api.js";
      }
      return null;
    },
  };
};

// Plugin to copy locales to the output directory
const copyLocales = () => {
  return {
    name: "copy-locales",
    writeBundle() {
      console.log("Bundle complete.");
    }
  };
};

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    rewriteComfyImports({ isDev: mode === "development" }),
    copyLocales()
  ],
  publicDir: "public",
  build: {
    // Output directly to ../web to match __init__.py expectations
    outDir: '../web',
    emptyOutDir: true,
    rollupOptions: {
      external: ['/scripts/app.js', '/scripts/api.js'],
      input: {
        main: path.resolve(__dirname, 'src/main.tsx'),
      },
      output: {
        // Flat structure: web/main.js
        entryFileNames: 'main.js',
        chunkFileNames: '[name]-[hash].js',
        // Flat structure: web/style.css
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'style.css';
          }
          return 'assets/[name]-[hash][extname]';
        },
        manualChunks: {
          'vendor': ['react', 'react-dom'],
        }
      }
    }
  },
  define: {
    'process.env': {}
  }
}));
