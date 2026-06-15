/**
 * 전역 인증 다이얼로그 클라이언트 로직.
 *
 * 트리거: document 의 'app-open-auth' 커스텀 이벤트.
 * EF: kvk-survey (action: lookup / login) — kingshot_users 통합 인증 기반.
 *
 * 상태 흐름:
 *   id-input → (lookup) → pin-input
 *     - 등록됨(registered:true)  → login → 저장 + 닫기
 *     - 미등록(registered:false) → 안내 메시지 (설문 페이지에서 먼저 등록)
 *
 * 저장 키: 'pnx-sk-auth-v1' (KvK 설문·전략·기타 서비스 공통 통합 인증).
 * 저장 형식: { token, expires_at, record: { kingshot_id, nickname, avatar_url, is_admin } }
 *
 * 신규 등록은 auth-dialog 에서 지원하지 않음 — KvK 설문 페이지에서 진행.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/shared/supabase';

const AUTH_KEY = 'pnx-sk-auth-v1';
const FN_URL = SUPABASE_URL + '/functions/v1/kvk-survey';

interface LookupResp {
  ok: boolean;
  error?: string;
  player?: {
    kingshot_id: string;
    nickname: string;
    avatar_url: string | null;
    city_level: number | null;
  };
  registered?: boolean;
}

interface LoginResp {
  ok: boolean;
  error?: string;
  token?: string;
  expires_at?: string;
  record?: {
    kingshot_id: string;
    nickname: string;
    avatar_url: string | null;
    is_admin: boolean;
    [key: string]: unknown;
  };
}

async function callFn<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()) as T;
}

function mapLookupError(code: string | undefined): string {
  const map: Record<string, string> = {
    player_not_found: '킹샷 ID 를 찾을 수 없습니다. 게임에서 확인 후 다시 시도해 주세요.',
    invalid_id:       '올바른 킹샷 ID 형식이 아닙니다.',
    city_level_too_low: '센터 레벨 26 미만은 설문에 참여할 수 없습니다.',
  };
  return map[code ?? ''] ?? '일시적인 문제가 발생했어요. 잠시 후 다시 시도해 주세요.';
}

function mapLoginError(code: string | undefined): string {
  const map: Record<string, string> = {
    not_registered: 'PIN 이 등록되지 않았습니다. KvK 설문 페이지에서 먼저 등록해 주세요.',
    invalid_pin:    'PIN 이 일치하지 않습니다.',
    invalid_id:     '킹샷 ID 형식 오류입니다.',
    rate_limited:   '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.',
  };
  return map[code ?? ''] ?? '일시적인 문제가 발생했어요. 잠시 후 다시 시도해 주세요.';
}

function init(): void {
  const dlg = document.getElementById('app-auth-dialog') as HTMLDialogElement | null;
  if (!dlg) return;

  const idInput    = document.getElementById('app-auth-id-input')   as HTMLInputElement;
  const idSearchBtn = document.getElementById('app-auth-id-search') as HTMLButtonElement;
  const idStatus   = document.getElementById('app-auth-id-status')  as HTMLElement;
  const pinInput   = document.getElementById('app-auth-pin-input')  as HTMLInputElement;
  const pinBoxes   = document
    .querySelector('.app-auth-pin-boxes')
    ?.querySelectorAll<HTMLElement>('.app-auth-pin-box') ?? null;
  const pinStatus  = document.getElementById('app-auth-pin-status') as HTMLElement;
  const backBtn    = document.getElementById('app-auth-back')       as HTMLButtonElement;
  const closeBtn   = document.getElementById('app-auth-close')      as HTMLButtonElement;
  const stepId     = document.getElementById('app-auth-step-id')    as HTMLElement;
  const stepPin    = document.getElementById('app-auth-step-pin')   as HTMLElement;
  const modeBanner = document.getElementById('app-auth-mode-banner') as HTMLElement;
  const pinHelp    = document.getElementById('app-auth-pin-help')   as HTMLElement;
  const playerName = document.getElementById('app-auth-player-name') as HTMLElement;
  const playerId   = document.getElementById('app-auth-player-id')  as HTMLElement;
  const photo      = document.getElementById('app-auth-photo')      as HTMLImageElement;
  const photoEmpty = document.getElementById('app-auth-photo-empty') as HTMLElement;

  let currentKingshotId: string | null = null;

  function showStep(step: 'id' | 'pin'): void {
    stepId.hidden  = step !== 'id';
    stepPin.hidden = step !== 'pin';
  }

  function setStatus(el: HTMLElement, msg: string, tone: '' | 'err' | 'ok' = ''): void {
    el.textContent = msg;
    el.className = 'app-auth-status' + (tone ? ' is-' + tone : '');
  }

  function syncPinBoxes(): void {
    if (!pinBoxes) return;
    const len = pinInput.value.length;
    pinBoxes.forEach((box, i) => {
      box.classList.toggle('is-filled', i < len);
      box.classList.toggle('is-active', i === len && document.activeElement === pinInput);
      box.textContent = i < len ? '•' : '';
    });
  }

  function reset(): void {
    idInput.value  = '';
    pinInput.value = '';
    setStatus(idStatus, '');
    setStatus(pinStatus, '');
    currentKingshotId = null;
    modeBanner.hidden = true;
    if (pinHelp) pinHelp.textContent = '등록한 PIN 4자리를 입력해 주세요.';
    syncPinBoxes();
    showStep('id');
  }

  function close(): void {
    if (dlg!.open) dlg!.close();
    reset();
  }

  function fillPlayerCard(player: NonNullable<LookupResp['player']>): void {
    playerName.textContent = player.nickname;
    playerId.textContent   = `#${player.kingshot_id}`;
    if (player.avatar_url) {
      photo.src    = player.avatar_url;
      photo.hidden = false;
      photoEmpty.style.display = 'none';
    } else {
      photo.hidden = true;
      photoEmpty.style.display = '';
      photoEmpty.textContent   = (player.nickname || '?').charAt(0);
    }
  }

  async function onSearchId(): Promise<void> {
    const id = idInput.value.trim();
    if (!/^\d{4,15}$/.test(id)) {
      setStatus(idStatus, '4~15자리 숫자로 입력해 주세요.', 'err');
      return;
    }
    idSearchBtn.disabled = true;
    setStatus(idStatus, '');
    try {
      const resp = await callFn<LookupResp>({ action: 'lookup', kingshot_id: id });
      if (!resp.ok || !resp.player) {
        setStatus(idStatus, mapLookupError(resp.error), 'err');
        return;
      }
      if (!resp.registered) {
        setStatus(
          idStatus,
          'PIN 이 등록되지 않은 계정입니다. KvK 설문 페이지에서 먼저 참여해 주세요.',
          'err',
        );
        return;
      }
      currentKingshotId = id;
      fillPlayerCard(resp.player);
      modeBanner.hidden = true;
      showStep('pin');
      setTimeout(() => pinInput.focus(), 50);
    } catch (err) {
      setStatus(idStatus, '네트워크 오류: ' + (err as Error).message, 'err');
    } finally {
      idSearchBtn.disabled = false;
    }
  }

  async function onConfirmPin(): Promise<void> {
    if (!currentKingshotId) return;
    const pin = pinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      setStatus(pinStatus, 'PIN 4자리를 입력해 주세요.', 'err');
      return;
    }
    setStatus(pinStatus, '');
    try {
      const resp = await callFn<LoginResp>({ action: 'login', kingshot_id: currentKingshotId, pin });
      if (!resp.ok || !resp.token || !resp.record) {
        setStatus(pinStatus, mapLoginError(resp.error), 'err');
        return;
      }
      try {
        localStorage.setItem(
          AUTH_KEY,
          JSON.stringify({
            token:      resp.token,
            expires_at: resp.expires_at,
            record: {
              kingshot_id: resp.record.kingshot_id,
              nickname:    resp.record.nickname,
              avatar_url:  resp.record.avatar_url ?? null,
              is_admin:    resp.record.is_admin ?? false,
            },
          }),
        );
      } catch {
        /* private mode 등 — 무시 */
      }
      document.dispatchEvent(new CustomEvent('app-auth-changed'));
      close();
    } catch (err) {
      setStatus(pinStatus, '네트워크 오류: ' + (err as Error).message, 'err');
    }
  }

  // === 이벤트 와이어업 ===
  document.addEventListener('app-open-auth', () => {
    reset();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => idInput.focus(), 50);
  });

  idSearchBtn.addEventListener('click', onSearchId);
  idInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearchId();
  });

  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '').slice(0, 4);
    syncPinBoxes();
    if (pinInput.value.length === 4) onConfirmPin();
  });
  pinInput.addEventListener('focus', syncPinBoxes);
  pinInput.addEventListener('blur', syncPinBoxes);
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onConfirmPin();
  });

  backBtn?.addEventListener('click', () => {
    pinInput.value = '';
    syncPinBoxes();
    setStatus(pinStatus, '');
    showStep('id');
    setTimeout(() => idInput.focus(), 50);
  });

  closeBtn.addEventListener('click', close);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
