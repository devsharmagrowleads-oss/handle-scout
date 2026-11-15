import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The app lives in a workspace; point Next at the monorepo root so it can follow
// the symlink to packages/core.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read API keys from the .env at the repository root, so the CLI and the web app share
// one file. Next also reads apps/web/.env.local as usual. These stay on the server.
const rootEnv = path.join(root, '.env');
if (existsSync(rootEnv) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    /* an unreadable .env is the same as none */
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
