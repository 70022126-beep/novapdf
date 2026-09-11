# Prioridad 4 — Producto instalable

Fecha: 2026-09-09  
Versión del servicio: 1.17.0

## Alcance implementado

- Instalación por usuario en `%LOCALAPPDATA%\NovaPDF\Vision`, sin administrador.
- Entornos separados para PaddleOCR y `pdf2docx`; sus versiones incompatibles de
  NumPy/OpenCV no comparten proceso.
- Supervisor de instancia única, arranque oculto, comprobación de salud,
  recuperación automática y límite de reinicios.
- Descarga oficial de los 15 modelos requeridos y manifiesto local por archivo
  con tamaño y SHA-256.
- Selección `auto`, `gpu:0` o `cpu`; `auto` comprueba NVIDIA y la carga neuronal
  cae a CPU si la inicialización GPU falla.
- Sesiones efímeras para `/v1/*`, con negociación exclusiva desde orígenes
  loopback y renovación automática del cliente ante `401`.
- Fragmentos Vite independientes para la ruta PDF a Word, PDF.js, OCR, DOCX,
  JSZip y PDF-Lib, con límites de tamaño automatizados.
- Playwright E2E sobre Chrome/Edge del sistema: seguridad de API, selección OCR,
  conversión descargable y recuperación IndexedDB tras recarga.

## Comandos de aceptación

```powershell
npm run lint
npm test
npm run vision:test
npm run bundle:check
npm run test:e2e
powershell.exe -NoProfile -ExecutionPolicy Bypass -File services/vision/install.ps1 -WhatIf
```

## Límites deliberados

- El instalador contiene un wheel GPU validado para Python 3.12/CUDA 12.9. Si no
  es compatible o no hay NVIDIA, instala el runtime CPU y deja la causa visible
  en `/health`.
- El manifiesto verifica integridad local después de descargar; no sustituye la
  firma Authenticode de un instalador MSI. El empaquetado MSI firmado sigue siendo
  trabajo de distribución, no del motor.
- `-SkipModels` permite preparar el servicio sin conexión, pero el OCR neuronal no
  estará listo hasta ejecutar `model_manager.py download`.
- Playwright cubre el flujo funcional mínimo. El benchmark de calidad con PDFs
  reales continúa en `benchmark:e2e`, que mide texto, paginación y similitud visual.

## Criterio de cierre

La prioridad se considera técnicamente terminada cuando todos los comandos de
aceptación pasan, el manifiesto real de modelos verifica y `/health` 1.17.0
informa autenticación, dispositivo y `pdf2docx` aislado. Firmar y publicar un MSI
queda condicionado a disponer de certificado y canal de distribución.
