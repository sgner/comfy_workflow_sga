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
      // This runs after bundle is written
      console.log("Bundle complete, copying locales...");
    }
  };
};

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    rewriteComfyImports({ isDev: mode === "development" }),
    copyLocales()
  ],
  publicDir: "public", // Explicitly set public directory
  build: {
    emptyOutDir: true,
    rollupOptions: {
      // Don't bundle ComfyUI scripts - they will be loaded from the ComfyUI server
      external: ['/scripts/app.js', '/scripts/api.js'],
      input: {
        main: path.resolve(__dirname, 'src/main.tsx'),
      },
      output: {
        // Output to the web directory
        dir: '../web',
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        // FIX: Force CSS to be named style.css
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'style.css';
          }
          return '[name][extname]';
        },
        // Split React into a separate vendor chunk for better caching
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
