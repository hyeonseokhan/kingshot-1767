import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

export default defineConfig({
  site: 'https://1767.kingshot.co.kr',
  output: 'static',
  trailingSlash: 'always',
  // 루트 진입은 설문 페이지로 보냄 (캐슬 전투 준비 중 — 설문만 노출).
  // 정적 빌드에서 meta-refresh HTML 을 생성. 재오픈 시 이 항목 제거하고 홈 허브 복구.
  redirects: {
    '/': '/survey/',
  },
  vite: {
    plugins: [
      tailwindcss(),
      obfuscator({
        apply: 'build',
        exclude: [/node_modules/],
        options: {
          compact: true,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          stringArray: true,
          stringArrayEncoding: ['base64'],
          stringArrayThreshold: 1,
          controlFlowFlattening: false,
          deadCodeInjection: false,
          debugProtection: false,
          disableConsoleOutput: false,
          selfDefending: false,
          splitStrings: false,
          unicodeEscapeSequence: false,
          numbersToExpressions: false,
          simplify: true,
        },
      }),
    ],
  },
});
