import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function adminClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export function isoFromMs(value) {
  if (!value) return null;
  return new Date(Number(value)).toISOString();
}

export function score(settings, wholeKey, decimalKey) {
  const whole = Number(settings?.[wholeKey] ?? 0);
  const decimal = Number(settings?.[decimalKey] ?? 0);
  return Number((whole + decimal / 100).toFixed(2));
}

export async function upsertChunked(client, table, rows, { onConflict, chunkSize = 100, maxRetries = 4 } = {}) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const options = onConflict ? { onConflict } : undefined;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { error } = await client.from(table).upsert(chunk, options);
        if (!error) {
          console.log(`${table}: ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
          lastError = null;
          break;
        }
        lastError = error;
      } catch (error) {
        lastError = error;
      }

      if (attempt < maxRetries) {
        const delayMs = 1000 * attempt;
        console.log(`${table}: batch failed, retry ${attempt}/${maxRetries} in ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (lastError) {
      throw new Error(`${table} upsert failed after ${maxRetries} attempts: ${lastError.message ?? lastError}`);
    }
  }
}

export async function replaceAssets(client, transactionIds, rows) {
  if (transactionIds.length) {
    for (let i = 0; i < transactionIds.length; i += 100) {
      const ids = transactionIds.slice(i, i + 100);
      const { error } = await client.from('transaction_assets').delete().in('transaction_id', ids);
      if (error) throw new Error(`transaction_assets delete failed: ${error.message}`);
    }
  }
  if (rows.length) {
    await upsertChunked(client, 'transaction_assets', rows, { chunkSize: 100, maxRetries: 4 });
  }
}

export function collectPlayerIds(seasonData) {
  const ids = new Set();
  for (const roster of seasonData.rosters ?? []) {
    for (const field of ['players', 'starters', 'reserve', 'taxi']) {
      for (const id of roster[field] ?? []) if (id) ids.add(String(id));
    }
  }
  for (const week of Object.values(seasonData.matchups_by_week ?? {})) {
    for (const matchup of week ?? []) {
      for (const id of matchup.players ?? []) if (id) ids.add(String(id));
      for (const id of matchup.starters ?? []) if (id) ids.add(String(id));
      for (const id of Object.keys(matchup.players_points ?? {})) if (id) ids.add(String(id));
    }
  }
  for (const week of Object.values(seasonData.transactions_by_week ?? {})) {
    for (const tx of week ?? []) {
      for (const id of Object.keys(tx.adds ?? {})) ids.add(String(id));
      for (const id of Object.keys(tx.drops ?? {})) ids.add(String(id));
    }
  }
  for (const draft of seasonData.drafts ?? []) {
    for (const pick of draft.picks ?? []) if (pick.player_id) ids.add(String(pick.player_id));
  }
  return ids;
}
