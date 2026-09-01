#!/usr/bin/env node
// Convierte el SVG del logo institucional en src/cert/logoUa.ts (trazados para pdf-lib).
//
// Por qué trazados y no una imagen: el logo es MONOCROMO (un solo azul #273473) y pdf-lib no
// incrusta SVG. Guardarlo como vector lo deja nítido a cualquier zoom o impresión, sin meter un
// binario al repositorio ni una dependencia de conversión en el build.
//
//   node scripts/extraer-logo.mjs <ruta-al-svg>
//
// Requisito del SVG: un solo color, texto ya convertido a curvas (sin <text>), sin <image>.
import fs from 'node:fs';

const entrada = process.argv[2];
if (!entrada) {
  console.error('Uso: node scripts/extraer-logo.mjs <ruta-al-svg>');
  process.exit(1);
}
const svg = fs.readFileSync(entrada, 'utf8');

const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
if (!vb) throw new Error('El SVG no declara un viewBox que empiece en 0 0; revísalo a mano.');
const [, ancho, alto] = vb;

if (/<text\b/.test(svg)) throw new Error('El SVG trae <text>: conviértelo a curvas antes (el PDF no tendrá esa tipografía).');
if (/<image\b/.test(svg)) throw new Error('El SVG trae <image>: este extractor solo maneja vectores.');

const colores = [...new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{3,8})"/g)].map((m) => m[1]))];
if (colores.length !== 1) throw new Error(`Se esperaba un solo color y hay ${colores.length}: ${colores.join(', ')}`);
const hex = colores[0].replace('#', '');
const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

const rellenos = [];
const trazos = [];
for (const [, attrs] of svg.matchAll(/<path\b([^>]*?)\/?>/g)) {
  const d = attrs.match(/\bd="([^"]+)"/)?.[1];
  if (!d) continue;
  if (/\bstroke="#/.test(attrs)) {
    trazos.push({ d, grosor: Number(attrs.match(/stroke-width="([\d.]+)"/)?.[1] ?? 1) });
  } else {
    rellenos.push(d);
  }
}

const salida = `import { rgb } from 'pdf-lib';

// GENERADO por scripts/extraer-logo.mjs — no editar a mano.
// Logo institucional de Postgrados de la Universidad Autónoma de Chile, como trazados vectoriales
// (pdf-lib no incrusta SVG). Ver el script para el porqué y para regenerarlo.

export const LOGO_ANCHO = ${ancho};
export const LOGO_ALTO = ${alto};
/** Azul institucional ${colores[0]}. */
export const LOGO_COLOR = rgb(${r.toFixed(6)}, ${g.toFixed(6)}, ${b.toFixed(6)});

/** Trazados rellenos (letras y escudo, ya convertidos a curvas). */
export const LOGO_RELLENOS: string[] = ${JSON.stringify(rellenos, null, 2)};

/** Trazados con contorno: la línea divisoria vertical. */
export const LOGO_TRAZOS: { d: string; grosor: number }[] = ${JSON.stringify(trazos, null, 2)};
`;
fs.writeFileSync('src/cert/logoUa.ts', salida);
console.log(`src/cert/logoUa.ts: ${rellenos.length} rellenos, ${trazos.length} trazos, color ${colores[0]}`);
