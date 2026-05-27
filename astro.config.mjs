import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import obfuscator from 'vite-plugin-javascript-obfuscator';

export default defineConfig({
  site: 'https://1767.kingshot.co.kr',
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
