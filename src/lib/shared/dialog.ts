/**
 * 공용 알림/확인 다이얼로그.
 *
 * window.alert / window.confirm 은 OS/브라우저별 디자인 불일치 + 모바일에서 어색함.
 * 본 모듈은 같은 시그니처로 동작하되 사이트 디자인 토큰(var(--bg/--border/--accent)) 사용.
 *
 * 사용:
 *   await appAlert('저장에 실패했습니다.');
 *   if (await appConfirm('22명을 모두 갱신할까요?')) { ... }
 *
 * 마크업/CSS:
 *   - <dialog> + .app-dialog (components.css)
 *   - 매 호출마다 dynamic create + remove → DOM 잔여물 없음
 *   - ESC / backdrop click → cancel (false)
 *   - autofocus 는 OK 버튼에
 */

import { t } from '@/i18n';
import { esc } from './utils';

export interface ConfirmOptions {
  /** 'danger' 면 OK 버튼이 .btn-danger (삭제 같은 비가역 액션). */
  variant?: 'default' | 'danger';
}

export function appAlert(message: string): Promise<void> {
  return open({ message, withCancel: false }).then(() => undefined);
}

export function appConfirm(
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  return open({ message, withCancel: true, variant: options.variant });
}

interface OpenOpts {
  message: string;
  withCancel: boolean;
  variant?: 'default' | 'danger';
}

function open(opts: OpenOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'app-dialog';
    const okClass = opts.variant === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    const okLabel = t('common.confirm');
    const cancelLabel = t('common.cancel');
    dlg.innerHTML =
      '<div class="app-dialog-card">' +
      `<p class="app-dialog-msg">${esc(opts.message)}</p>` +
      '<div class="app-dialog-actions">' +
      (opts.withCancel
        ? `<button class="btn btn-secondary" data-result="false" type="button">${esc(cancelLabel)}</button>`
        : '') +
      `<button class="${okClass}" data-result="true" type="button" autofocus>${esc(okLabel)}</button>` +
      '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    const finish = (result: boolean) => {
      try { dlg.close(); } catch { /* already closed */ }
      dlg.remove();
      resolve(result);
    };
    dlg.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-result]');
      if (btn) { finish(btn.dataset.result === 'true'); return; }
      // backdrop 클릭 — dialog element 자체가 target 이면 외부 영역
      if (e.target === dlg) finish(false);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    dlg.showModal();
  });
}
