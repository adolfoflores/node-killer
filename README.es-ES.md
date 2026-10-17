# ⚡️ Node Killer

[![Electron](https://img.shields.io/badge/Electron-%5E38-blue?logo=electron)](https://www.electronjs.org/)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://developer.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

⚡️ **Node Killer** — una aplicación elegante para la barra de menús de macOS que supervisa tus servidores de desarrollo de **Node.js**, **Vite** y **Bun** y te permite detenerlos con un clic.

> 🖥️ Actualmente solo está disponible para Apple Silicon (arm64).

![Menú y ventana de Preferencias de Node Killer](assets/demo/node-killer-menu.png)

## ✨ Características
- 📊 **Contador en tiempo real** en la barra de estado: muestra cuántos servidores de desarrollo (Node.js, Vite, Bun) están escuchando (`active: 4`), con la opción de mostrar también su memoria o CPU total (`⚡️ 4 · 1.4 GB`).  
- 🖱️ **Menú interactivo en la bandeja** — lista cada servidor de desarrollo ordenado por proyecto (repo de git o worktree), con sus puertos, comando, CPU, memoria y tiempo en ejecución (`my-app › feature-x · vite :5173 — vite dev · 3% · 120 MB · 2h`). La memoria coincide con el Monitor de Actividad.  
- 🔪 **Terminación con un clic** — detiene un servidor de desarrollo junto con la herramienta que lo inició (npm, next dev, …) y sus workers, como Ctrl-C, con notificaciones de éxito o error.  
- 💣 **Eliminar todos** — detiene todos los servidores de la lista a la vez, con confirmación y resumen.  
- 🔄 **Actualización automática** — cada 5 segundos por defecto (1 s, 10 s o en pausa), además de la opción manual **Actualizar**.  
- 🧰 **Preferencias** — frecuencia de actualización, inicio al iniciar sesión, modo de visualización en la barra de estado, procesos de todos los usuarios y qué tipos de procesos supervisar (Node.js, Vite, Bun).


## 🚀 Primeros pasos

Para desarrollo:

```bash
npm install
npm run dev
```

Node Killer reside en la barra de menús de macOS, cerca del reloj. 


## 📥 Descarga

Puedes descargar el binario precompilado más reciente desde la [página de lanzamientos](https://github.com/adolfoflores/node-killer/releases).

👉 Descarga para Apple Silicon (M1/M2/M3/M4):  
[Última versión](https://github.com/adolfoflores/node-killer/releases/latest) (descarga el `.dmg`)

> 🖥️ Actualmente solo se proporcionan compilaciones para Apple Silicon (arm64).  
> La app no está notarizada, así que macOS bloquea el primer arranque: abre **Configuración del Sistema → Privacidad y seguridad** y haz clic en **Abrir de todos modos**.  

## 📦 Compilación

Crea un paquete `.app` y `.dmg` con [electron-builder](https://www.electron.build/):

```bash
npm run build
```

Los artefactos se guardan en `dist/`. 

Para compilarla e instalarla directamente en `/Applications` (una compilación local se abre sin el aviso de Gatekeeper):

```bash
npm run install:local
```


## ⚠️ Limitaciones
- Solo se muestran los procesos que escuchan en un puerto TCP (detectados con `lsof -nP -iTCP -sTCP:LISTEN`); los scripts, watchers o ejecutores de tests sin puerto no aparecen.
- Los servidores que corren dentro de contenedores de Docker no se muestran: en la Mac aparecen como procesos del propio Docker, no como `node`.
- La terminación tipo Ctrl-C reconoce las herramientas de desarrollo más comunes (npm, npx, pnpm, yarn, bun run, next, nuxt, astro, remix, vite, nodemon, tsx). Con otras, como `turbo` o `concurrently`, solo se detienen el servidor y sus workers, y la herramienta puede volver a iniciarlo.

## 📸 Hoja de ruta
- [x] Soporte para Vite y Bun
- [x] Puertos, comando, CPU, memoria y tiempo en ejecución de cada servidor
- [x] Totales de memoria y CPU en la barra de estado
- [x] Terminación tipo Ctrl-C (detiene la herramienta que inició el servidor)
- [x] Nombre del proyecto y del worktree de git en el menú
- [ ] Soporte básico para Linux


## 🧪 Prueba rápida manual
1. Inicia un servidor para cada entorno de ejecución que utilices (`next dev`, `vite dev`, `bun dev`, etc.).
2. Ejecuta `npm run dev` para Node Killer.
3. Confirma que el menú muestre cada proceso con su proyecto, la etiqueta correcta (node/vite/bun) y los puertos, y que deshabilitar un tipo en Preferencias oculte sus entradas.
4. Termina un servidor iniciado con `npm run dev`: todo el comando debe detenerse y su terminal volver al prompt. Luego prueba **Eliminar todos** y revisa las notificaciones.


## 🤝 Contribuir
¡Las solicitudes de extracción (pull requests) y los comentarios son bienvenidos! No dudes en abrir un issue. Ejecuta `npm test` antes de abrir un PR.

## 📝 Licencia
[MIT](./LICENSE)
