/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",
    "./js/**/*.js",
    "./python_app/static/**/*.html",
    "./python_app/static/**/*.js"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        studio: {
          dark: '#09090b',
          panel: '#18181b',
          border: '#27272a',
          accent: '#6366f1'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      }
    },
  },
  plugins: [],
}
