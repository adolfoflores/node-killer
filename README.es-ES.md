

# ⚡️ Node Killer

[![Electron](https://img.shields.io/badge/Electron-%5E38-blue?logo=electron)](https://www.electronjs.org/)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://developer.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

⚡️ **Node Killer** — una aplicación elegante para la barra de menús de macOS que supervisa tus servidores de desarrollo de **Node.js**, **Vite** y **Bun** y te permite detenerlos con un clic.

> 🖥️ Actualmente solo está disponible para Apple Silicon (arm64).

![Node Killer placeholder screenshot](assets/demo/node-killer-screenshot-0.2.0.png)

## ✨ Características
- 📊 **Contador en tiempo real** en la barra de estado: muestra instantáneamente cuántos servidores de desarrollo (Node.js, Vite, Bun) están escuchando (`active: 4`).  
- 🖱️ **Menú interactivo en la bandeja** — lista cada proceso activo con su tipo, PID y puertos cuando están disponibles.  
- 🔪 **Terminación con un clic** — finaliza procesos individuales de Node/Vite/Bun con notificaciones de éxito o error.  
- 💣 **Eliminar todos** — elimina todos los procesos en ejecución de los tipos habilitados, con confirmación y resumen.  
- 🔄 **Actualización automática inteligente** — se actualiza cada 5 segundos, además de contar con una opción manual de **Actualizar**.  
- 🧰 **Preferencias personalizables** — ajusta la frecuencia de actualización, el lanzamiento automático, el modo de visualización en la barra de estado y los tipos de procesos a supervisar.
- ✅ **Activación de tipos de proceso** — habilita o deshabilita la búsqueda de Node.js, Vite y Bun directamente desde las Preferencias.


## 🚀 Primeros pasos

Para desarrollo:

```bash
npm install
npm run dev
```

Node Killer reside en la barra de menús de macOS, cerca del reloj. 


## 📥 Descarga

Puedes descargar el binario precompilado más reciente desde la [página de lanzamientos](https://github.com/adolfoflores/node-killer/releases).

👉 Descarga directa para Apple Silicon (M1/M2/M3/M4):  
[Node-Killer-0.2.0-arm64.dmg](https://github.com/adolfoflores/node-killer/releases/download/v0.2.0/Node-Killer-0.2.0-arm64.dmg)

> 🖥️ Actualmente solo se proporcionan compilaciones para Apple Silicon (arm64).  
> macOS solicitará confirmación la primera vez que ejecutes la aplicación.  

## 🎥 Demostración

![Node Killer demo](assets/demo/node-killer-demo.gif)

## 📦 Compilación

Crea un paquete `.app` y `.dmg` con [electron-builder](https://www.electron.build/):

```bash
npm run build
```

Los artefactos se guardan en `dist/`. 


## ⚠️ Limitaciones
- Los procesos se detectan mediante el análisis de `lsof -nP -iTCP -sTCP:LISTEN`.
- Los contenedores (Docker) suelen aparecer como `docker-proxy`, por lo que los procesos de Node subyacentes pueden no ser visibles.

## 📸 Hoja de ruta
- [ ] Modo de escaneo alternativo para procesos de Node que no están escuchando en sockets.
- [ ] Soporte básico para Linux.


## 🧪 Prueba rápida manual
1. Inicia un servidor para cada entorno de ejecución que utilices (`next dev`, `vite dev`, `bun dev`, etc.).
2. Ejecuta `npm run dev` para Node Killer.
3. Confirma que el menú muestre cada proceso con la etiqueta correcta (node/vite/bun), los puertos y que deshabilitar un tipo en Preferencias oculte sus entradas.
4. Termina un solo proceso, luego prueba **Eliminar todos** y revisa las notificaciones.


## 🤝 Contribuir
¡Las solicitudes de extracción (pull requests) y los comentarios son bienvenidos! No dudes en abrir un issue.

## 📝 Licencia
[MIT](./LICENSE)
