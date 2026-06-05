/**
 * 캐슬 전투 페이지 클라이언트 로직 — 정적 시안.
 * - 거점 카드 클릭 → 상세 다이얼로그 활성화 (자유전투 제외)
 * - 다이얼로그 backdrop 클릭으로 닫기
 * - 후보별 voter chip 그리드 인라인 펼치기/접기
 *
 * 현재는 mock 데이터 기반 — Supabase 연동(cb_* 테이블 + castle-battle EF) 은 후속.
 */

function init(): void {
  const dlg = document.getElementById('cb-target-dialog') as HTMLDialogElement | null;
  if (!dlg) return;

  // 거점 카드 클릭 → 상세 다이얼로그
  document.querySelectorAll('.cb-target:not(.is-free)').forEach((card) => {
    card.addEventListener('click', () => {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
  });

  // backdrop 클릭 시 닫기
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });

  // voter 더보기/접기 토글 (각 후보 안에서 인라인 펼침)
  document.querySelectorAll<HTMLElement>('.cb-voters-more').forEach((btn) => {
    const originalText = btn.textContent ?? '+ 더보기';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = btn.closest('.cb-voters');
      if (!wrap) return;
      const expanded = wrap.classList.toggle('is-expanded');
      btn.textContent = expanded ? '접기 ▲' : originalText;
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
