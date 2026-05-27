import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

export default defineConfig({
  // Phase 5 (custom domain attach) 전 임시값 — GitHub Pages 의 project site 형식.
  // custom domain 확정 시 site = 'https://<도메인>' 으로 교체 + base 라인 제거.
  site: 'https://hyeonseokhan.github.io',
  base: '/kingshot-1767',
  output: 'static',
  trailingSlash: 'always',
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
