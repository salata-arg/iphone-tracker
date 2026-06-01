# 📱 iPhone Tracker — Arbitraje Argentina

App para encontrar iPhones baratos en MercadoLibre y Facebook Marketplace.

## Estructura del proyecto

```
iphone-tracker/
├── api/
│   └── meli.js        ← Proxy para MercadoLibre (Vercel Serverless)
├── src/
│   ├── main.jsx
│   └── App.jsx        ← App principal
├── index.html
├── package.json
├── vite.config.js
└── vercel.json
```

## Setup local

```bash
npm install
npm run dev
```

## Deploy en Vercel

1. Subí esta carpeta a un repositorio de GitHub
2. Importá el repo en vercel.com
3. Vercel detecta Vite automáticamente → Deploy

## Configuración

En `src/App.jsx` podés cambiar:

```js
const ARS_TO_USD = 1 / 1500;  // Tipo de cambio actual
```

## Actualizar el tipo de cambio

Editá `ARS_TO_USD` en `src/App.jsx`, hacé commit y push → Vercel re-despliega automáticamente.
