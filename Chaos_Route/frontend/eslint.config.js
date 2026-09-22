import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      /* `set-state-in-effect` est arrivee avec eslint-plugin-react-hooks 7.1 et
         releve 55 emplacements d'un coup. Ce n'est pas une regression du code :
         c'est une regle neuve qui tombe sur l'existant. La passer en
         avertissement plutot que de la desactiver — l'appel a setState dans un
         effet est parfois un vrai defaut — mais la traiter pour elle-meme, pas
         au detour d'une montee de dependances : 55 corrections melangees a un
         bump, personne ne les relit.
         / New rule in v7.1, 55 hits at once: warn, and give it its own pass. */
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
