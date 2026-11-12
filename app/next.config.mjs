import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Normal dev/build: unchanged. Static GitHub Pages build: STATIC_EXPORT=1 (+ NEXT_PUBLIC_BASE_PATH=/near).
const staticExport = process.env.STATIC_EXPORT === '1';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  images: { unoptimized: true },
  ...(basePath ? { basePath } : {}),
  ...(staticExport ? { output: 'export', trailingSlash: true } : {}),
};
export default nextConfig;
