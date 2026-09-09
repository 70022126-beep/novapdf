# Prioridad 3 — Escalabilidad v1

## Implementado

- Checkpoint por página en IndexedDB con PDF de origen, opciones, progreso y estado.
- Recuperación visible de sesiones interrumpidas o listas después de reiniciar la aplicación.
- Registro local del PDF por SHA-256 en SQLite/disco. Los lotes nativos y fondos posteriores usan `document_id`; no vuelven a enviar el PDF.
- Evicción por TTL y presupuesto de disco del registro Python.
- Colas acotadas independientes para OCR y fondos, con back-pressure HTTP 429, timeout HTTP 504 y métricas en `/health`.
- Pool OCR configurable; el valor seguro predeterminado para GPU es un worker y cuatro trabajos pendientes.
- Presupuesto adaptativo del navegador según RAM/heap y límites explícitos de RAM/VRAM del servicio.
- Liberación de imágenes y fuentes del modelo después de empaquetar el DOCX definitivo.
- Benchmark reproducible de 100, 400 y 1.000 páginas con historial JSON.

## Variables operativas

| Variable | Predeterminado | Propósito |
| --- | ---: | --- |
| `NOVAPDF_OCR_WORKERS` | 1 | Inferencias PaddleOCR simultáneas |
| `NOVAPDF_OCR_QUEUE_SIZE` | 4 | Espera máxima de trabajos OCR |
| `NOVAPDF_BACKGROUND_WORKERS` | 2 | Fondos limpios simultáneos |
| `NOVAPDF_BACKGROUND_QUEUE_SIZE` | 8 | Espera máxima de fondos |
| `NOVAPDF_DOCUMENT_STORE_BYTES` | 2 GB | Caché local de PDF registrados |
| `NOVAPDF_DOCUMENT_TTL_SECONDS` | 24 h | Vida de cada PDF registrado |
| `NOVAPDF_RAM_BUDGET_MB` | 4096 MB | Tope del servicio, limitado al 55% de RAM física |
| `NOVAPDF_VRAM_BUDGET_MB` | 4096 MB | Tope VRAM, limitado al 70% de VRAM detectada |

## Validación

Ejecutar `npm run benchmark:scalability`. El resultado vigente está en
`benchmarks/scalability/latest.json` y cada ejecución queda en
`benchmarks/scalability/history/`.

La prueba actual verifica empaquetado y paginación con páginas sintéticas editables. No sustituye una prueba OCR real de 1.000 escaneos: esa validación requiere completar y verificar humanamente el corpus de Prioridad 2 y debe ejecutarse como prueba prolongada separada.

También se ejecutó un smoke test desde Chrome con el FENCYT real: la página 2
generó un DOCX, confirmó subida única por `document_id` y guardó un checkpoint.
En una segunda ejecución se cerró la pestaña después de 3/62 páginas; al volver
a abrir NovaPDF apareció la sesión, recuperó el nombre del PDF, el rango 1-62 y
el avance. El registro está en `benchmarks/scalability/real-smoke-2026-09-08.json`.
