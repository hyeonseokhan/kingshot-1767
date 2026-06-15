/**
 * 빌드 타임 전용 Supabase 클라이언트 (service_role).
 * Astro frontmatter(---) 또는 서버 API 에서만 import 할 것.
 * 클라이언트 <script> 에서 import 하면 키가 번들에 노출됨 — 절대 금지.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL as string;
const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!url || !serviceKey) {
  throw new Error(
    'PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 환경변수가 설정되지 않았습니다.',
  );
}

export const supabaseServer: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
