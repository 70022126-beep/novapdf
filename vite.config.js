import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('pdfjs-dist')) return 'vendor-pdfjs'
          if (id.includes('tesseract.js')) return 'vendor-ocr'
          if (id.includes('/docx/') || id.includes('\\docx\\')) return 'vendor-docx'
          if (id.includes('/jszip/') || id.includes('\\jszip\\')) return 'vendor-zip'
          if (id.includes('pdf-lib')) return 'vendor-pdf-lib'
          return undefined
        },
      },
    },
  },
  server: {
    watch: {
      // Los benchmarks escriben DOCX/PDF/PNG dentro del proyecto. En Windows,
      // LibreOffice y Playwright pueden mantener esos binarios bloqueados unos
      // milisegundos; intentar vigilarlos provoca EBUSY y derriba Vite.
      ignored: ['**/.novapdf-*', '**/tmp/**', '**/benchmarks/**'],
    },
  },
})
