// LangSwitcher + 햄버거 메뉴 안 언어 항목 동작.
// [data-set-lang] 가진 모든 버튼이 자동으로 setLang 트리거 + active 표시 동기화 →
// 헤더 드롭다운과 햄버거 메뉴 항목이 한 곳에서 처리됨.

import { getLang, setLang, onLangChange, type Lang } from '@/i18n';

const TRIGGER_LABEL: Record<Lang, string> = { ko: 'KOR', en: 'ENG' };

function syncAll(lang: Lang): void {
  const trigger = document.getElementById('lang-current');
  if (trigger) trigger.textContent = TRIGGER_LABEL[lang];
  // 헤더 드롭다운 항목 active 표시
  document.querySelectorAll<HTMLElement>('[data-set-lang]').forEach((el) => {
    el.dataset.active = el.dataset.setLang === lang ? 'true' : 'false';
  });
  // 햄버거 메뉴의 native <select> 동기화
  document.querySelectorAll<HTMLSelectElement>('select[data-set-lang-select]').forEach((sel) => {
    if (sel.value !== lang) sel.value = lang;
  });
}

function init(): void {
  const root = document.getElementById('lang-switcher');
  const trigger = document.getElementById('lang-trigger');
  const menu = document.getElementById('lang-menu');

  function setOpen(open: boolean): void {
    if (!root || !trigger || !menu) return;
    root.dataset.open = open ? 'true' : 'false';
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) menu.removeAttribute('hidden');
    else menu.setAttribute('hidden', '');
  }

  syncAll(getLang());

  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = root?.dataset.open === 'true';
    setOpen(!isOpen);
  });

  // [data-set-lang] 가진 모든 요소 — 헤더 드롭다운 항목 + 햄버거 메뉴 항목 모두 포함
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-set-lang]');
    if (btn) {
      const lang = btn.dataset.setLang as Lang | undefined;
      if (lang === 'ko' || lang === 'en') {
        setLang(lang);
        setOpen(false);
      }
      return;
    }
    // 헤더 드롭다운 외부 클릭 시 닫힘
    if (root && root.dataset.open === 'true' && !root.contains(e.target as Node)) {
      setOpen(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root?.dataset.open === 'true') setOpen(false);
  });

  // native <select> change → setLang
  document.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>(
      'select[data-set-lang-select]',
    );
    if (!sel) return;
    const lang = sel.value;
    if (lang === 'ko' || lang === 'en') setLang(lang);
  });

  onLangChange(syncAll);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
