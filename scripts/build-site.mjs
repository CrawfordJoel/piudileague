import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const siteDir = path.resolve('site');
const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn('WARNING: SUPABASE_URL or SUPABASE_ANON_KEY is missing. The site will render its static fallback data, but live archive widgets will be disabled.');
}

const config = `window.PIUDI_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: anonKey })};\n`;
fs.writeFileSync(path.join(siteDir, 'config.js'), config, 'utf8');
console.log(`Generated site/config.js (${url && anonKey ? 'live Supabase enabled' : 'fallback mode'}).`);
