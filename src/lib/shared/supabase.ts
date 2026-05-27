import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다. .env 또는 GitHub Actions secrets 확인.',
  );
}

export const supabase: SupabaseClient = createClient(url, anonKey);
export const SUPABASE_URL = url;
export const SUPABASE_ANON_KEY = anonKey;
