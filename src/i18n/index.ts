// i18n 런타임 — KOR/ENG 토글 + 일괄 swap.
// SSR 은 항상 한국어로 렌더, 클라이언트 boot 가 detect 해서 'en' 이면 즉시 applyTranslations() 로 swap.
// 첫 페인트 ~50ms 동안 영문 사용자에게 한글이 노출될 수 있으나 수용 범위.

import { ko } from './ko';
import { en } from './en';

const STORAGE_KEY = 'pnx-lang';
const dictionaries = { ko, en } as const;
export type Lang = keyof typeof dictionaries;

let current: Lang = 'ko';
const listeners = new Set<(lang: Lang) => void>();

/** localStorage → navigator.language 순으로 결정. SSR 안전 (window 없으면 'ko'). */
export function detectLang(): Lang {
  if (typeof window === 'undefined') return 'ko';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'ko' || saved === 'en') return saved;
  return window.navigator.language?.startsWith('ko') ? 'ko' : 'en';
}

export function getLang(): Lang {
  return current;
}

/** 언어 변경 + persistence + <html lang> 갱신 + 등록된 listener 호출 + DOM 일괄 swap. */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    applyTranslations();
  }
  listeners.forEach((fn) => fn(lang));
}

/** 동적 마운트 컴포넌트가 자체 텍스트 갱신할 때 등록. unsubscribe 함수 반환. */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 점 표기법 키로 번역 조회. 누락 시 키 자체 반환 (디버그용).
 *  params 전달 시 사전 문자열 안의 {name} 토큰을 치환. 예: t('members.confirmDelete', { name: 'Alice' }) */
export function t(key: string, params?: Record<string, string | number>): string {
  const parts = key.split('.');
  let v: unknown = dictionaries[current];
  for (const p of parts) {
    if (v && typeof v === 'object' && p in v) {
      v = (v as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  let s = typeof v === 'string' ? v : key;
  if (params) {
    for (const [k, val] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(val));
    }
  }
  return s;
}

/** 모든 [data-i18n*] 요소 일괄 swap. setLang() 시 자동 호출. */
export function applyTranslations(root: ParentNode = document): void {
  // textContent 교체
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  // innerHTML 교체 — 사전에 <strong> 등 마크업 포함 케이스용. 사전은 자체 코드라 XSS 안전.
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    const key = el.dataset.i18nHtml;
    if (key) el.innerHTML = t(key);
  });
  // attribute 교체 — data-i18n-attr-<attrName> 패턴
  root.querySelectorAll<HTMLElement>('*').forEach((el) => {
    for (const name of el.getAttributeNames()) {
      if (!name.startsWith('data-i18n-attr-')) continue;
      const attrName = name.slice('data-i18n-attr-'.length);
      const key = el.getAttribute(name);
      if (key) el.setAttribute(attrName, t(key));
    }
  });
}

/** BaseLayout boot 시 1회 호출. detect → state 동기화 → DOM 이 ko 가 아니면 즉시 swap. */
export function bootI18n(): void {
  if (typeof window === 'undefined') return;
  const lang = detectLang();
  current = lang;
  document.documentElement.lang = lang;
  if (lang !== 'ko') applyTranslations();
}
