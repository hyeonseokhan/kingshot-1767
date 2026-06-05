import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다. .env 또는 GitHub Actions secrets 확인.',
  );
}

// SSR(Node) 환경에서는 native WebSocket 미존재 — @supabase/realtime-js 가 throw.
// Node 22+ 부터 native WebSocket 지원되므로 그 전까지 `ws` 패키지를 transport 로 주입.
// 브라우저에서는 native WebSocket 그대로 사용 (ws import 안 됨).
const isServer = typeof window === 'undefined';
const realtimeOptions = isServer
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { transport: (await import('ws')).default as any }
  : undefined;

export const supabase: SupabaseClient = createClient(url, anonKey, {
  realtime: realtimeOptions,
});
export const SUPABASE_URL = url;
export const SUPABASE_ANON_KEY = anonKey;
